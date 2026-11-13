// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import {
  candidateFingerprint,
  materializeGitCommit,
  observeCandidate,
} from "../../../coding/candidate";
import { parseCommandArgv } from "../../../coding/command-argv";
import {
  captureDelivery,
  type DeliveryManifestSource,
  deliveryFingerprint,
  prepareDeliveryMount,
  type RequirementChecks,
  readDeliveryManifest,
} from "../../../coding/delivery";
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
import { getErrorMessage } from "../../errors";
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
  plan: VerificationRun;
  beforeSpawn: () => void;
}) {
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
    );
    workspace.setHostExecForbidden?.(input.deps.hostExecForbidden === true);
    let wrapTests: string | undefined;
    for (const preparation of [
      ...(input.plan.preparation ? [input.plan.preparation] : []),
      ...(input.plan.morePreparation ?? []),
    ]) {
      const result = await executePreparation(preparation, workspace, input.beforeSpawn);
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
      failing?: readonly string[],
    ): Promise<BaseRerun | undefined> => {
      if (!input.baseCommit) return undefined;
      ready ??= open();
      const base = await ready;
      if (base.unready) return undefined;
      const stored = await executeWorkspaceCommand(
        input.entity,
        input.deps,
        input.session,
        command,
        { workspace: base.workspace, beforeSpawn: input.beforeSpawn },
        step.timeoutMs,
      );
      const outcome = classifyStep(step, stored.result);
      const baseFailures = stored.result.digest?.failures.map((failure) => failure.name);
      // Pre-existing only when nothing new fails: every test failing with the change (when
      // the runner names them) also fails on the base. A new failing test is the change's.
      const onlyOld =
        !failing?.length || !baseFailures || failing.every((name) => baseFailures.includes(name));
      return {
        preexisting: outcome.outcome === "failed" && onlyOld,
        baseCommit: input.baseCommit,
        outcome: outcome.outcome,
        reason: outcome.reason,
        artifactId: stored.artifact.id,
        ...(stored.result.digest
          ? { failures: stored.result.digest.failures.map((failure) => failure.name) }
          : {}),
      };
    },
    dispose: async () => {
      // allow-empty-catch: a base that failed to open already removed its own directory
      if (ready) await (await ready.catch(() => undefined))?.dispose();
    },
  };
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
