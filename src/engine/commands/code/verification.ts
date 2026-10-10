// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { candidateFingerprint, observeCandidate } from "../../../coding/candidate";
import { parseCommandArgv } from "../../../coding/command-argv";
import {
  captureDelivery,
  deliveryFingerprint,
  prepareDeliveryMount,
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
  recipeSteps,
  resolveVerificationOptions,
  type VerificationOptions,
} from "../../../coding/verification-plan";
import { assertBoundedVerification } from "../../../coding/verification-runner";
import { codingRunContext } from "../../../persistence/coding-run-context";
import type { MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { getErrorMessage } from "../../errors";
import { checkUnattendedGate } from "../../safety-gates";
import { isLocalUngated } from "../../trust-profile";
import { normalizeCodeRunArgs, planVerification, runVerificationCommands } from "./exec";
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
  deliveryManifest?: string,
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
  if (deliveryManifest && workspace.describe().runner?.sync === "patch")
    throw new Error(
      "Delivery verification needs mount sync to exclude undeclared workspace files. Patch sync cannot establish that boundary.",
    );
  const runId = codingRunContext.getStore()?.runId;
  const beforeSpawn = () => {
    const actor = deps.getEntity(eid);
    const current = deps.db.getCodingSession(session.id);
    if (!actor || !current || !canAdoptCodingSession(current, actor) || current.status !== "active")
      throw new Error("Verification stopped: session access is no longer active.");
    if (current.writer && !sameEntityName(current.writer, actor.name))
      throw new Error("Verification stopped: another participant holds the session's write lock.");
    if (deps.hostExecForbidden || deps.getConnectionProtocol?.(eid) === "telnet")
      throw new Error("Verification stopped: host execution is unavailable over telnet.");
    // Background checks cannot borrow a live command's challenge pass or witness window.
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
    : await planVerification(deps, session, workspace, options, candidate);
  const commands = livePlan.commands.map(forCandidate);
  assertBoundedVerification(commands);
  for (const command of commands)
    normalizeAllowedCodeCommand(root, normalizeCodeRunArgs(parseCommandArgv(command)));
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
                  executionLocation: "delivery-materialization",
                  executionRunner: prepared.describe().runner ?? { kind: "host" },
                  observedAt: Date.now(),
                };
              },
            },
            { ...livePlan, workspace: prepared },
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
        );
        const plan = {
          ...snapshotPlan,
          commands: snapshotPlan.commands.map(forCandidate),
          steps: {
            ...snapshotPlan.steps,
            steps: snapshotPlan.steps.steps.map((step) => ({
              ...step,
              command: forCandidate(step.command),
            })),
          },
        };
        const runner = prepared.describe().runner;
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
            candidateEvidence: async () => {
              const evidence: Record<string, unknown> = {
                candidateId: captured.id,
                tree: snapshot.candidate.tree,
                candidateFingerprint: snapshot.candidate.fingerprint,
                executionTarget: "local",
                executionLocation: "candidate-materialization",
                executionRunner: runner
                  ? { kind: "container", image: runner.image, sync: runner.sync }
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
