// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CodeSessionDriver } from "../../../coding/code-session-driver";
import { bold, dim, error as fmtError, separator, success } from "../../../net/ansi";
import type { CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { checkGateForExecution, grant, recordGateExecution } from "../../safety-gates";
import { bindSessionWriter, crewPlan, recruitCodingAgent } from "./crew";
import { startSession } from "./session";
import {
  bindSpawnedAgentEntity,
  type CodeDeps,
  getActiveSessionId,
  getAgentHandle,
  getCodeProfile,
  getSessionModelTarget,
  modelTargetForAgentSpawn,
  NO_CODE_ROOT_DENY,
  refuseTelnetDispatch,
  resolveSession,
  sameEntityName,
  sendCode,
  uniqueSpawnAgentName,
  updateCodeContext,
} from "./shared";
import {
  agentHasActiveCodingTask,
  clearCodingTask,
  stopCodeStreamsFor,
  streamSessionAgent,
} from "./stream";
import { getWorkspaceRegistry } from "./workspace";

export async function askCode(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  driver: CodeSessionDriver,
  prompt: string,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const profile = getCodeProfile(entity);
  const modelTarget = getSessionModelTarget(deps.db, session.id);
  const artifact = await driver.runDirect({
    actor: entity.name,
    modelTarget,
    profile: profile.name,
    prompt,
    session,
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(
    ctx,
    eid,
    [
      success(`Code response stored: ${artifact.id}`),
      dim(`Strategy: direct model | Session: ${session.id}`),
      separator(),
      artifact.content_text,
    ].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: [`code show ${artifact.id}`, "code status"],
      content: artifact.content_text,
      event: "code_response_stored",
      modelTarget,
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "skill",
      workspace: session.workspace_root,
    },
  );
}

export async function assignCode(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  driver: CodeSessionDriver,
  args: string[],
): Promise<void> {
  // Agentic dispatch: hands host-affecting work to a coding agent — telnet-denied.
  if (refuseTelnetDispatch(ctx, eid, deps)) return;
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const agentName = args[0];
  const prompt = args.slice(1).join(" ");
  const profile = getCodeProfile(entity);
  const modelTarget = getSessionModelTarget(deps.db, session.id);
  const artifact = await driver.assignAgent({
    actor: entity.name,
    agentName: agentName ?? "",
    modelTarget,
    profile: profile.name,
    prompt,
    session,
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(
    ctx,
    eid,
    [
      success(`Coding session assigned: ${agentName}`),
      `Session: ${session.id}`,
      `Artifact: ${artifact.id}`,
      dim("The agent will continue through Marina's normal attention/tool loop."),
    ].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: [`code show ${artifact.id}`, "code status", "code history"],
      content: artifact.content_text,
      event: "code_agent_assigned",
      modelTarget,
      rows: [
        {
          detail: prompt,
          id: agentName,
          status: artifact.status,
          title: agentName,
          type: "agent",
        },
      ],
      sessionId: session.id,
      status: artifact.status,
      title: `Assigned: ${agentName}`,
      type: "artifact",
      workspace: session.workspace_root,
    },
  );
}

/**
 * Code Mode dispatch strategies. The registry is the extensibility seam — a new
 * strategy (multi-agent swarm, heterogeneous multi-backend, emergent grouping)
 * is a registry entry + a branch in doCode, nothing else. The *backend* for any
 * strategy is orthogonal: `code model <target>` sets the session's model, which
 * the single agent (and crew members) spawn against — so different sessions can
 * run on different models/providers today.
 */
const CODE_DRIVERS: Record<string, string> = {
  single: "one coding agent bound to the session (Codex/Claude/Cursor-style)",
  crew: "implementer + reviewer + tester working in parallel",
};

/**
 * Code Mode's default agentic dispatch (Codex/Claude/Cursor-style): take a
 * natural-language task and drive autonomous work on the active session via the
 * session's *driver*. "single" (default) binds one coding agent to the session;
 * "crew" fans out to implementer/reviewer/tester. The driver is a seam — new
 * strategies (multi-agent, multi-backend) slot in here without touching callers.
 */
export async function doCode(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  driver: CodeSessionDriver,
  rawTask: string,
): Promise<void> {
  const task = rawTask.trim();
  if (!task) {
    ctx.send(eid, 'Describe what you want done, e.g. "fix the off-by-one in the tokenizer".');
    return;
  }

  // LAYER 0: the agentic dispatch path (`code do <task>` and the natural-language
  // modal fall-through) spawns/recruits a coder, grants it code.exec, and drives
  // host execution — so a telnet-origin dispatcher must be refused here, BEFORE
  // any session auto-start / ensureSessionAgent / crew spawn. Same refusal as
  // the explicit host-exec subcommands (which never reach doCode).
  if (refuseTelnetDispatch(ctx, eid, deps)) return;

  // LAYER 0.5: no configured code root → refuse (Finding 2). The dispatched
  // coder would otherwise run in Marina's own source tree.
  if (getWorkspaceRegistry(deps).usesCwdFallback) {
    ctx.send(eid, NO_CODE_ROOT_DENY);
    return;
  }

  // FINDING 7: the DISPATCHING entity must itself hold code.exec (unsupervised)
  // before we recruit/bind/spawn a coder and grant IT code.exec on the
  // dispatcher's behalf. Otherwise a standing-0 caller drives arbitrary host
  // execution through a plain Code Mode task, never touching a gated subcommand.
  // Posture-aware: the drive-by path still cannot be self-certified, while
  // witness windows / earned-posture practice / open posture authorize the
  // dispatcher with the consequence recorded. Delegation of code.exec to the
  // coder is only legitimate when the dispatcher is itself authorized.
  const dispatcherGate = checkGateForExecution(deps.db, eid, "code.exec");
  if (dispatcherGate.ok) {
    recordGateExecution(deps.db, eid, "code.exec", dispatcherGate, "code task dispatch");
  }
  if (!dispatcherGate.ok) {
    ctx.send(
      eid,
      dispatcherGate.reason ??
        "Dispatching a coding agent requires the code.exec capability, which is earned through contribution.",
    );
    return;
  }

  // Auto-start a session on the first task so entering Code Mode + typing just
  // works — no explicit `code start` required.
  if (!getActiveSessionId(entity)) startSession(ctx, eid, entity, deps, "");
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;

  // Self-dispatch guard: the bound coder is itself in the code modal, so any
  // stray line from its own loop (e.g. `brief` rewritten to `code brief` by
  // the engine's modal routing) lands here. Queuing that as a NEW task to
  // itself creates a dispatch loop and echoes noise to the human — refuse.
  // Normalized comparison: session.agent may hold a config name ("code-coder-
  // code_5") while the agent's entity logged in sanitized ("codecodercode_5").
  if (session.agent && sameEntityName(session.agent, entity.name)) {
    ctx.send(
      eid,
      "You are this session's coding agent — act with marina_code actions; the task is already assigned.",
    );
    return;
  }

  const strategy = (session.driver ?? "single").toLowerCase();
  if (strategy === "crew") {
    await crewPlan(ctx, eid, entity, deps, task);
    return;
  }

  // Single-agent driver (default): ensure one bound coder, hand it the task.
  const agentName = await ensureSessionAgent(ctx, eid, entity, deps, session);
  if (!agentName) return; // ensureSessionAgent already explained why
  const profile = getCodeProfile(entity);
  try {
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_lifecycle",
      payload: { phase: "received", task },
    });
    sendCode(ctx, eid, "Task received and queued for the coding agent.", {
      event: "code_lifecycle",
      metadata: { phase: "received", task },
      phase: "received",
      sessionId: session.id,
      status: "active",
      title: "Task received",
      type: "lifecycle",
    });
    await driver.assignAgent({
      actor: entity.name,
      agentName,
      modelTarget: getSessionModelTarget(deps.db, session.id),
      profile: profile.name,
      prompt: task,
      session,
    });
    // Stream the bound agent's live work back to this human so Code Mode shows
    // it working (reads, edits, test runs, prose) rather than going quiet.
    const handle = getAgentHandle(deps, agentName);
    if (handle) streamSessionAgent(deps, eid, handle, session.id);
    ctx.send(
      eid,
      [
        success(`→ ${agentName} is on it.`),
        dim(`"${task.length > 80 ? `${task.slice(0, 77)}...` : task}"`),
        dim("It explores, edits, and runs checks autonomously — streaming below. Type to steer."),
      ].join("\n"),
    );
  } catch (err) {
    ctx.send(eid, fmtError(err instanceof Error ? err.message : String(err)));
  }
}

/**
 * Ensure the session has a live autonomous coding agent bound to it (the
 * single-agent default driver). Reuses the bound agent if still running, else
 * recruits an idle coding agent or spawns a fresh one. The bound agent is
 * granted code.exec for the session so it can actually run/apply — the operator
 * entering Code Mode is the responsible party (spawning itself is agent.spawn-
 * gated). Returns the agent name, or null after sending an explanation.
 */
async function ensureSessionAgent(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
): Promise<string | null> {
  // 1) Reuse the already-bound agent if it's still running.
  const boundHandle = session.agent ? getAgentHandle(deps, session.agent) : undefined;
  if (session.agent && boundHandle) {
    bindSessionWriter(deps, session, entity.name, boundHandle.name ?? session.agent);
    return boundHandle.name ?? session.agent;
  }

  // 2) Recruit an idle coding agent already in the world.
  const recruited = recruitCodingAgent(deps, new Set());
  if (recruited) {
    grant(deps.db, recruited.id, "code.exec");
    deps.db.updateCodingSession(session.id, { agent: recruited.name, driver: "single" });
    bindSessionWriter(deps, session, entity.name, recruited.name);
    return recruited.name;
  }

  // 3) Spawn a fresh coder (agent.spawn-gated).
  if (!deps.agentRuntime?.spawn) {
    ctx.send(eid, "No agent runtime available to drive this session.");
    return null;
  }
  if (deps.agentRuntime.isAvailable && !deps.agentRuntime.isAvailable()) {
    ctx.send(eid, "No LLM provider configured — set a provider key, then a coding agent can run.");
    return null;
  }
  // Posture-aware agent.spawn: self-certification stays closed; witness
  // windows, earned-posture practice, and open posture authorize with the
  // consequence recorded.
  const gate = checkGateForExecution(deps.db, eid, "agent.spawn");
  if (!gate.ok) {
    ctx.send(eid, gate.reason ?? "Not permitted to launch a coding agent (requires agent.spawn).");
    return null;
  }
  recordGateExecution(deps.db, eid, "agent.spawn", gate, "code session coder");
  const name = uniqueSpawnAgentName(deps.agentRuntime.list?.() ?? [], "coder", session.id);
  const modelTarget = modelTargetForAgentSpawn(getSessionModelTarget(deps.db, session.id));
  try {
    const handle = await deps.agentRuntime.spawn({
      goal: [
        `You are the autonomous coder for Marina coding session ${session.id}.`,
        `Workspace: ${session.workspace_root}`,
        "Follow this operating contract for every task: inspect status and relevant files first; record a short plan; make the smallest reviewable patch; inspect the resulting diff; run the relevant verification chain; fix failures within the task scope; then record a summary citing changed paths and successful checks.",
        "Do not claim completion before verification succeeds. Do not modify unrelated files, install dependencies, launch applications, or expand scope without a user decision. Prefer one bounded tool action at a time so progress remains observable and steerable.",
      ].join("\n"),
      model: modelTarget,
      name,
      role: "coding-agent",
      spawnedBy: entity.name,
    });
    bindSpawnedAgentEntity(handle, session, getCodeProfile(entity).name, deps);
    const spawnedId = handle.getStatus().entityId;
    if (spawnedId) grant(deps.db, spawnedId as EntityId, "code.exec");
    deps.db.updateCodingSession(session.id, { agent: handle.name, driver: "single" });
    bindSessionWriter(deps, session, entity.name, handle.name);
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_session_agent_launched",
      payload: { agent: handle.name, modelTarget },
    });
    return handle.name;
  } catch (err) {
    ctx.send(
      eid,
      fmtError(
        `Could not launch a coding agent: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return null;
  }
}

/** `code driver [single|crew]` — view or set the session's dispatch strategy. */
export function driverCommand(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const current = session.driver ?? "single";
  const want = args[0]?.toLowerCase();
  const names = Object.keys(CODE_DRIVERS);
  if (!want) {
    const lines = names.map(
      (n) => `  ${n === current ? bold(`${n} ✓`) : n} ${dim(`— ${CODE_DRIVERS[n]}`)}`,
    );
    ctx.send(
      eid,
      [
        `Driver: ${bold(current)}`,
        ...lines,
        dim("Set with: code driver <name>. Backend per session: code model <target>."),
      ].join("\n"),
    );
    return;
  }
  if (!names.includes(want)) {
    ctx.send(eid, `Unknown driver "${want}". Available: ${names.join(", ")}.`);
    return;
  }
  deps.db.updateCodingSession(session.id, { driver: want });
  ctx.send(eid, success(`Driver set to ${want}. ${dim(CODE_DRIVERS[want] ?? "")}`));
}

/**
 * `code stop` (alias `cancel`) — abort the bound agent's current run and stop
 * streaming its activity. The session, its artifacts, and the agent binding all
 * stay intact; the next `code do` reuses the same agent. The abort seam is
 * AgentHandle.reconfigure({}) — the runtime's exposed "abort in-flight prompt,
 * wait for idle, restart the loop with unchanged config" path.
 */
export async function stopSessionAgent(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  stopCodeStreamsFor(eid); // stop forwarding the bound agent's activity first
  const agentName = session.agent;
  if (!agentName) {
    ctx.send(eid, "No coding agent is bound to this session — nothing to stop.");
    return;
  }
  // An interrupt of an in-flight task is a *terminal failure* for machine
  // consumers (one-shot `marina -p`); a stop with nothing assigned is benign.
  const interruptedTask = agentHasActiveCodingTask(deps, agentName);
  clearCodingTask(deps, agentName); // task mode ends with the run
  const handle = getAgentHandle(deps, agentName);
  let aborted = false;
  if (handle && typeof handle.reconfigure === "function") {
    try {
      await handle.reconfigure({});
      aborted = true;
    } catch {
      // Best-effort — the agent may already be stopping; streaming is off regardless.
    }
    try {
      await handle.sendAttention(
        `${entity.name} stopped your current run on coding session ${session.id}. Stand by for a new task; do not resume the interrupted one unless re-asked.`,
      );
    } catch {
      // Non-fatal — the abort already landed (or the agent is gone).
    }
  }
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "code_agent_stopped",
    payload: { agent: agentName, aborted, interruptedTask },
  });
  const phase = interruptedTask ? "failed" : "stopped";
  if (interruptedTask) {
    // Mirror the streamed lifecycle records so the durable event log also
    // carries the terminal failure.
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_lifecycle",
      payload: { agent: agentName, phase, reason: "stopped", terminal: true },
    });
  }
  const detail = !handle
    ? `${agentName} is not running — streaming stopped.`
    : aborted
      ? `${agentName}'s current run was aborted; the agent stays bound and idle.`
      : `${agentName} could not be interrupted cleanly; streaming stopped.`;
  sendCode(
    ctx,
    eid,
    [
      success(`Stopped ${agentName} on session ${session.id}.`),
      detail,
      dim("Session and artifacts are intact. Type a new task or `code done` to close out."),
    ].join("\n"),
    {
      event: "code_lifecycle",
      metadata: {
        agent: agentName,
        aborted,
        phase,
        ...(interruptedTask ? { reason: "stopped", terminal: true } : {}),
      },
      phase,
      sessionId: session.id,
      status: interruptedTask ? "failed" : "active",
      title: `Stopped ${agentName}`,
      type: "lifecycle",
    },
  );
}
