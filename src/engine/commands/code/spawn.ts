// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { dim, error as fmtError, header, separator, success } from "../../../net/ansi";
import type { CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { checkGateForExecution, recordGateExecution } from "../../safety-gates";
import { resolveKindArtifact } from "./artifacts";
import {
  bindSpawnedAgentEntity,
  type CodeDeps,
  getCodeProfile,
  getSessionModelTarget,
  modelTargetForAgentSpawn,
  parseJsonObject,
  parseSpawnRunArgs,
  refuseTelnetDispatch,
  resolveSession,
  sendCode,
  uniqueSpawnAgentName,
  updateCodeContext,
} from "./shared";

export async function spawnRequest(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): Promise<void> {
  // Agentic-spawn surface is telnet-denied by construction — symmetric with
  // doCode/crewPlan/assignCode. Defense-in-depth: keeps the spawn dispatch off
  // the telnet transport even if a future change grants it code.exec.
  if (refuseTelnetDispatch(ctx, eid, deps)) return;
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const action = args[0]?.toLowerCase();
  if (!action || action === "list") {
    listSpawnRequests(ctx, eid, deps.db, session);
    return;
  }
  if (action === "run" || action === "approved" || action === "launch") {
    await runApprovedSpawnRequest(ctx, eid, entity, deps, session, args.slice(1));
    return;
  }

  const role = action;
  const goal = args.slice(1).join(" ").trim();
  if (!role || !goal) {
    ctx.send(eid, "Usage: code spawn <role> <goal> | code spawn run <spawn_request>");
    return;
  }
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "spawn_request",
    title: `Spawn request: ${role}`,
    status: "pending",
    contentText: `Role: ${role}\nGoal: ${goal}\n\nThis is a supervised spawn request. Approve it, then launch locally with code spawn run ${role}.`,
    metadata: { role, goal, requiredGate: "agent.spawn", launch: "code spawn run <id>" },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "coding_spawn_requested",
    payload: { id: artifact.id, role, goal },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Coding spawn request stored: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [
      `code show ${artifact.id}`,
      `code approve ${artifact.id}`,
      `code deny ${artifact.id}`,
      `code spawn run ${artifact.id}`,
    ],
    event: "coding_spawn_requested",
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "artifact",
    workspace: session.workspace_root,
  });
}

function listSpawnRequests(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  session: CodingSessionRow,
): void {
  const requests = db
    .listCodingArtifacts(session.id, 50)
    .filter((artifact) => artifact.kind === "spawn_request" && artifact.status !== "archived");
  if (requests.length === 0) {
    ctx.send(eid, "No coding spawn requests for this session.");
    return;
  }
  const lines = [header("Coding Spawn Requests"), separator()];
  for (const artifact of requests) {
    const meta = parseJsonObject(artifact.metadata_json);
    lines.push(
      `  ${artifact.id} ${dim(artifact.status)} ${meta.role ?? "agent"} ${dim(String(meta.goal ?? artifact.title))}`,
    );
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code spawn run <id>", "code approve <id>", "code deny <id>"],
    event: "coding_spawn_requests_listed",
    rows: requests.map((artifact) => {
      const meta = parseJsonObject(artifact.metadata_json);
      return {
        detail: typeof meta.goal === "string" ? meta.goal : artifact.content_text,
        id: artifact.id,
        status: artifact.status,
        title: typeof meta.role === "string" ? meta.role : artifact.title,
        type: "spawn_request",
      };
    }),
    sessionId: session.id,
    title: "Coding Spawn Requests",
    type: "list",
    workspace: session.workspace_root,
  });
}

async function runApprovedSpawnRequest(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  args: string[],
): Promise<void> {
  // Agentic-spawn surface is telnet-denied by construction — symmetric with
  // doCode/crewPlan/assignCode. Defense-in-depth on the approved-spawn path.
  if (refuseTelnetDispatch(ctx, eid, deps)) return;
  if (!deps.agentRuntime?.spawn) {
    ctx.send(eid, "Agent spawning is not available in this Marina process.");
    return;
  }
  if (deps.agentRuntime.isAvailable && !deps.agentRuntime.isAvailable()) {
    ctx.send(eid, "No LLM runtime is available for local agent spawning.");
    return;
  }

  const parsed = parseSpawnRunArgs(args);
  const artifact = resolveKindArtifact(
    ctx,
    eid,
    deps.db,
    session.id,
    parsed.ref,
    "spawn_request",
    "last spawn request",
  );
  if (!artifact) return;
  if (artifact.status !== "approved") {
    ctx.send(eid, `Spawn request ${artifact.id} is ${artifact.status}, not approved.`);
    return;
  }

  // Spawning a coding agent is the same governed capability as `agent spawn`:
  // enforce the agent.spawn safety gate here rather than bypassing it from
  // inside Code Mode. The session-level approval artifact is a human review
  // step; the gate is the civic-substrate competence proof.
  // Posture-aware: the session-level approval artifact is a human review of
  // the *request*, not an attestation of gate competence — so the gate is
  // checked independently, with witness windows / earned practice / open
  // posture honored and their consequence recorded.
  const gate = checkGateForExecution(deps.db, eid, "agent.spawn");
  if (!gate.ok) {
    ctx.send(eid, gate.reason ?? "Not permitted to spawn agents.");
    return;
  }
  recordGateExecution(deps.db, eid, "agent.spawn", gate, "code agent-spawn artifact");

  const meta = parseJsonObject(artifact.metadata_json);
  const role = typeof meta.role === "string" ? meta.role : "implementer";
  const goal = typeof meta.goal === "string" ? meta.goal : artifact.content_text;
  const modelTarget =
    parsed.model ?? modelTargetForAgentSpawn(getSessionModelTarget(deps.db, session.id));
  const agentName =
    parsed.name ?? uniqueSpawnAgentName(deps.agentRuntime.list?.() ?? [], role, session.id);

  sendCode(ctx, eid, `Spawning ${agentName} for ${role}...`, {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: ["code status"],
    event: "coding_spawn_started",
    modelTarget,
    sessionId: session.id,
    status: "running",
    title: `Spawn ${agentName}`,
    type: "session",
    workspace: session.workspace_root,
  });

  try {
    const handle = await deps.agentRuntime.spawn({
      goal: `${goal}\n\nCoding session: ${session.id}\nWorkspace: ${session.workspace_root}`,
      model: modelTarget,
      name: agentName,
      role,
      spawnedBy: entity.name,
    });
    bindSpawnedAgentEntity(handle, session, getCodeProfile(entity).name, deps);
    const attention = [
      `You were launched for Marina coding session ${session.id}.`,
      `Role: ${role}`,
      `Workspace: ${session.workspace_root}`,
      modelTarget ? `Model target: ${modelTarget}` : undefined,
      "",
      "Start with marina_code status, then inspect files/read/search/diff. Use patch for edits, verify for checks, and summary/handoff for durable progress.",
      "",
      `Goal: ${goal}`,
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n");
    await handle.sendAttention(attention);

    deps.db.updateCodingArtifact(artifact.id, {
      status: "launched",
      metadata: {
        ...meta,
        agent: handle.name,
        launchedAt: Date.now(),
        launchedBy: entity.name,
        modelTarget,
      },
    });
    const assignment = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "spawn_assignment",
      title: `Spawned ${handle.name}: ${role}`,
      status: "complete",
      contentText: attention,
      metadata: { agent: handle.name, role, goal, sourceArtifactId: artifact.id, modelTarget },
      createdBy: entity.name,
    });
    deps.db.updateCodingSession(session.id, { mode: "agent" });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "coding_spawn_launched",
      payload: {
        id: artifact.id,
        assignmentId: assignment.id,
        agent: handle.name,
        role,
        modelTarget,
      },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    // NOTE: no self-recorded agent.spawn demonstration here — supervised-only
    // entities never reach this point (checkUnattendedGate refuses above).
    sendCode(ctx, eid, success(`Coding agent launched: ${handle.name}`), {
      artifactId: assignment.id,
      artifactKind: assignment.kind,
      commands: [`code show ${assignment.id}`, "code status", "code history"],
      content: attention,
      event: "coding_spawn_launched",
      modelTarget,
      rows: [{ id: handle.name, detail: goal, status: "launched", title: role, type: "agent" }],
      sessionId: session.id,
      status: assignment.status,
      title: assignment.title,
      type: "artifact",
      workspace: session.workspace_root,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "coding_spawn_failed",
      payload: { id: artifact.id, role, message },
    });
    sendCode(ctx, eid, fmtError(`Coding spawn failed: ${message}`), {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      content: message,
      event: "coding_spawn_failed",
      modelTarget,
      sessionId: session.id,
      status: "failed",
      title: artifact.title,
      type: "artifact",
      workspace: session.workspace_root,
    });
  }
}
