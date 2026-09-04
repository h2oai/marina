// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CrewManager — runtime container for multi-agent coordination.
 *
 * Crews compose existing primitives (agents, channels, pools, formations)
 * rather than replacing them. Ephemeral by default — they live in memory and
 * GC on idle. Persisted crews are DB-backed (migration 38) and survive
 * restarts; loadFromDb() rehydrates them on engine boot.
 */

import { record as recordStanding } from "../agent/standing";
import type { MarinaDB } from "../persistence/database";
import type { CrewMemberRow, CrewRow } from "../persistence/db-crews";
import type {
  Crew,
  CrewFormation,
  CrewId,
  CrewInvitation,
  CrewLifetime,
  CrewMember,
  CrewState,
  EngineEvent,
  EntityId,
} from "../types";
import { crewId as toCrewId, entityId as toEntityId } from "../types";
import { normalizePatternName } from "../world/templates/orchestration";
import type { ChannelManager } from "./channel-manager";
import {
  buildFormationBrief,
  getFormationMediator,
  type MediatorCrewView,
} from "./crew-formations";

/** Ephemeral crews idle longer than this get auto-dissolved. */
const IDLE_GC_MS = 10 * 60 * 1000;

/** Soft cap on active ephemeral crews per owner. Higher ranks can override. */
export const DEFAULT_EPHEMERAL_CAP = 5;

/** Soft cap on active persisted crews per owner. */
export const DEFAULT_PERSISTED_CAP = 2;

export interface CrewManagerDeps {
  channels: ChannelManager;
  /** Optional db — only persisted crews touch it. Without db, all crews are ephemeral. */
  db?: MarinaDB;
  /** Wired by Engine. Used for lifecycle event emission. */
  onEvent?: (event: EngineEvent) => void;
  /** Pluggable clock — tests inject `Date.now()` substitutes. */
  now?: () => number;
  /**
   * Resolve an agent's name to its entity id. Used to credit standing on
   * crew completion (Standing is keyed by entity id; CrewMember holds
   * names). Returning undefined skips the credit silently.
   */
  resolveAgentId?: (agentName: string) => string | undefined;
}

export interface CreateCrewOpts {
  name: string;
  goal: string;
  formation?: CrewFormation;
  lifetime?: CrewLifetime;
  owner: EntityId;
  members: { agentName: string; role?: string }[];
}

export class CrewError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "duplicate_name"
      | "not_found"
      | "no_members"
      | "cap_exceeded"
      | "not_member"
      | "already_member"
      | "dissolved"
      | "not_persisted"
      | "already_persisted"
      | "invitation_required"
      | "invitation_expired"
      | "invitation_not_found",
  ) {
    super(message);
  }
}

export class CrewManager {
  private readonly channels: ChannelManager;
  private readonly db: MarinaDB | undefined;
  private readonly emit: (event: EngineEvent) => void;
  private readonly now: () => number;
  private readonly resolveAgentId: (agentName: string) => string | undefined;

  private readonly crews = new Map<CrewId, Crew>();
  private readonly byName = new Map<string, CrewId>();
  private readonly byMember = new Map<string /* agentName */, Set<CrewId>>();
  private readonly byOwner = new Map<EntityId, Set<CrewId>>();
  private readonly invitations = new Map<string, CrewInvitation>();
  /** Per-(crew,member) stall offense counter. Standing only debits at >= 3. */
  private readonly memberOffenses = new Map<string, number>();

  constructor(deps: CrewManagerDeps) {
    this.channels = deps.channels;
    this.db = deps.db;
    this.emit = deps.onEvent ?? (() => {});
    this.now = deps.now ?? (() => Date.now());
    this.resolveAgentId = deps.resolveAgentId ?? (() => undefined);
  }

  /**
   * Reattach persisted crews on engine boot. Idempotent — safe to call once
   * per startup. Skips crews already in memory (e.g. seeded by a world).
   */
  loadFromDb(): number {
    if (!this.db) return 0;
    const rows = this.db.getAllCrews();
    let loaded = 0;
    for (const row of rows) {
      if (this.crews.has(toCrewId(row.id))) continue;
      const crew = this.crewFromRow(row, this.db.getCrewMembers(row.id));
      this.indexCrew(crew);
      loaded++;
    }
    for (const row of this.db.getOpenCrewInvitations()) {
      if (!this.crews.has(toCrewId(row.crew_id))) continue;
      this.invitations.set(`${row.crew_id}:${row.agent_name.toLowerCase()}`, {
        crewId: toCrewId(row.crew_id),
        crewName: row.crew_name,
        agentName: row.agent_name,
        role: row.role,
        invitedBy: row.invited_by,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        ...(row.responded_at === null ? {} : { respondedAt: row.responded_at }),
      });
    }
    return loaded;
  }

  // ─── Lookup ────────────────────────────────────────────────────────────────

  get(id: CrewId): Crew | undefined {
    return this.crews.get(id);
  }

  getByName(name: string): Crew | undefined {
    const id = this.byName.get(name);
    return id ? this.crews.get(id) : undefined;
  }

  list(): Crew[] {
    return [...this.crews.values()];
  }

  invite(
    crewId: CrewId,
    agentName: string,
    invitedBy: string,
    role = "specialist",
    ttlMs = 24 * 60 * 60 * 1000,
  ): CrewInvitation {
    const crew = this.requireCrew(crewId);
    if (crew.members.some((member) => member.agentName === agentName)) {
      throw new CrewError(`${agentName} is already a member of ${crew.name}`, "already_member");
    }
    const now = this.now();
    const invitation: CrewInvitation = {
      crewId,
      crewName: crew.name,
      agentName,
      role,
      invitedBy,
      status: "pending",
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    this.invitations.set(`${crewId}:${agentName.toLowerCase()}`, invitation);
    this.persistInvitation(invitation);
    return invitation;
  }

  invitationsFor(agentName: string): CrewInvitation[] {
    const now = this.now();
    const rows: CrewInvitation[] = [];
    for (const invitation of this.invitations.values()) {
      if (invitation.status === "pending" && invitation.expiresAt <= now) {
        invitation.status = "expired";
        invitation.respondedAt = now;
        this.persistInvitation(invitation);
      }
      if (invitation.agentName.toLowerCase() === agentName.toLowerCase()) rows.push(invitation);
    }
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  }

  respondToInvitation(
    crewId: CrewId,
    agentName: string,
    response: "accepted" | "declined",
  ): CrewInvitation {
    const key = `${crewId}:${agentName.toLowerCase()}`;
    const invitation = this.invitations.get(key);
    if (invitation?.status !== "pending") {
      throw new CrewError("No pending invitation found", "invitation_not_found");
    }
    const now = this.now();
    if (invitation.expiresAt <= now) {
      invitation.status = "expired";
      invitation.respondedAt = now;
      this.persistInvitation(invitation);
      throw new CrewError("Crew invitation has expired", "invitation_expired");
    }
    invitation.status = response;
    invitation.respondedAt = now;
    this.persistInvitation(invitation);
    if (response === "accepted") this.addMember(crewId, agentName, invitation.role);
    return invitation;
  }

  /** Active crews this agent is a member of. Used by brief integration. */
  forAgent(agentName: string): Crew[] {
    const ids = this.byMember.get(agentName);
    if (!ids) return [];
    const out: Crew[] = [];
    for (const id of ids) {
      const c = this.crews.get(id);
      if (c && c.state !== "dissolved") out.push(c);
    }
    return out;
  }

  forOwner(ownerId: EntityId): Crew[] {
    const ids = this.byOwner.get(ownerId);
    if (!ids) return [];
    return [...ids].map((id) => this.crews.get(id)).filter((c): c is Crew => c !== undefined);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  create(opts: CreateCrewOpts): Crew {
    const name = opts.name.trim();
    if (!name) throw new CrewError("Crew name is required", "no_members");
    if (this.byName.has(name)) {
      throw new CrewError(`Crew "${name}" already exists`, "duplicate_name");
    }
    if (opts.members.length === 0) {
      throw new CrewError("Crew needs at least one member", "no_members");
    }

    const lifetime: CrewLifetime = opts.lifetime ?? "ephemeral";
    const cap = lifetime === "persisted" ? DEFAULT_PERSISTED_CAP : DEFAULT_EPHEMERAL_CAP;
    const existing = (this.byOwner.get(opts.owner) ?? new Set()).size;
    if (existing >= cap) {
      throw new CrewError(
        `Owner already has ${existing} active ${lifetime} crews (cap: ${cap}). Dissolve one first.`,
        "cap_exceeded",
      );
    }

    const id = toCrewId(`crew-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`);
    const now = this.now();
    const members: CrewMember[] = opts.members.map((m) => ({
      agentName: m.agentName,
      role: m.role ?? "specialist",
      joinedAt: now,
    }));

    const crew: Crew = {
      id,
      name,
      goal: opts.goal,
      formation: opts.formation ?? "freeform",
      lifetime,
      ownerId: opts.owner,
      members,
      state: "assembling",
      createdAt: now,
      lastActivityAt: now,
    };

    this.indexCrew(crew);
    if (lifetime === "persisted") {
      this.provisionCrewPool(crew);
      this.persistRow(crew);
      if (this.db) {
        for (const m of members) {
          this.db.addCrewMember(id, m.agentName, m.role, m.joinedAt);
        }
      }
    }

    this.emit({
      type: "crew_created",
      crew: id,
      name,
      owner: opts.owner,
      formation: crew.formation,
      lifetime,
      timestamp: now,
    });
    for (const m of members) {
      this.emit({
        type: "crew_member_joined",
        crew: id,
        agentName: m.agentName,
        role: m.role,
        timestamp: now,
      });
    }
    return crew;
  }

  /**
   * Activate the crew and post the goal to its channel. First call lazily
   * creates the `crew:<id>` channel, posts the formation brief, then the
   * dispatch message. Idempotent on re-dispatch — appends a new message but
   * does not duplicate channel/membership setup or re-post the brief.
   */
  dispatch(
    id: CrewId,
    message: string,
    sender?: { id: string; name: string },
    opts?: { beforeFirstPost?: (crew: Crew) => void },
  ): void {
    const crew = this.requireCrew(id);
    if (crew.state === "dissolved") {
      throw new CrewError(`Crew ${crew.name} is dissolved`, "dissolved");
    }

    const firstActivation = !crew.channelId;
    if (firstActivation) {
      const channel = this.channels.createChannel({
        type: "crew",
        name: crew.id,
        ownerId: crew.ownerId,
      });
      crew.channelId = channel.id;
      // Members get added by name lookup at the engine layer where we know
      // EntityIds. The manager keeps EntityId-agnostic member refs — engine
      // wiring resolves agentName → EntityId before joining.
      opts?.beforeFirstPost?.(crew);
    }

    if (firstActivation) {
      this.postFormationBrief(crew);
    }

    this.transition(crew, "active");
    this.channels.send(
      crew.channelId!,
      sender?.id ?? "__crew_manager__",
      sender?.name ?? "crew",
      message,
    );
    this.postMediatorNudge(crew, (m, view) => m.onDispatch?.(view, message));
    this.touch(crew);
    this.persistRow(crew);
  }

  /** Minimal crew view handed to formation mediators. */
  private mediatorView(crew: Crew): MediatorCrewView {
    return {
      name: crew.name,
      goal: crew.goal,
      memberNames: crew.members.map((m) => m.agentName),
      leadName: crew.members.find((m) => m.role === "lead")?.agentName,
    };
  }

  /**
   * Formation mediation (Phase 4): deterministic event-driven nudges. At most
   * one `[formation-mediator]` line per crew event, posted on the crew
   * channel. Silent when the formation has no mediator, the hook returns
   * nothing, or the channel isn't provisioned yet.
   */
  private postMediatorNudge(
    crew: Crew,
    pick: (
      mediator: NonNullable<ReturnType<typeof getFormationMediator>>,
      view: MediatorCrewView,
    ) => string | undefined,
  ): void {
    if (!crew.channelId) return;
    const mediator = getFormationMediator(crew.formation);
    if (!mediator) return;
    const nudge = pick(mediator, this.mediatorView(crew));
    if (!nudge) return;
    this.channels.send(crew.channelId, "__crew_manager__", "crew", `[formation-mediator] ${nudge}`);
  }

  /**
   * Change the formation. If the crew is already active, re-posts the
   * formation brief so members see the new shape.
   */
  setFormation(id: CrewId, formation: CrewFormation): void {
    const crew = this.requireCrew(id);
    if (crew.state === "dissolved") {
      throw new CrewError(`Crew ${crew.name} is dissolved`, "dissolved");
    }
    if (crew.formation === formation) return;
    crew.formation = formation;
    this.touch(crew);
    if (crew.channelId) this.postFormationBrief(crew);
    this.persistRow(crew);
  }

  /** Post the formation brief to the crew channel (no-op if no channel). */
  private postFormationBrief(crew: Crew): void {
    if (!crew.channelId) return;
    const brief = buildFormationBrief(crew.formation, crew.goal);
    this.channels.send(crew.channelId, "__crew_manager__", "crew", brief);
  }

  addMember(id: CrewId, agentName: string, role = "specialist"): CrewMember {
    const crew = this.requireCrew(id);
    if (crew.state === "dissolved") {
      throw new CrewError(`Crew ${crew.name} is dissolved`, "dissolved");
    }
    if (crew.members.some((m) => m.agentName === agentName)) {
      throw new CrewError(`${agentName} is already a member of ${crew.name}`, "already_member");
    }
    const member: CrewMember = { agentName, role, joinedAt: this.now() };
    crew.members.push(member);
    this.indexMember(agentName, id);
    this.touch(crew);
    if (crew.lifetime === "persisted" && this.db) {
      this.db.addCrewMember(crew.id, agentName, role, member.joinedAt);
      this.persistRow(crew);
    }
    this.emit({
      type: "crew_member_joined",
      crew: id,
      agentName,
      role,
      timestamp: member.joinedAt,
    });
    // Orientation ritual: post a brief on the crew channel summarizing
    // accumulated wisdom (this crew's pool + the formation tradition pool)
    // and the roster's standings. Skipped if the channel hasn't been
    // provisioned yet — the formation brief on first dispatch covers it.
    if (crew.channelId) this.postOrientation(crew, member);
    return member;
  }

  removeMember(id: CrewId, agentName: string, reason: "left" | "stopped" | "kicked"): void {
    const crew = this.requireCrew(id);
    const before = crew.members.length;
    crew.members = crew.members.filter((m) => m.agentName !== agentName);
    if (crew.members.length === before) {
      throw new CrewError(`${agentName} is not a member of ${crew.name}`, "not_member");
    }
    this.deindexMember(agentName, id);
    this.touch(crew);
    if (crew.lifetime === "persisted" && this.db) {
      this.db.removeCrewMember(crew.id, agentName);
      this.persistRow(crew);
    }
    this.emit({
      type: "crew_member_left",
      crew: id,
      agentName,
      reason,
      timestamp: this.now(),
    });
    // Auto-dissolve when no members remain.
    if (crew.members.length === 0 && crew.state !== "dissolved") {
      this.dissolve(id, "no members remain");
    }
  }

  dissolve(id: CrewId, reason: string): void {
    const crew = this.requireCrew(id);
    if (crew.state === "dissolved") return;

    this.transition(crew, "dissolved");
    this.byName.delete(crew.name);
    for (const m of crew.members) {
      this.deindexMember(m.agentName, id);
      this.memberOffenses.delete(`${id}:${m.agentName}`);
    }
    const ownerSet = this.byOwner.get(crew.ownerId);
    if (ownerSet) {
      ownerSet.delete(id);
      if (ownerSet.size === 0) this.byOwner.delete(crew.ownerId);
    }
    if (crew.lifetime === "persisted" && this.db) {
      this.db.deleteCrew(crew.id);
    }
    if (this.db) this.db.deleteCrewInvitations(crew.id);
    for (const key of this.invitations.keys()) {
      if (key.startsWith(`${crew.id}:`)) this.invitations.delete(key);
    }
    this.emit({
      type: "crew_dissolved",
      crew: id,
      reason,
      timestamp: this.now(),
    });
    // Keep the row in `crews` map briefly so listeners can still resolve the id;
    // tick() will drop it next pass.
  }

  /**
   * Upgrade an ephemeral crew to persisted. Caps already enforced on create;
   * we re-check on upgrade to avoid bypassing them via the upgrade path.
   * Auto-creates a `crew:<name>` memory pool if one doesn't exist.
   */
  persist(id: CrewId): void {
    const crew = this.requireCrew(id);
    if (crew.state === "dissolved") {
      throw new CrewError(`Crew ${crew.name} is dissolved`, "dissolved");
    }
    if (crew.lifetime === "persisted") {
      throw new CrewError(`Crew ${crew.name} is already persisted`, "already_persisted");
    }
    if (!this.db) {
      throw new CrewError("Persistence requires a DB", "not_persisted");
    }

    const persisted = this.forOwner(crew.ownerId).filter((c) => c.lifetime === "persisted").length;
    if (persisted >= DEFAULT_PERSISTED_CAP) {
      throw new CrewError(
        `Owner already has ${persisted} persisted crews (cap: ${DEFAULT_PERSISTED_CAP}). Dissolve one first.`,
        "cap_exceeded",
      );
    }

    crew.lifetime = "persisted";
    this.provisionCrewPool(crew);
    this.persistRow(crew);
    for (const m of crew.members) {
      this.db.addCrewMember(crew.id, m.agentName, m.role, m.joinedAt);
    }
  }

  /** Auto-create the `crew:<name>` memory pool if missing. Pool id includes
   *  a timestamp suffix to avoid collisions with a previously dissolved
   *  same-named crew. No-op without db or for a non-persisted crew. */
  private provisionCrewPool(crew: Crew): void {
    if (!this.db || crew.lifetime !== "persisted") return;
    const poolName = `crew:${crew.name}`;
    let poolRow = this.db.getMemoryPool(poolName);
    if (!poolRow) {
      const poolId = `pool_${crew.name}_${this.now()}`;
      this.db.createMemoryPool(poolId, poolName, String(crew.ownerId));
      poolRow = this.db.getMemoryPool(poolName);
    }
    crew.poolId = poolRow?.id;
  }

  /**
   * Mark the crew completing, write a result note, then transition to
   * dissolved on the next tick. Result lands in the crew pool (persisted) or
   * the owner's notes (ephemeral). Members can recall it via the standard
   * note paths — no special crew_results surface.
   */
  complete(id: CrewId, summary: string, ownerName: string): { resultNoteId?: number } {
    const crew = this.requireCrew(id);
    if (crew.state === "dissolved") {
      throw new CrewError(`Crew ${crew.name} is dissolved`, "dissolved");
    }
    const text = summary.trim();
    if (!text) throw new CrewError("Result summary required", "no_members");

    let noteId: number | undefined;
    const noteIds: number[] = [];
    if (this.db) {
      const content = `[crew:${crew.name}] ${text}`;
      try {
        if (crew.lifetime === "persisted" && crew.poolId) {
          noteId = this.db.addPoolNote(crew.poolId, ownerName, content, 7, "reflection");
        } else {
          noteId = this.db.createNote(ownerName, content, undefined, {
            importance: 7,
            noteType: "reflection",
          });
        }
        if (noteId) noteIds.push(noteId);
      } catch {
        // Result-note write is non-critical — dissolution still proceeds.
      }
      // Tradition pool deposit: feed the formation's collective wisdom so
      // future crews running the same shape inherit what worked here. The
      // 10 seeded patterns are version 0; emergent patterns grow this way.
      if (crew.formation !== "freeform") {
        try {
          const traditionPoolName = `orchestration:${crew.formation}`;
          let pool = this.db.getMemoryPool(traditionPoolName);
          if (!pool) {
            const poolId = `pool_${traditionPoolName.replace(":", "_")}_${this.now()}`;
            this.db.createMemoryPool(poolId, traditionPoolName, "system");
            pool = this.db.getMemoryPool(traditionPoolName);
          }
          if (pool) {
            const provenance = `[crew:${crew.name} formation:${crew.formation}] ${text}`;
            const tnid = this.db.addPoolNote(pool.id, ownerName, provenance, 6, "reflection");
            if (tnid) noteIds.push(tnid);
          }
        } catch {
          // Tradition deposit is best-effort.
        }
      }
    }

    crew.result = { summary: text, noteIds, at: this.now() };
    this.transition(crew, "completing");
    this.persistRow(crew);

    // Credit standing to every member; the lead/owner gets the lead bonus
    // on top. Standing is keyed by entity id, so we resolve via the deps
    // callback (silent skip on unknown agents — this is best-effort civic
    // accounting, not a hard requirement).
    if (this.db) {
      for (const member of crew.members) {
        const memberId = this.resolveAgentId(member.agentName);
        if (!memberId) continue;
        recordStanding(
          this.db,
          memberId,
          member.agentName,
          "crew_complete_member",
          String(crew.id),
        );
        if (member.role === "lead" || member.agentName === ownerName) {
          recordStanding(
            this.db,
            memberId,
            member.agentName,
            "crew_complete_lead",
            String(crew.id),
          );
        }
      }
    }

    if (crew.channelId) {
      this.channels.send(
        crew.channelId,
        "__crew_manager__",
        "crew",
        `[crew:${crew.name}] complete: ${text}`,
      );
    }
    this.emit({
      type: "crew_completed",
      crew: id,
      resultNoteId: noteId,
      timestamp: this.now(),
    });
    // Dissolve immediately — completing → dissolved transition keeps the
    // ordering deterministic for listeners and avoids a tick-delay window
    // where members could keep dispatching.
    this.dissolve(id, "completed");
    return { resultNoteId: noteId };
  }

  /**
   * Mark a stage of a multi-step formation as complete. Member-only;
   * emits `crew_stage_completed` which credits standing to the agent and
   * provides a discoverable progress signal on the event log.
   */
  recordStageCompleted(id: CrewId, stage: string, agentName: string): void {
    const crew = this.requireCrew(id);
    if (crew.state === "dissolved") {
      throw new CrewError(`Crew ${crew.name} is dissolved`, "dissolved");
    }
    if (!crew.members.some((m) => m.agentName === agentName)) {
      throw new CrewError(`${agentName} is not a member of ${crew.name}`, "not_member");
    }
    this.touch(crew);
    this.persistRow(crew);
    this.emit({
      type: "crew_stage_completed",
      crew: id,
      stage,
      agentName,
      timestamp: this.now(),
    });
    this.postMediatorNudge(crew, (m, view) => m.onStageCompleted?.(view, stage, agentName));
  }

  /**
   * Record a work-product deposit (map output, reduce result, draft, etc.).
   * Member-only; emits `crew_artifact_deposited`. The civic credit lands in
   * the standing ledger via the event log → recordFromEvent path.
   */
  recordArtifactDeposit(
    id: CrewId,
    agentName: string,
    artifactRef: string,
    kind: "map" | "reduce" | "synthesis" | "draft",
  ): void {
    const crew = this.requireCrew(id);
    if (crew.state === "dissolved") {
      throw new CrewError(`Crew ${crew.name} is dissolved`, "dissolved");
    }
    if (!crew.members.some((m) => m.agentName === agentName)) {
      throw new CrewError(`${agentName} is not a member of ${crew.name}`, "not_member");
    }
    this.touch(crew);
    this.persistRow(crew);
    this.emit({
      type: "crew_artifact_deposited",
      crew: id,
      agentName,
      artifactRef,
      kind,
      timestamp: this.now(),
    });
    this.postMediatorNudge(crew, (m, view) => m.onArtifact?.(view, kind, artifactRef, agentName));
  }

  /**
   * Flag a member as having stalled. Tracks per-(crew, agent) offense count
   * in memory; only counts of >= 3 reach the standing ledger as penalties
   * (handled in standing.recordFromEvent). Earlier offenses are signal-only.
   */
  recordMemberStall(id: CrewId, agentName: string, reason: string): number {
    const crew = this.requireCrew(id);
    if (crew.state === "dissolved") {
      throw new CrewError(`Crew ${crew.name} is dissolved`, "dissolved");
    }
    if (!crew.members.some((m) => m.agentName === agentName)) {
      throw new CrewError(`${agentName} is not a member of ${crew.name}`, "not_member");
    }
    const key = `${id}:${agentName}`;
    const offenseCount = (this.memberOffenses.get(key) ?? 0) + 1;
    this.memberOffenses.set(key, offenseCount);
    this.touch(crew);
    this.emit({
      type: "crew_member_stalled",
      crew: id,
      agentName,
      reason,
      offenseCount,
      timestamp: this.now(),
    });
    return offenseCount;
  }

  /**
   * Engine tick hook. GCs ephemeral crews idle longer than IDLE_GC_MS, and
   * fully drops dissolved crews from the in-memory map.
   */
  tick(now = this.now()): void {
    for (const [id, crew] of this.crews) {
      if (crew.state === "dissolved") {
        this.crews.delete(id);
        continue;
      }
      if (crew.lifetime !== "ephemeral") continue;
      if (crew.state === "assembling") continue; // never dispatched — keep until owner acts
      if (now - crew.lastActivityAt > IDLE_GC_MS) {
        this.dissolve(id, "idle timeout");
      }
    }
  }

  /** Engine calls this when an agent stops, so we can tag departures correctly. */
  onAgentStopped(agentName: string): void {
    const ids = this.byMember.get(agentName);
    if (!ids) return;
    for (const id of [...ids]) {
      const crew = this.crews.get(id);
      if (!crew || crew.state === "dissolved") continue;
      try {
        this.removeMember(id, agentName, "stopped");
      } catch {
        // already removed elsewhere — fine
      }
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private requireCrew(id: CrewId): Crew {
    const c = this.crews.get(id);
    if (!c) throw new CrewError(`Crew ${id} not found`, "not_found");
    return c;
  }

  private transition(crew: Crew, to: CrewState): void {
    if (crew.state === to) return;
    const from = crew.state;
    crew.state = to;
    this.emit({
      type: "crew_state_changed",
      crew: crew.id,
      from,
      to,
      timestamp: this.now(),
    });
  }

  private touch(crew: Crew): void {
    crew.lastActivityAt = this.now();
  }

  private indexMember(agentName: string, id: CrewId): void {
    let set = this.byMember.get(agentName);
    if (!set) {
      set = new Set();
      this.byMember.set(agentName, set);
    }
    set.add(id);
  }

  private deindexMember(agentName: string, id: CrewId): void {
    const set = this.byMember.get(agentName);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.byMember.delete(agentName);
  }

  private indexOwner(ownerId: EntityId, id: CrewId): void {
    let set = this.byOwner.get(ownerId);
    if (!set) {
      set = new Set();
      this.byOwner.set(ownerId, set);
    }
    set.add(id);
  }

  /** Add an in-memory crew to all three indexes. */
  private indexCrew(crew: Crew): void {
    this.crews.set(crew.id, crew);
    this.byName.set(crew.name, crew.id);
    for (const m of crew.members) this.indexMember(m.agentName, crew.id);
    this.indexOwner(crew.ownerId, crew.id);
  }

  /** Write the crew row to the DB if persisted. No-op for ephemeral. */
  private persistRow(crew: Crew): void {
    if (!this.db || crew.lifetime !== "persisted") return;
    this.db.saveCrew({
      id: crew.id,
      name: crew.name,
      goal: crew.goal,
      formation: crew.formation,
      ownerId: String(crew.ownerId),
      channelId: crew.channelId,
      poolId: crew.poolId,
      state: crew.state,
      resultSummary: crew.result?.summary,
      createdAt: crew.createdAt,
      lastActivityAt: crew.lastActivityAt,
    });
  }

  /**
   * Orientation ritual: post a brief on the crew channel summarizing what
   * the new member needs to know — recent wisdom from this crew's pool,
   * what comparable crews have learned via the formation tradition pool,
   * and the standings of fellow members. Best-effort; failure is silent
   * because orientation enriches the join but isn't load-bearing.
   */
  private postOrientation(crew: Crew, member: CrewMember): void {
    if (!crew.channelId) return;
    const lines: string[] = [`[orientation:${member.agentName}]`];

    // Crew pool recall — what we've learned together (persisted crews only).
    if (this.db && crew.poolId) {
      try {
        const recent = this.db.recallPoolNotes(crew.poolId, crew.goal, {});
        const top = recent.slice(0, 5);
        if (top.length > 0) {
          lines.push("from this crew's pool:");
          for (const n of top) lines.push(`  • ${n.content}`);
        }
      } catch {
        // Skip on recall failure — orientation is best-effort.
      }
    }

    // Tradition pool recall — what comparable crews learned in this formation.
    if (this.db && crew.formation !== "freeform") {
      try {
        const traditionPool = this.db.getMemoryPool(`orchestration:${crew.formation}`);
        if (traditionPool) {
          const recent = this.db.recallPoolNotes(traditionPool.id, crew.goal, {});
          const top = recent.slice(0, 3);
          if (top.length > 0) {
            lines.push(`from ${crew.formation} tradition:`);
            for (const n of top) lines.push(`  • ${n.content}`);
          }
        }
      } catch {
        // Skip on recall failure.
      }
    }

    // Roster standings — who you're working with and how well-trusted they are.
    if (this.db && crew.members.length > 1) {
      lines.push("crewmates:");
      for (const m of crew.members) {
        if (m.agentName === member.agentName) continue;
        try {
          // Standing is keyed by entity id, not agent name. The CrewManager
          // doesn't track ids — best we can do is degrade gracefully and
          // omit standing when we can't resolve a name → id. Engine-level
          // wiring in a later phase can pass a resolver.
          lines.push(`  • ${m.agentName} (${m.role})`);
        } catch {
          lines.push(`  • ${m.agentName} (${m.role})`);
        }
      }
    }

    if (lines.length === 1) return; // nothing meaningful to surface
    this.channels.send(crew.channelId, "__crew_manager__", "crew", lines.join("\n"));
  }

  /** Reconstruct an in-memory Crew from DB rows. Legacy formation names
   * (e.g. imported snapshots predating the nsed → deliberation rename)
   * normalize here so tradition-pool deposits/recall stay canonical. */
  private crewFromRow(row: CrewRow, memberRows: CrewMemberRow[]): Crew {
    return {
      id: toCrewId(row.id),
      name: row.name,
      goal: row.goal,
      formation: normalizePatternName(row.formation) as CrewFormation,
      lifetime: "persisted",
      ownerId: toEntityId(row.owner_id),
      members: memberRows.map((m) => ({
        agentName: m.agent_name,
        role: m.role,
        joinedAt: m.joined_at,
      })),
      channelId: row.channel_id ?? undefined,
      poolId: row.pool_id ?? undefined,
      state: row.state as CrewState,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      result: row.result_summary
        ? { summary: row.result_summary, noteIds: [], at: row.last_activity_at }
        : undefined,
    };
  }

  private persistInvitation(invitation: CrewInvitation): void {
    if (!this.db) return;
    this.db.saveCrewInvitation({
      crew_id: invitation.crewId,
      crew_name: invitation.crewName,
      agent_name: invitation.agentName,
      role: invitation.role,
      invited_by: invitation.invitedBy,
      status: invitation.status,
      created_at: invitation.createdAt,
      expires_at: invitation.expiresAt,
      responded_at: invitation.respondedAt ?? null,
    });
  }
}
