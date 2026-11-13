// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  candidateFingerprint,
  materializeGitCommit,
  observeCandidate,
} from "../../../coding/candidate";
import { retireCandidateRefs } from "../../../coding/candidate-retention";
import { parseCommandArgv } from "../../../coding/command-argv";
import {
  captureDelivery,
  type DeliveryManifestSource,
  deliveryFingerprint,
  prepareDeliveryMount,
  type RequirementChecks,
  readDeliveryManifest,
} from "../../../coding/delivery";
import { attributeFailure, type FailureDigest } from "../../../coding/failure-digest";
import { hostGitArgv, hostGitEnv } from "../../../coding/host-git";
import { LocalWorkspace, normalizeAllowedCodeCommand } from "../../../coding/local-workspace";
import {
  assessCodingVerification,
  codingRunMetadata,
  codingVerificationReadiness,
  codingVerificationUnchanged,
} from "../../../coding/task-run";
import {
  classifyStep,
  executePreparation,
  recipeSteps,
  resolveVerificationOptions,
  type VerificationOptions,
  type VerificationStep,
} from "../../../coding/verification-plan";
import { assertBoundedVerification } from "../../../coding/verification-runner";
import { codingRunContext } from "../../../persistence/coding-run-context";
import type { CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { getErrorMessage, tryLog } from "../../errors";
import { Logger } from "../../logger";
import { checkUnattendedGate } from "../../safety-gates";
import { isLocalUngated } from "../../trust-profile";
import {
  type BaseRerun,
  executeWorkspaceCommand,
  normalizeCodeRunArgs,
  planVerification,
  runVerificationCommands,
  type VerificationRun,
} from "./exec";
import { applySessionRunner } from "./runner";
import {
  type CodeDeps,
  canAdoptCodingSession,
  parseJsonObject,
  resolveSession,
  sameEntityName,
  sendCode,
} from "./shared";
import { workspaceForSession } from "./workspace";

const logger = new Logger();

/** Opt-in admission receipt; ordinary verify retains its synchronous completion contract. */
export async function startVerification(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  candidate = false,
  options: VerificationOptions = resolveVerificationOptions(),
  deliveryManifest?: DeliveryManifestSource,
  candidateOptions: {
    /** Run the repository's own gates (`gates:repository`). */
    gates?: boolean;
    /** Requirement checks to run in the snapshot before the gates, with their mapping. */
    requirementChecks?: RequirementChecks;
  } = {},
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  if (!deps.verificationRunner)
    throw new Error("Background verification is unavailable in this runtime.");
  if (session.execution_target !== "local")
    throw new Error(
      "Background verification currently requires a local workspace. Use code verify for sandbox checks.",
    );
  const workspace = workspaceForSession(deps, session);
  if (!workspace.runAllowlisted)
    throw new Error("This workspace does not support background verification.");
  if (candidate && !workspace.captureCandidate)
    throw new Error("This runtime does not support local Git candidate materialization.");
  const root = realpathSync(workspace.displayRoot());
  const described = workspace.describe().runner;
  if (deliveryManifest && described?.kind === "container" && described.sync === "patch")
    throw new Error(
      "Delivery verification needs mount sync to exclude undeclared workspace files. Patch sync cannot establish that boundary.",
    );
  const runId = codingRunContext.getStore()?.runId;
  const activeRun = runId ? deps.db.getCodingArtifact(runId) : undefined;
  // A task that requires the repository's gates gets them from plain `code verify candidate`.
  const gates =
    candidate &&
    (candidateOptions.gates === true ||
      (activeRun?.kind === "task_run" &&
        codingRunMetadata(activeRun).verificationGates === "repository"));
  if (candidateOptions.requirementChecks && !candidate)
    throw new Error("Requirement checks belong to candidate verification.");
  if (gates)
    // The gates: type-check where configured, relevant tests then the full suite, and
    // dependencies prepared in the snapshot unless the coder named a manager.
    options = {
      ...options,
      scope: options.scope === "full" ? "full" : "changed+full",
      typecheck: "auto",
      dependencies:
        options.dependencies === "check" || options.dependencies === "none"
          ? "auto"
          : options.dependencies,
    };
  const requirementChecks = candidateOptions.requirementChecks;
  const beforeSpawn = () => {
    const actor = deps.getEntity(eid);
    const current = deps.db.getCodingSession(session.id);
    if (!actor || !current || !canAdoptCodingSession(current, actor) || current.status !== "active")
      throw new Error("Verification stopped: session access is no longer active.");
    if (current.writer && !sameEntityName(current.writer, actor.name))
      throw new Error("Verification stopped: another participant holds the session's write lock.");
    if (deps.hostExecForbidden || deps.getConnectionProtocol?.(eid) === "telnet")
      throw new Error("Verification stopped: host execution is unavailable over telnet.");
    // Background checks cannot borrow a live command's challenge pass.
    if (!isLocalUngated() && !checkUnattendedGate(deps.db, eid, "code.exec").ok)
      throw new Error(
        "Background verification requires unattended code.exec competence. Use code verify for supervised checks.",
      );
    if (
      current.execution_target !== "local" ||
      current.workspace_root !== session.workspace_root ||
      current.worktree_path !== session.worktree_path ||
      realpathSync(current.worktree_path ?? current.workspace_root) !== root
    )
      throw new Error("Verification stopped: workspace or execution target changed.");
    const active = deps.db.listCodingRuns({ sessionId: session.id, status: "active", limit: 1 })[0];
    if (active?.id !== runId)
      throw new Error("Verification stopped: the session's coding attempt changed.");
  };
  beforeSpawn();
  const forCandidate = (command: string) =>
    candidate && command === "git diff --check" ? "git diff --cached --check" : command;
  // The live plan validates admission; a candidate is re-planned on its snapshot.
  const delivery = deliveryManifest
    ? await readDeliveryManifest(workspace, deliveryManifest)
    : undefined;
  const livePlan = delivery
    ? { commands: delivery.manifest.checks, steps: recipeSteps(delivery.manifest.checks), options }
    : await planVerification(deps, session, workspace, options, candidate, undefined, gates);
  if (gates && (!("gateTests" in livePlan) || !livePlan.gateTests))
    throw new Error(
      "Repository gates need a detected test runner (package.json test script, pytest, cargo, go, maven or gradle); none was found in this workspace.",
    );
  const commands = [...(requirementChecks?.checks ?? []), ...livePlan.commands].map(forCandidate);
  assertBoundedVerification(commands);
  // A planned pytest fallback is admitted on the same allowlist before anything runs.
  // Under the sandbox runner every check runs in the sandbox (any command, like
  // `code run`); the argv must still parse.
  const sandboxed = workspace.runPolicy().sandbox !== undefined;
  for (const command of [...commands, ...(livePlan.fallback?.commands ?? [])]) {
    const argv = normalizeCodeRunArgs(parseCommandArgv(command));
    if (!sandboxed) normalizeAllowedCodeCommand(root, argv);
  }
  beforeSpawn();
  // Background results are durable even if the caller disconnects or loses access. Never
  // forward private evidence to a caller whose bound-agent membership was revoked meanwhile.
  const canNotify = () => {
    const current = deps.db.getCodingSession(session.id);
    const actor = deps.getEntity(eid);
    return !!current && !!actor && canAdoptCodingSession(current, actor);
  };
  const notifyParticipants = (text: string, code: Parameters<typeof sendCode>[3]) => {
    if (canNotify()) sendCode(ctx, eid, text, code);
    const run = runId ? deps.db.getCodingArtifact(runId) : undefined;
    if (!run) return;
    const meta = codingRunMetadata(run);
    const owner = deps.findEntityExact?.(meta.ownerName) ?? deps.getEntity(meta.ownerKey);
    const current = deps.db.getCodingSession(session.id);
    if (
      owner &&
      owner.id !== eid &&
      current &&
      canAdoptCodingSession(current, owner) &&
      sameEntityName(owner.name, meta.ownerName)
    )
      deps.notify?.(owner.id, text, { code });
  };
  const backgroundContext: RoomContext = {
    ...ctx,
    send: (...args) => {
      if (canNotify()) ctx.send(...args);
    },
  };
  const receipt = deps.verificationRunner.start({
    sessionId: session.id,
    actor: entity.name,
    root,
    commands,
    execute: async (receiptId) => {
      if (deliveryManifest && delivery) {
        const snapshot = await captureDelivery(workspace, deliveryManifest, beforeSpawn);
        try {
          if (snapshot.evidence.manifestSha256 !== delivery.sha256)
            throw new Error("Delivery manifest changed after admission; inspect it and retry.");
          if (workspace.describe().runner)
            await prepareDeliveryMount(snapshot.directory, beforeSpawn);
          const prepared = applySessionRunner(
            new LocalWorkspace(snapshot.directory),
            deps.db,
            session,
          );
          prepared.setHostExecForbidden?.(deps.hostExecForbidden === true);
          // Detect dependencies from the captured files under the configured runner. Keep
          // the manifest's commands and indexes intact for requirement coverage.
          const snapshotPlan = await planVerification(
            deps,
            session,
            prepared,
            options,
            true,
            snapshot.manifest.files,
          );
          return await runVerificationCommands(
            backgroundContext,
            eid,
            entity,
            deps,
            session,
            commands,
            "Delivery verification",
            {
              receiptId,
              workspace: prepared,
              beforeSpawn,
              candidateEvidence: async () => {
                beforeSpawn();
                const checkedFingerprint = await deliveryFingerprint(
                  prepared,
                  snapshot.manifest.files,
                );
                return {
                  delivery: { ...snapshot.evidence, checkedFingerprint },
                  requirements: snapshot.manifest.requirements ?? [],
                  executionLocation: "delivery-materialization",
                  executionRunner: prepared.describe().runner ?? { kind: "host" },
                  observedAt: Date.now(),
                };
              },
            },
            {
              ...livePlan,
              // The manifest's checks run as written: no runner switch.
              preparation: snapshotPlan.preparation && {
                ...snapshotPlan.preparation,
                fallback: undefined,
              },
              workspace: prepared,
            },
          );
        } finally {
          await snapshot.dispose();
        }
      }
      if (!candidate)
        return runVerificationCommands(
          backgroundContext,
          eid,
          entity,
          deps,
          session,
          commands,
          "Verification",
          {
            receiptId,
            workspace,
            beforeSpawn,
          },
          livePlan,
        );
      let base: ReturnType<typeof baseRerun> | undefined;
      // Retire candidate refs nobody needs before pinning another, so retained snapshots
      // never reach the capture limit and stop verification (src/coding/candidate-retention.ts).
      tryLog(logger, "code", "candidate ref retirement failed", () => {
        const { retired } = retireCandidateRefs(root, deps.db);
        if (retired.length)
          deps.db.createCodingEvent({
            sessionId: session.id,
            actor: entity.name,
            kind: "candidate_refs_retired",
            payload: { count: retired.length, refs: retired },
          });
      });
      const snapshot = await workspace.captureCandidate!(undefined, beforeSpawn);
      try {
        const captured = deps.db.createCodingArtifact({
          sessionId: session.id,
          kind: "candidate",
          status: "captured",
          title: `Candidate ${snapshot.candidate.tree.slice(0, 12)}`,
          contentText: [
            `Tree: ${snapshot.candidate.tree}`,
            `Base: ${snapshot.candidate.baseCommit ?? "unborn"}`,
            `Repository: ${snapshot.candidate.repository}`,
            `Retained ref: ${snapshot.candidate.ref}`,
            `Retention commit: ${snapshot.candidate.commit}`,
            `Source fingerprint: ${snapshot.candidate.fingerprint}`,
            "Immutable included source. Ignored dependencies and external inputs are excluded; this is not a security sandbox.",
          ].join("\n"),
          metadata: snapshot.candidate,
          createdBy: entity.name,
        });
        beforeSpawn();
        // The snapshot runs where the session runs: the same container runner
        // (same allowlist, approver and gates) when one is set, never a silent
        // host fallback.
        const prepared = applySessionRunner(
          new LocalWorkspace(snapshot.directory),
          deps.db,
          session,
          process.env,
          { scratchTmp: runScratchTmp(snapshot.directory) },
        );
        prepared.setHostExecForbidden?.(deps.hostExecForbidden === true);
        const snapshotPlan = await planVerification(
          deps,
          session,
          prepared,
          options,
          true,
          livePlan.touched,
          gates,
        );
        // Requirement checks run first, so their indexes are the requirements' step indexes.
        const required = requirementChecks
          ? recipeSteps(requirementChecks.checks).steps.map((step) => ({
              ...step,
              requirement: true,
            }))
          : [];
        const withRequired = (steps: typeof snapshotPlan.steps) => ({
          ...steps,
          testsPlanned: steps.testsPlanned || required.some((step) => step.role === "tests"),
          steps: [...required, ...steps.steps].map((step) => ({
            ...step,
            command: forCandidate(step.command),
          })),
        });
        // A sandboxed snapshot has no network and may not install on the host: its JavaScript
        // dependencies are the workspace's own installed trees, copied in as files.
        if (prepared.describe().runner?.kind === "sandbox")
          for (const preparation of [
            ...(snapshotPlan.preparation ? [snapshotPlan.preparation] : []),
            ...(snapshotPlan.morePreparation ?? []),
          ])
            if (preparation.language === "javascript")
              preparation.copyDependencies = {
                from: [root, session.workspace_root],
                to: snapshot.directory,
              };
        const plan = {
          ...snapshotPlan,
          commands: [...(requirementChecks?.checks ?? []), ...snapshotPlan.commands].map(
            forCandidate,
          ),
          steps: withRequired(snapshotPlan.steps),
          ...(snapshotPlan.fallback
            ? {
                fallback: {
                  ...snapshotPlan.fallback,
                  commands: [
                    ...(requirementChecks?.checks ?? []),
                    ...snapshotPlan.fallback.commands,
                  ],
                  steps: withRequired(snapshotPlan.fallback.steps),
                },
              }
            : {}),
        };
        const runner = prepared.describe().runner;
        // A failed gate runs once more on the task's base commit (its start, without the
        // change): the base is checked out and prepared once, on the first failure.
        const baseCommit =
          (activeRun?.kind === "task_run"
            ? codingRunMetadata(activeRun).initialWorkspace?.head
            : undefined) ?? snapshot.candidate.baseCommit;
        base = baseRerun({
          deps,
          entity,
          session,
          repository: root,
          baseCommit,
          candidateTree: snapshot.candidate.tree,
          plan,
          beforeSpawn,
        });
        return await runVerificationCommands(
          backgroundContext,
          eid,
          entity,
          deps,
          session,
          plan.commands,
          "Snapshot verification",
          {
            receiptId,
            workspace: prepared,
            beforeSpawn,
            candidateId: captured.id,
            ...(gates ? { onGateFailure: base.rerun } : {}),
            candidateEvidence: async () => {
              const evidence: Record<string, unknown> = {
                ...(gates ? { gates: "repository" } : {}),
                ...(gates || requirementChecks
                  ? { requirements: requirementChecks?.requirements ?? [] }
                  : {}),
                ...(requirementChecks ? { requirementChecks: requirementChecks.checks } : {}),
                candidateId: captured.id,
                tree: snapshot.candidate.tree,
                candidateFingerprint: snapshot.candidate.fingerprint,
                executionTarget: "local",
                executionLocation: "candidate-materialization",
                executionRunner: runner
                  ? runner.kind === "container"
                    ? { kind: "container", image: runner.image, sync: runner.sync }
                    : { kind: "sandbox", engine: runner.engine }
                  : { kind: "host" },
                recipeType: plan.commands.every(
                  (command) => command === "git diff --cached --check",
                )
                  ? "whitespace-only"
                  : "configured-checks",
                runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
                observedAt: Date.now(),
                freshness: "unavailable",
              };
              try {
                beforeSpawn();
                const checked = await candidateFingerprint(
                  snapshot.directory,
                  snapshot.candidate.baseCommit,
                );
                evidence.materializedFingerprint = checked;
                if (checked !== snapshot.candidate.fingerprint) {
                  // Host and container local workspaces both capture on the host.
                  const changed = await prepared.captureCandidate!(root, beforeSpawn);
                  try {
                    const successor = deps.db.createCodingArtifact({
                      sessionId: session.id,
                      kind: "candidate",
                      status: "captured",
                      title: "Source changed by verification; reverify before using its evidence",
                      contentText:
                        "Checks changed the isolated source. The original working tree was not updated.",
                      metadata: { ...changed.candidate, supersedesCandidateId: captured.id },
                      createdBy: entity.name,
                    });
                    evidence.successorCandidateId = successor.id;
                  } finally {
                    await changed.dispose();
                  }
                  evidence.freshness = "stale";
                } else {
                  evidence.workspaceFingerprint = await observeCandidate(snapshot.candidate);
                  evidence.freshness =
                    evidence.workspaceFingerprint === checked ? "current" : "stale";
                }
              } catch (error) {
                evidence.freshnessReason = getErrorMessage(error);
              }
              return evidence;
            },
          },
          plan,
        );
      } finally {
        await base?.dispose();
        await snapshot.dispose();
      }
    },
    notify: async (completed) => {
      const run = runId ? deps.db.getCodingArtifact(runId) : undefined;
      const assessment = run
        ? await assessCodingVerification(
            deps.db,
            run,
            canNotify() && deps.getConnectionProtocol?.(eid) !== "telnet",
          )
        : undefined;
      const fresh =
        run && assessment && codingVerificationUnchanged(deps.db, run, assessment.verificationId);
      const state = fresh ? { ...codingRunMetadata(run), ...assessment } : undefined;
      const meta = parseJsonObject(completed.metadata_json);
      const gateReport = gates ? repositoryGateReport(deps.db, meta) : undefined;
      notifyParticipants(
        [
          `Background verification ${completed.status}: ${completed.id}`,
          ...(typeof meta.error === "string" ? [meta.error] : []),
          ...(state?.verification
            ? [`${candidate ? "Candidate verification" : "Verification"}: ${state.verification}.`]
            : []),
          ...(state?.verificationReason ? [state.verificationReason] : []),
          `Inspect the completed receipt: code show ${completed.id} (marina_code action=show, artifactId=${completed.id}).${candidate ? " Any later source or test edit requires fresh candidate verification before submission." : ""}`,
        ].join("\n"),
        {
          event: "verification_finished",
          metadata: {
            runId,
            ...(gateReport ? { gates: gateReport } : {}),
            ...state,
            verificationReadiness: fresh
              ? codingVerificationReadiness(deps.db, run, state)
              : undefined,
          },
          artifactId: completed.id,
          artifactKind: completed.kind,
          sessionId: session.id,
          status: completed.status,
          type: "verification",
          commands: [
            `code show ${completed.id}`,
            ...(typeof meta.resultArtifactId === "string"
              ? [`code show ${meta.resultArtifactId}`]
              : []),
          ],
        },
      );
    },
  });
  notifyParticipants(
    `Verification started: ${receipt.id}\nContinue participating while checks run. Inspect with code show ${receipt.id} (marina_code action=show, artifactId=${receipt.id}; this is not a file path).`,
    {
      event: "verification_started",
      metadata: {
        runId,
        verificationReadiness: "running",
        verificationRequirement: runId
          ? codingRunMetadata(deps.db.getCodingArtifact(runId)!).verificationRequirement
          : undefined,
      },
      artifactId: receipt.id,
      artifactKind: receipt.kind,
      sessionId: session.id,
      status: "running",
      type: "verification",
      commands: [`code show ${receipt.id}`],
    },
  );
}

/**
 * Re-run failed repository gates on the task's base commit, bounded to one run per failing
 * step. The base is materialized and its dependencies prepared under the session's runner
 * the first time a gate fails, and disposed with the snapshot.
 */
function baseRerun(input: {
  deps: CodeDeps & { db: MarinaDB };
  entity: Entity;
  session: CodingSessionRow;
  repository: string;
  baseCommit: string | null | undefined;
  /** The candidate snapshot's tree, compared with the base for dependency changes. */
  candidateTree: string;
  plan: VerificationRun;
  beforeSpawn: () => void;
}) {
  let manifests: string[] | undefined;
  let ready:
    | Promise<{
        workspace: ReturnType<typeof applySessionRunner>;
        dispose: () => Promise<void>;
        wrapTests?: string;
        unready?: string;
      }>
    | undefined;
  const open = async () => {
    const checkout = await materializeGitCommit(input.repository, input.baseCommit!);
    const workspace = applySessionRunner(
      new LocalWorkspace(checkout.directory),
      input.deps.db,
      input.session,
      process.env,
      { scratchTmp: runScratchTmp(checkout.directory) },
    );
    workspace.setHostExecForbidden?.(input.deps.hostExecForbidden === true);
    let wrapTests: string | undefined;
    for (const preparation of [
      ...(input.plan.preparation ? [input.plan.preparation] : []),
      ...(input.plan.morePreparation ?? []),
    ]) {
      const result = await executePreparation(
        preparation.copyDependencies
          ? {
              ...preparation,
              copyDependencies: { ...preparation.copyDependencies, to: checkout.directory },
            }
          : preparation,
        workspace,
        input.beforeSpawn,
      );
      if (result.status === "not_run" || result.status === "error")
        return { workspace, dispose: checkout.dispose, unready: result.reason };
      wrapTests ??= result.wrapTests;
    }
    return { workspace, dispose: checkout.dispose, wrapTests };
  };
  return {
    rerun: async (
      step: VerificationStep,
      command: string[],
      change: FailureDigest | undefined,
    ): Promise<BaseRerun> => {
      const baseCommit = input.baseCommit ?? "";
      const inconclusive = (why: string): BaseRerun => ({
        baseCommit,
        attribution: attributeFailure({ change, baseUnavailable: why }),
      });
      if (!input.baseCommit) return inconclusive("the task has no base commit");
      // A base run uses the dependencies prepared for it, which (copied in a sandbox, or a
      // shared cache) can be the change's: when dependency manifests differ, it proves nothing.
      manifests ??= changedDependencyManifests(
        input.repository,
        input.baseCommit,
        input.candidateTree,
      );
      if (manifests.length)
        return inconclusive(
          `dependency manifests or lockfiles differ between the base and the change (${manifests.slice(0, 5).join(", ")}), so the base would not run with its own dependencies`,
        );
      ready ??= open();
      const base = await ready;
      if (base.unready) return inconclusive(`the base could not be prepared: ${base.unready}`);
      const runOnBase = async (argv: string[]) => {
        const stored = await executeWorkspaceCommand(
          input.entity,
          input.deps,
          input.session,
          argv,
          { workspace: base.workspace, beforeSpawn: input.beforeSpawn },
          step.timeoutMs,
        );
        const outcome = classifyStep(step, stored.result);
        return {
          stored,
          outcome,
          run: { passed: outcome.outcome === "passed", digest: stored.result.digest },
        };
      };
      const first = await runOnBase(command);
      // A base that did not run its tests (setup error, nothing collected) proves nothing.
      if (first.outcome.outcome !== "passed" && first.outcome.outcome !== "failed")
        return {
          ...inconclusive(`the step did not run on the base: ${first.outcome.reason}`),
          outcome: first.outcome.outcome,
          artifactIds: [first.stored.artifact.id],
        };
      let attribution = attributeFailure({ change, base: first.run });
      const artifactIds = [first.stored.artifact.id];
      // Every failure matches the base once: confirm on a second base run before excusing it.
      if (attribution.kind === "inconclusive" && attribution.reason.includes("not confirmed")) {
        const again = confirmationCommand(command, change, first.stored.result.durationMs);
        if (again) {
          const second = await runOnBase(again);
          artifactIds.push(second.stored.artifact.id);
          attribution = attributeFailure({ change, base: first.run, again: second.run });
        } else
          attribution = {
            kind: "inconclusive",
            reason:
              "the base failure was not confirmed: the step is too slow to run twice and its failing tests cannot be run alone",
          };
      }
      return {
        baseCommit,
        attribution,
        outcome: first.outcome.outcome,
        ...(first.stored.result.digest
          ? { identities: first.stored.result.digest.identities }
          : {}),
        artifactIds,
      };
    },
    dispose: async () => {
      // allow-empty-catch: a base that failed to open already removed its own directory
      if (ready) await (await ready.catch(() => undefined))?.dispose();
    },
  };
}

/**
 * A fresh scratch directory beside a snapshot or base checkout (removed with it), bound at
 * the sandbox's /tmp for a gate run: a full suite can outgrow the sandbox's RAM tmpfs, which
 * stays for interactive session commands. Unused on the host and in containers.
 */
function runScratchTmp(checkout: string): string {
  const scratch = join(dirname(checkout), "tmp");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  return scratch;
}

/** Files that decide what a project's dependencies are. */
const DEPENDENCY_FILES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  ".pnpmfile.cjs",
  ".npmrc",
  "bunfig.toml",
  ".yarnrc",
  ".yarnrc.yml",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "setup.py",
  "setup.cfg",
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  "Gemfile",
  "Gemfile.lock",
  "Cargo.toml",
  "Cargo.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.lockfile",
]);

/**
 * Dependency manifests and lockfiles that differ between the base commit and the candidate
 * tree. Unknown (git cannot compare) counts as differing.
 */
export function changedDependencyManifests(
  repository: string,
  baseCommit: string,
  candidateTree: string,
): string[] {
  const diff = Bun.spawnSync(
    hostGitArgv(
      ["git", "diff", "--name-only", "-z", "--no-renames", baseCommit, candidateTree, "--"],
      repository,
    ),
    { cwd: repository, env: hostGitEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  if (diff.exitCode !== 0) return ["(the base and the change could not be compared)"];
  return diff.stdout
    .toString()
    .split("\0")
    .filter(
      (path) =>
        !!path &&
        (DEPENDENCY_FILES.has(path.split("/").at(-1)!) ||
          /(^|\/)requirements[^/]*\.txt$/.test(path)),
    );
}

/** A base step longer than this is not repeated whole to confirm a failure. */
const CONFIRM_FULL_RERUN_MS = 5 * 60 * 1000;

/**
 * The command that confirms a base failure: only the failing tests where the runner can run
 * them alone (`bun test <files>`, `pytest <node ids>`), else the whole step when it is cheap.
 */
export function confirmationCommand(
  command: readonly string[],
  change: FailureDigest | undefined,
  durationMs: number,
): string[] | undefined {
  const identities = change?.identities ?? [];
  const files = [...new Set(identities.map((identity) => identity.file))];
  if (identities.length && files.every((file) => !!file)) {
    if (command[0] === "bun" && command[1] === "test")
      return ["bun", "test", ...(files as string[]).map((file) => `./${file}`)];
    const pytest = command.indexOf("pytest");
    if (pytest > 0 && command[pytest - 1] === "-m")
      return [
        ...command.slice(0, pytest + 1),
        ...identities.map((identity) =>
          identity.name.startsWith(`${identity.file}::`)
            ? identity.name.split(" ")[0]!
            : identity.file!,
        ),
      ];
  }
  return durationMs <= CONFIRM_FULL_RERUN_MS ? [...command] : undefined;
}

/**
 * What a repository-gate verification found, from its stored result: the verdict, whether
 * the snapshot still matches the workspace, and each gate. Sent with `verification_finished`
 * so a client that ran the gates outside a task attempt (a native one-shot) can report them.
 */
export function repositoryGateReport(db: MarinaDB, receipt: Record<string, unknown>) {
  const result =
    typeof receipt.resultArtifactId === "string"
      ? db.getCodingArtifact(receipt.resultArtifactId)
      : undefined;
  if (!result)
    return {
      outcome: "error",
      reason:
        typeof receipt.outcomeReason === "string"
          ? receipt.outcomeReason
          : "The verification left no result.",
    };
  const evidence = parseJsonObject(result.metadata_json);
  const steps = Array.isArray(evidence.steps) ? evidence.steps : [];
  return {
    outcome: typeof evidence.outcome === "string" ? evidence.outcome : result.status,
    reason: typeof evidence.outcomeReason === "string" ? evidence.outcomeReason : undefined,
    gates: evidence.gates === "repository",
    freshness: typeof evidence.freshness === "string" ? evidence.freshness : "unavailable",
    workspace: typeof receipt.workspace === "string" ? receipt.workspace : undefined,
    resultId: result.id,
    ...(evidence.preexistingOnly === true ? { preexistingOnly: true } : {}),
    ...(typeof evidence.candidateFingerprint === "string"
      ? { candidateFingerprint: evidence.candidateFingerprint }
      : {}),
    ...(() => {
      const row =
        typeof evidence.candidateId === "string"
          ? db.getCodingArtifact(evidence.candidateId)
          : undefined;
      const base = row ? parseJsonObject(row.metadata_json).baseCommit : undefined;
      return base === null || typeof base === "string" ? { baseCommit: base } : {};
    })(),
    steps: steps.map((step: Record<string, unknown>) => ({
      command: Array.isArray(step.command) ? step.command.join(" ") : String(step.command ?? ""),
      role: step.role,
      outcome: step.outcome,
      reason: step.reason,
      ...(step.preexisting === true ? { preexisting: true } : {}),
      ...(step.digest && typeof step.digest === "object" ? { digest: step.digest } : {}),
    })),
  };
}
