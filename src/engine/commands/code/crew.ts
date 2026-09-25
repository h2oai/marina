// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { CrewError } from "../../../coordination/crew-manager";
import { dim, error as fmtError, header, separator, success } from "../../../net/ansi";
import type { CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { CrewFormation, Entity, EntityId, RoomContext } from "../../../types";
import { sanitizeEntityName } from "../../entity-name";
import { checkGateForExecution, recordGateExecution } from "../../safety-gates";
import {
  bindSpawnedAgentEntity,
  type CodeDeps,
  entityNameForm,
  formatCodingNoteTitle,
  getAgentHandle,
  getCodeProfile,
  getSessionModelTarget,
  modelTargetForAgentSpawn,
  refuseTelnetDispatch,
  resolveSession,
  sameEntityName,
  sendCode,
  uniqueSpawnAgentName,
  updateCodeContext,
} from "./shared";

const CODING_ROLES = [
  ["planner", "Turns the goal into a small ordered plan and acceptance criteria."],
  ["implementer", "Makes the smallest coherent patch against the workspace."],
  ["reviewer", "Reviews diffs for correctness, regressions, and missing tests."],
  ["tester", "Runs allowed checks and records verification artifacts."],
  ["security", "Looks for path, secret, network, auth, and data risks."],
  ["release", "Writes summary, handoff, and operator-facing notes."],
] as const;

export function roles(ctx: RoomContext, eid: EntityId): void {
  const lines = [header("Coding Roles"), separator()];
  for (const [role, detail] of CODING_ROLES) {
    lines.push(`  ${role} ${dim(detail)}`);
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code crew <goal>", "code spawn <role> <goal>", "code assign <agent> <request>"],
    event: "coding_roles_shown",
    rows: CODING_ROLES.map(([role, detail]) => ({
      id: role,
      detail,
      title: role,
      type: "role",
    })),
    title: "Coding Roles",
    type: "list",
  });
}

/**
 * Parse `code crew <goal> [with <agentA,agentB,...>]`. The optional trailing
 * `with <members>` clause names live agents who should join the crew; the goal
 * is everything before it.
 */
function parseCrewArgs(raw: string): { goal: string; members: string[] } {
  const match = raw.match(/\bwith\b/i);
  if (!match || match.index === undefined) {
    return { goal: raw.trim(), members: [] };
  }
  const goal = raw.slice(0, match.index).trim();
  const memberPart = raw.slice(match.index + match[0].length).trim();
  const members = memberPart
    .split(/[,\s]+/)
    .map((m) => m.trim())
    .filter(Boolean);
  return { goal, members };
}

export async function crewPlan(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  rawGoal: string,
): Promise<void> {
  // Agentic dispatch: fans out implementer/reviewer/tester coders — telnet-denied.
  if (refuseTelnetDispatch(ctx, eid, deps)) return;
  // NOTE: the crew path does NOT grant code.exec to its members (only the
  // single-driver ensureSessionAgent does, via grant() at the recruit/spawn
  // sites). Spawning members is gated on agent.spawn in assembleCodingCrew, and
  // any member that later attempts host execution must itself pass the code.exec
  // gate (checkUnattendedGate at the run/apply site). So crew dispatch is NOT
  // gated on the dispatcher's own code.exec — that would block legitimate
  // coordination that never delegates host execution. (Finding 7's dispatcher
  // gate lives on the doCode single-driver path, where code.exec IS granted.)
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const { goal: text, members } = parseCrewArgs(rawGoal);
  if (!text) {
    ctx.send(eid, "Usage: code crew <goal> [with <agentA,agentB,...>]");
    return;
  }
  const body = [
    `Goal: ${text}`,
    "",
    "Suggested crew:",
    ...CODING_ROLES.map(([role, detail]) => `- ${role}: ${detail}`),
    "",
    members.length > 0
      ? `Members requested: ${members.join(", ")}`
      : "Next: name members with code crew <goal> with <agentA,agentB,...>, assign live agents with code assign, or request supervised spawns with code spawn.",
  ].join("\n");
  // Always write the crew_plan proposal trail.
  const planArtifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "crew_plan",
    title: formatCodingNoteTitle("plan", text).replace("Plan:", "Crew plan:"),
    status: "planned",
    contentText: body,
    metadata: { goal: text, roles: CODING_ROLES.map(([role]) => role), members },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "coding_crew_planned",
    payload: { id: planArtifact.id, goal: text, members },
  });

  // Two dispatch paths, both degrade to the crew_plan-only proposal trail:
  //  - explicit `with <a,b>`: resolve the named agents (recruited) and dispatch.
  //  - bare `code crew <goal>`: autonomously assemble (recruit + gated spawn).
  if (members.length > 0) {
    if (deps.crewManager && deps.channelManager) {
      const assembled = resolveNamedMembers(ctx, eid, deps, members);
      if (assembled.length > 0) {
        const dispatched = await dispatchCodingCrew(
          ctx,
          eid,
          entity,
          deps,
          session,
          text,
          assembled,
          planArtifact.id,
        );
        if (dispatched) return;
      }
    } else {
      ctx.send(
        eid,
        dim(
          "Live crew dispatch is unavailable in this Marina process; stored the crew plan instead.",
        ),
      );
    }
  } else if (deps.crewManager && deps.channelManager) {
    const assembled = await assembleCodingCrew(ctx, eid, entity, deps, session, text);
    if (assembled.length > 0) {
      const dispatched = await dispatchCodingCrew(
        ctx,
        eid,
        entity,
        deps,
        session,
        text,
        assembled,
        planArtifact.id,
      );
      if (dispatched) return;
    } else {
      ctx.send(
        eid,
        dim(
          "Could not assemble a crew — need agent.spawn competence or online coding agents. Stored the crew plan instead.",
        ),
      );
    }
  }

  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, `${success(`Coding crew plan stored: ${planArtifact.id}`)}\n${body}`, {
    artifactId: planArtifact.id,
    artifactKind: planArtifact.kind,
    commands: [
      `code show ${planArtifact.id}`,
      "code roles",
      "code crew <goal> with <agentA,agentB>",
      "code assign <agent> <request>",
    ],
    content: body,
    event: "coding_crew_planned",
    rows: CODING_ROLES.map(([role, detail]) => ({ id: role, detail, title: role, type: "role" })),
    sessionId: session.id,
    status: planArtifact.status,
    title: planArtifact.title,
    type: "artifact",
    workspace: session.workspace_root,
  });
}

/**
 * A crew member ready to dispatch. `source` records how the member joined:
 * `recruited` for an existing live agent named (or auto-picked), `spawned` for
 * an agent launched through the `agent.spawn` gate during autonomous assembly.
 * `role` is the coding role we want the crew to assign; when undefined the crew
 * falls back to its own default (preserves the explicit-`with` behavior).
 */
interface AssembledMember {
  agentName: string;
  id: EntityId;
  role?: string;
  source: "recruited" | "spawned";
}

/**
 * Resolve an explicit `with <a,b,...>` member list to live agents. Unknown
 * names are surfaced and skipped; resolved agents join as `recruited` with no
 * forced role (the crew assigns its default — preserves existing behavior).
 */
function resolveNamedMembers(
  ctx: RoomContext,
  eid: EntityId,
  deps: CodeDeps & { db: MarinaDB },
  members: string[],
): AssembledMember[] {
  const resolved: AssembledMember[] = [];
  const missing: string[] = [];
  for (const name of members) {
    const agent = deps.findAgentByName?.(name) ?? deps.findAgentByName?.(sanitizeEntityName(name));
    if (agent) resolved.push({ agentName: agent.name, id: agent.id, source: "recruited" });
    else missing.push(name);
  }
  if (resolved.length === 0) {
    ctx.send(
      eid,
      `Could not resolve any named agents (${missing.join(", ")}). Stored the crew plan instead.`,
    );
    return [];
  }
  if (missing.length > 0) {
    ctx.send(eid, dim(`Skipping unknown agents: ${missing.join(", ")}`));
  }
  return resolved;
}

// The default autonomous coding crew. Implementer holds the write lock;
// reviewer + tester read/advise. Pulled from CODING_ROLES so the role detail
// (used as the spawned agent's attention) stays in one place.
const AUTONOMOUS_CREW_ROLES = ["implementer", "reviewer", "tester"] as const;

/**
 * Autonomously assemble a coding crew from a bare goal (no `with` clause).
 * Hybrid sourcing: recruit an existing idle/unassigned coding agent per role,
 * else spawn one through the `agent.spawn` safety gate (mirrors
 * runApprovedSpawnRequest — the gate IS the governance). Gate-blocked roles
 * with no recruit are skipped. Returns the members it could assemble (possibly
 * empty); never throws.
 */
async function assembleCodingCrew(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  goal: string,
): Promise<AssembledMember[]> {
  const assembled: AssembledMember[] = [];
  // Names already in this assembly OR already live, so we never double-book an
  // agent across roles.
  const taken = new Set<string>();
  // Roles map by detail for spawned-agent attention.
  const roleDetail = new Map<string, string>(CODING_ROLES.map(([role, detail]) => [role, detail]));
  // agent.spawn is checked once via checkUnattendedGate: a supervised-only
  // holder is refused (Finding 3) — crew assembly cannot self-certify the gate.
  let gateChecked = false;
  let gateOk = false;
  let gateReason: string | undefined;

  for (const role of AUTONOMOUS_CREW_ROLES) {
    // 1) Try to recruit an existing live coding agent not already taken.
    const recruit = recruitCodingAgent(deps, taken);
    if (recruit) {
      assembled.push({ agentName: recruit.name, id: recruit.id, role, source: "recruited" });
      taken.add(recruit.name.toLowerCase());
      continue;
    }

    // 2) Spawn through the agent.spawn gate. The gate result is stable for the
    //    entity across this assembly, so check it once.
    if (!deps.agentRuntime?.spawn) continue;
    if (deps.agentRuntime.isAvailable && !deps.agentRuntime.isAvailable()) continue;
    if (!gateChecked) {
      const gate = checkGateForExecution(deps.db, eid, "agent.spawn");
      gateChecked = true;
      gateOk = gate.ok;
      gateReason = gate.reason;
      if (gate.ok) recordGateExecution(deps.db, eid, "agent.spawn", gate, "code crew assembly");
    }
    if (!gateOk) {
      ctx.send(eid, dim(`Skipping ${role}: ${gateReason ?? "not permitted to spawn agents."}`));
      continue;
    }

    const agentName = uniqueSpawnAgentName(
      [...(deps.agentRuntime.list?.() ?? []), ...assembled.map((m) => ({ name: m.agentName }))],
      role,
      session.id,
    );
    const modelTarget = modelTargetForAgentSpawn(getSessionModelTarget(deps.db, session.id));
    const detail = roleDetail.get(role) ?? role;
    try {
      const handle = await deps.agentRuntime.spawn({
        goal: `${detail}\n\nGoal: ${goal}\n\nCoding session: ${session.id}\nWorkspace: ${session.workspace_root}`,
        model: modelTarget,
        name: agentName,
        role,
        spawnedBy: entity.name,
      });
      bindSpawnedAgentEntity(handle, session, getCodeProfile(entity).name, deps);
      const attention = [
        `You were launched for Marina coding session ${session.id}.`,
        `Role: ${role} — ${detail}`,
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
      deps.db.createCodingArtifact({
        sessionId: session.id,
        kind: "spawn_assignment",
        title: `Spawned ${handle.name}: ${role}`,
        status: "complete",
        contentText: attention,
        metadata: { agent: handle.name, role, goal, source: "autonomous_crew", modelTarget },
        createdBy: entity.name,
      });
      deps.db.createCodingEvent({
        sessionId: session.id,
        actor: entity.name,
        kind: "coding_spawn_launched",
        payload: { agent: handle.name, role, modelTarget, source: "autonomous_crew" },
      });
      // Bind the freshly spawned entity id so it can join the crew channel.
      const spawnedId = handle.getStatus().entityId;
      assembled.push({
        agentName: handle.name,
        id: (spawnedId ?? handle.name) as EntityId,
        role,
        source: "spawned",
      });
      taken.add(handle.name.toLowerCase());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.send(eid, dim(`Skipping ${role}: spawn failed (${message}).`));
    }
  }
  return assembled;
}

/**
 * Hold the session write lock for the bound single-driver agent — mirrors the
 * crew-dispatch writer assignment so applyPatch's write-lock/creator guard
 * admits the agent that was just handed the task. No-op when already held.
 */
export function bindSessionWriter(
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  actor: string,
  writer: string,
): void {
  // Store the entity-name form the write-lock guards will actually see at
  // apply time — a config name with dashes sanitizes at login.
  const writerName = entityNameForm(writer);
  if (session.writer === writerName) return;
  deps.db.updateCodingSession(session.id, { writer: writerName });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor,
    kind: "writer_changed",
    payload: { writer: writerName, previousWriter: session.writer ?? null, reason: "agent_bind" },
  });
}

// Roles a recruit may hold to be drafted as a session coder. Anything else
// (market-oracle, chronicler, ...) is skipped so binding never hands code.exec
// to an agent whose role has nothing to do with writing code.
const CODING_ROLE_PATTERN = /cod|implement|engineer/i;

/**
 * Pick an existing live coding agent not already taken in this assembly. Best
 * effort: the runtime's agent list is the source of "online"; we skip any name
 * already taken. (Idle/assigned distinction is not surfaced by the runtime list
 * here, so we treat any untaken online agent as recruitable.)
 */
export function recruitCodingAgent(
  deps: CodeDeps & { db: MarinaDB },
  taken: Set<string>,
  model?: string,
): { name: string; id: EntityId } | undefined {
  const candidates = deps.listAgents?.() ?? [];
  for (const candidate of candidates) {
    const name = candidate.name;
    if (!name || taken.has(name.toLowerCase())) continue;
    // Config names may differ from the login-sanitized entity name — retry.
    const agent = deps.findAgentByName?.(name) ?? deps.findAgentByName?.(sanitizeEntityName(name));
    if (!agent) continue;
    if (model && getAgentHandle(deps, name)?.getStatus().model !== model) continue;
    const role =
      getAgentHandle(deps, name)?.getStatus().role ??
      (candidate as { role?: string }).role ??
      agent.properties.role;
    if (typeof role !== "string" || !CODING_ROLE_PATTERN.test(role)) continue;
    // Return the runtime-facing candidate name (not agent.name): downstream
    // dispatch resolves the handle by this name; the writer lock stores the
    // sanitized entity form separately.
    return { name, id: agent.id };
  }
  return undefined;
}

/**
 * Create + dispatch a real ephemeral crew from already-resolved members.
 * Returns true on success (a `crew_dispatched` artifact was emitted), false to
 * fall back to the crew_plan-only path. Never throws — CrewError and
 * missing-manager cases degrade gracefully.
 *
 * On success the session write lock is set to `writer` (the implementer, else
 * the first member) so concurrent crew members can't race on workspace writes.
 */
async function dispatchCodingCrew(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  goal: string,
  resolved: AssembledMember[],
  planArtifactId: string,
): Promise<boolean> {
  const crewManager = deps.crewManager;
  const channelManager = deps.channelManager;
  if (!crewManager || !channelManager) return false;
  if (resolved.length === 0) return false;

  // Map agentName -> source so we can annotate the dispatched-artifact members
  // with how each one joined (recruited vs spawned).
  const sourceByName = new Map(resolved.map((m) => [m.agentName, m.source] as const));
  // The implementer holds the write lock; fall back to the first member.
  // Stored in entity-name form (login-sanitized) so the guards match the
  // member's actual entity at apply time.
  const writerSource =
    resolved.find((m) => m.role === "implementer")?.agentName ?? resolved[0]?.agentName;
  const writer = writerSource ? entityNameForm(writerSource) : writerSource;

  const formation: CrewFormation = "swarm";
  const crewName = `code-${session.id}-${crypto.randomUUID().slice(0, 6)}`;
  try {
    const crew = crewManager.create({
      name: crewName,
      goal,
      formation,
      lifetime: "ephemeral",
      owner: entity.id,
      members: resolved.map((m) =>
        m.role ? { agentName: m.agentName, role: m.role } : { agentName: m.agentName },
      ),
    });
    crewManager.dispatch(crew.id, goal, { id: entity.id, name: entity.name });
    // The first dispatch lazily provisions the crew channel; mirror the crew
    // command's behavior and ensure all members + the owner are joined.
    if (crew.channelId) {
      for (const member of resolved) {
        if (!channelManager.isMember(crew.channelId, member.id)) {
          channelManager.addMember(crew.channelId, member.id);
        }
      }
      if (!channelManager.isMember(crew.channelId, eid)) {
        channelManager.addMember(crew.channelId, eid);
      }
    }

    const memberRoles = crew.members.map((m) => ({
      agentName: m.agentName,
      role: m.role,
      source: sourceByName.get(m.agentName) ?? "recruited",
    }));
    const dispatchedArtifact = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "crew_dispatched",
      title: `Crew dispatched: ${crew.name}`,
      status: "active",
      contentText: [
        `Crew: ${crew.name} (${crew.formation})`,
        `Channel: ${crew.channelId ?? "(pending)"}`,
        `Members: ${memberRoles.map((m) => `${m.agentName} (${m.role})`).join(", ")}`,
        "",
        `Goal: ${goal}`,
      ].join("\n"),
      metadata: {
        crewId: crew.id,
        crewName: crew.name,
        channelId: crew.channelId,
        members: memberRoles,
        formation: crew.formation,
        goal,
        sourceArtifactId: planArtifactId,
      },
      createdBy: entity.name,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "coding_crew_dispatched",
      payload: {
        id: dispatchedArtifact.id,
        crewId: crew.id,
        crewName: crew.name,
        channelId: crew.channelId,
        goal,
      },
    });
    // Single-writer safety: the implementer (else first member) holds the
    // workspace write lock; other members read/advise via artifacts until a
    // handoff (`code handoff to <name>`) or owner reassignment (`code writer`).
    deps.db.updateCodingSession(session.id, { mode: "agent", writer: writer ?? null });
    if (writer) {
      deps.db.createCodingEvent({
        sessionId: session.id,
        actor: entity.name,
        kind: "writer_changed",
        payload: { writer, previousWriter: session.writer ?? null, reason: "crew_dispatch" },
      });
    }
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    sendCode(
      ctx,
      eid,
      [
        success(`Coding crew dispatched: ${crew.name}`),
        `Crew: ${crew.id}`,
        `Channel: ${crew.channelId ?? "(pending)"}`,
        `Members: ${memberRoles.map((m) => `${m.agentName} (${m.role}, ${m.source})`).join(", ")}`,
        writer ? `Write lock: ${writer}` : dim("Write lock: open"),
        dim("The crew is working in its channel; track progress via code status."),
      ].join("\n"),
      {
        artifactId: dispatchedArtifact.id,
        artifactKind: dispatchedArtifact.kind,
        commands: [`code show ${dispatchedArtifact.id}`, "code status", "code history"],
        content: dispatchedArtifact.content_text,
        event: "coding_crew_dispatched",
        metadata: {
          crewId: crew.id,
          crewName: crew.name,
          channelId: crew.channelId,
          members: memberRoles,
          formation: crew.formation,
          goal,
          sourceArtifactId: planArtifactId,
        },
        rows: memberRoles.map((m) => ({
          id: m.agentName,
          detail: `${m.role} (${m.source})`,
          status: "active",
          title: m.agentName,
          type: "agent",
        })),
        sessionId: session.id,
        status: dispatchedArtifact.status,
        title: dispatchedArtifact.title,
        type: "artifact",
        workspace: session.workspace_root,
      },
    );
    return true;
  } catch (err) {
    const message =
      err instanceof CrewError ? err.message : err instanceof Error ? err.message : String(err);
    ctx.send(
      eid,
      `${fmtError(`Crew dispatch failed: ${message}`)}\n${dim(
        "Stored the crew plan instead. Re-run with distinct, online agent names.",
      )}`,
    );
    return false;
  }
}

/**
 * `code writer` — show the current write-lock holder (or "open").
 * `code writer <agent>` — reassign the lock. Allowed by the current holder OR
 * the session creator/owner. Emits a `writer_changed` event + artifact.
 */
export function writerCommand(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const target = args[0]?.trim();
  if (!target) {
    const holder = session.writer ?? "open";
    sendCode(ctx, eid, `${header("Write Lock")}\n${separator()}\nHolder: ${holder}`, {
      commands: ["code writer <agent>", "code handoff <notes> to <agent>"],
      event: "code_writer_shown",
      sessionId: session.id,
      status: session.writer ? "locked" : "open",
      title: "Write Lock",
      type: "session",
      workspace: session.workspace_root,
    });
    return;
  }
  // Only the current holder or the session creator may reassign.
  // Normalized: stored names may be config-name forms that differ from the
  // login-sanitized entity name.
  const isOwner = sameEntityName(session.created_by, entity.name);
  const isHolder = sameEntityName(session.writer, entity.name);
  if (session.writer && !isHolder && !isOwner) {
    ctx.send(
      eid,
      `Only ${session.writer} (current holder) or ${session.created_by} (session creator) can reassign the write lock.`,
    );
    return;
  }
  reassignWriter(ctx, eid, entity, deps, session, target, "manual_reassign");
}

/**
 * Set the session writer to `newWriter`, emit a `writer_changed` event +
 * artifact, and announce. Shared by `code writer <agent>` and `code handoff
 * <notes> to <agent>`.
 */
export function reassignWriter(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  newWriter: string,
  reason: string,
): void {
  const previousWriter = session.writer ?? null;
  // Store the entity-name form so the write-lock guards match at apply time.
  newWriter = entityNameForm(newWriter);
  deps.db.updateCodingSession(session.id, { writer: newWriter });
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "writer_changed",
    title: `Write lock: ${newWriter}`,
    status: "active",
    contentText: `Write lock reassigned to ${newWriter}${
      previousWriter ? ` (was ${previousWriter})` : ""
    } by ${entity.name}.`,
    metadata: { writer: newWriter, previousWriter, reassignedBy: entity.name, reason },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "writer_changed",
    payload: { id: artifact.id, writer: newWriter, previousWriter, reason },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Write lock now held by ${newWriter}.`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: ["code writer", "code status"],
    event: "writer_changed",
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "session",
    workspace: session.workspace_root,
  });
}
