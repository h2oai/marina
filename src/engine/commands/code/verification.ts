// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from "node:fs";
import { candidateFingerprint, observeCandidate } from "../../../coding/candidate";
import { LocalWorkspace, normalizeAllowedCodeCommand } from "../../../coding/local-workspace";
import {
  assessCodingVerification,
  codingRunMetadata,
  codingVerificationReadiness,
  codingVerificationUnchanged,
} from "../../../coding/task-run";
import { assertBoundedVerification } from "../../../coding/verification-runner";
import { codingRunContext } from "../../../persistence/coding-run-context";
import type { MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { getErrorMessage } from "../../errors";
import { checkUnattendedGate } from "../../safety-gates";
import { isLocalUngated } from "../../trust-profile";
import { normalizeCodeRunArgs, runVerificationCommands, verificationCommands } from "./exec";
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
  dependencies?: "bun",
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
  const runId = codingRunContext.getStore()?.runId;
  const beforeSpawn = () => {
    const actor = deps.getEntity(eid);
    const current = deps.db.getCodingSession(session.id);
    if (!actor || !current || !canAdoptCodingSession(current, actor) || current.status !== "active")
      throw new Error("Verification stopped: session access is no longer active.");
    if (current.writer && !sameEntityName(current.writer, actor.name))
      throw new Error("Verification stopped: another participant holds the session's write lock.");
    if (deps.getConnectionProtocol?.(eid) === "telnet")
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
  const commands = (await verificationCommands(deps, session)).map((command) =>
    candidate && command === "git diff --check" ? "git diff --cached --check" : command,
  );
  assertBoundedVerification(commands);
  for (const command of commands)
    normalizeAllowedCodeCommand(root, normalizeCodeRunArgs(command.split(/\s+/).filter(Boolean)));
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
        const prepared = new LocalWorkspace(snapshot.directory);
        return await runVerificationCommands(
          backgroundContext,
          eid,
          entity,
          deps,
          session,
          commands,
          "Snapshot verification",
          {
            receiptId,
            workspace: prepared,
            beforeSpawn,
            candidateId: captured.id,
            prepare:
              dependencies === "bun"
                ? () => prepared.prepareCandidateDependencies(beforeSpawn)
                : undefined,
            candidateEvidence: async () => {
              const evidence: Record<string, unknown> = {
                candidateId: captured.id,
                tree: snapshot.candidate.tree,
                candidateFingerprint: snapshot.candidate.fingerprint,
                executionTarget: "local",
                executionLocation: "candidate-materialization",
                recipeType: commands.every((command) => command === "git diff --cached --check")
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
                  const changed = await prepared.captureCandidate(root, beforeSpawn);
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
        `Background verification ${completed.status}: ${completed.id}${typeof meta.error === "string" ? `\n${meta.error}` : ""}`,
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
    `Verification started: ${receipt.id}\nContinue participating while checks run. Inspect with code show ${receipt.id}.`,
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
