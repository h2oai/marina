// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "../engine/logger";
import type { MarinaStores } from "../persistence/interfaces";
import { formatResidentLabel } from "../sdk/resident-label";
import type {
  ResidentAttentionReport,
  ResidentCredential,
  ResidentEnrolInput,
  ResidentEnrolment,
} from "../sdk/routing-runtime-types";
import type { RoutingSession } from "../sdk/routing-types";
import type { EngineEvent } from "../types";
import { RoutingError } from "./errors";
import { generateResidentName, residentNameProblem } from "./resident-name";

const log = new Logger();

/** Longest a resident credential lives; renewal mints the next one. */
export const RESIDENT_CREDENTIAL_TTL_MS = 24 * 60 * 60_000;

/**
 * `MARINA_SUPERVISED_RESIDENTS=on|off` (default off). On, every agent a local
 * routing supervisor launches is enrolled as its own world account, owned by
 * the launching person. Off, routing behaves exactly as before: no resident
 * endpoints, no accounts, the supervisor passes its own credential through.
 */
export function supervisedResidentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MARINA_SUPERVISED_RESIDENTS?.trim().toLowerCase();
  return raw === "on" || raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Display labels for world rosters: `Wren [claude]` for a supervised resident,
 * the plain name for everyone else. Off it returns the name and reads
 * nothing, so rosters render exactly as before.
 */
export function residentLabeler(
  db: Pick<MarinaStores, "getAgentConfig"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ((name: string) => string) | undefined {
  if (!db) return undefined;
  return (name) => {
    if (!supervisedResidentsEnabled(env)) return name;
    const config = db.getAgentConfig(name);
    return config?.runtime === "supervised" ? formatResidentLabel(name, config.vendor) : name;
  };
}

type Store = Pick<
  MarinaStores,
  | "transaction"
  | "getUser"
  | "getUserByName"
  | "getUserNamesIgnoringCase"
  | "isBanned"
  | "getAgentConfig"
  | "saveAgentConfig"
  | "setAgentRunSession"
  | "getPrincipal"
  | "ensurePrincipal"
  | "issueWorkloadCredential"
  | "revokeWorkloadCredentialsFor"
  | "getRoutingSession"
  | "recordAttentionWakes"
>;

/** The live world, as enrolment needs it (an `Engine` provides every member). */
export interface ResidentWorld {
  /** A live entity with exactly this name, connected or not. */
  findLive(name: string): { id: string } | undefined;
  isConnected(entityId: string): boolean;
  hasRoom(room: string): boolean;
  /** The caller's current room, when the caller is in the world. */
  roomOf(entityId: string): string | undefined;
  /** Why the caller may not enter `room` (a private room), or null. */
  entryRefusal?(entityId: string, room: string): string | null;
  /** End the account's session tokens (a stopped resident cannot reconnect). */
  revokeSessions(entityId: string): void;
  /** Emit a content-free engine event (attention bridge reports). */
  logEvent?(event: EngineEvent): void;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RoutingError(400, "invalid_input", "Expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 128): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new RoutingError(
      400,
      "invalid_input",
      `${field} must be a nonempty string of at most ${max} characters`,
    );
  return value;
}

const NAME_TAKEN = "That name belongs to another account; choose another";

const WAKE_DECISIONS = new Set(["now", "next", "context", "drop"]);
const RESIDENT_STATUSES = new Set([
  "starting",
  "idle",
  "running",
  "waiting",
  "stopped",
  "failed",
  "disconnected",
]);
const STEER_KINDS = new Set(["mid-turn", "next-turn", "none"]);
type ResidentAttentionStatus = NonNullable<ResidentAttentionReport["status"]>["status"];

/** A short machine token (a source or reason name), never free text. */
function token(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value))
    throw new RoutingError(400, "invalid_input", `${field} must be a short lower-case token`);
  return value;
}

/**
 * Supervised-resident accounts. Every call is attributed to the durable world
 * account of the caller, which must be a person: an agent never enrols,
 * renews or revokes another agent. Authorization of the safety gate
 * (`agent.spawn` for enrolment) is the HTTP route's job, before this runs.
 */
export class ResidentService {
  private readonly ownerName: string;
  constructor(
    private readonly db: Store,
    private readonly ownerKey: string,
    private readonly callerId: string,
    private readonly world: ResidentWorld,
    private readonly options: { ttlMs?: number } = {},
  ) {
    const account = db.getUser(ownerKey);
    if (!account)
      throw new RoutingError(403, "account_required", "Log in with a Marina account first");
    // People own residents. An agent account (config or principal) is refused.
    if (db.getAgentConfig(account.name) || db.getPrincipal("agent", account.name))
      throw new RoutingError(403, "person_required", "Only a person may launch residents");
    this.ownerName = account.name;
  }

  /** The caller's own active run session, never the supervisor's. */
  private run(sessionId: string): RoutingSession {
    const session = this.db.getRoutingSession(sessionId);
    if (!session || session.ownerId !== this.ownerKey)
      throw new RoutingError(404, "not_found", "Participant session not found");
    if (session.state !== "active")
      throw new RoutingError(409, "session_left", "Rejoin this session first");
    if (session.kind === "supervisor" || !/^[a-z][a-z0-9_-]{0,31}$/.test(session.kind))
      throw new RoutingError(400, "invalid_input", "Session is not an agent run");
    return session;
  }

  /** The caller's supervised resident `name`, or a 404 that reveals nothing. */
  private owned(name: string) {
    const config = this.db.getAgentConfig(name);
    if (config?.runtime !== "supervised" || config.spawned_by !== this.ownerName)
      throw new RoutingError(404, "not_found", "Resident not found");
    return config;
  }

  /**
   * The resident's agent principal. Inside a write transaction it must be
   * read through the writer (`ensurePrincipal` returns the existing row the
   * config save just made); the read connection would not see it yet.
   */
  private principalOf(name: string, justSaved = false) {
    const principal = justSaved
      ? this.db.ensurePrincipal({ type: "agent", displayName: name })
      : this.db.getPrincipal("agent", name);
    if (!principal || principal.display_name !== name)
      throw new RoutingError(409, "name_taken", NAME_TAKEN);
    if (principal.status !== "active")
      throw new RoutingError(403, "identity_inactive", `This identity is ${principal.status}`);
    return principal;
  }

  /**
   * Whether `name` may become (or stay) this owner's resident: `reuse` for the
   * owner's own supervised account, `new` for a name nobody holds, otherwise
   * the reason it is refused. Case variants of an existing account are refused.
   */
  private claim(name: string): "new" | "reuse" | RoutingError {
    if (this.db.isBanned(name)) return new RoutingError(403, "banned", "That name is banned");
    const config = this.db.getAgentConfig(name);
    const principal = this.db.getPrincipal("agent", name);
    const users = this.db.getUserNamesIgnoringCase(name);
    if (principal && principal.display_name !== name)
      return new RoutingError(409, "name_taken", NAME_TAKEN);
    if (users.some((user) => user !== name)) return new RoutingError(409, "name_taken", NAME_TAKEN);
    let verdict: "new" | "reuse";
    if (config) {
      if (config.runtime !== "supervised" || config.spawned_by !== this.ownerName)
        return new RoutingError(409, "name_taken", NAME_TAKEN);
      verdict = "reuse";
    } else if (principal) {
      // An agent identity whose config was deleted: only its owner may reuse it.
      const owner = this.db.getPrincipal("human", this.ownerName);
      if (!owner || principal.owner_principal_id !== owner.principal_id)
        return new RoutingError(409, "name_taken", NAME_TAKEN);
      verdict = "reuse";
    } else if (users.length) {
      // A person's (or any other) account: never handed to an agent credential.
      return new RoutingError(409, "name_taken", NAME_TAKEN);
    } else verdict = "new";
    const live = this.world.findLive(name);
    if (live && verdict === "new") return new RoutingError(409, "name_taken", NAME_TAKEN);
    if (live && this.world.isConnected(live.id))
      return new RoutingError(
        409,
        "resident_connected",
        "That resident is connected; stop its run before launching it again",
      );
    return verdict;
  }

  private issue(principalId: string): ResidentCredential {
    const issued = this.db.issueWorkloadCredential(
      principalId,
      Math.min(this.options.ttlMs ?? RESIDENT_CREDENTIAL_TTL_MS, RESIDENT_CREDENTIAL_TTL_MS),
    );
    return { token: issued.token, expiresAt: issued.expiresAt };
  }

  enrol(value: unknown): ResidentEnrolment {
    const input = object(value) as Partial<ResidentEnrolInput>;
    const session = this.run(text(input.sessionId, "sessionId"));
    const vendor = session.kind;
    const room = input.room === undefined ? undefined : text(input.room, "room");
    if (room !== undefined && !this.world.hasRoom(room))
      throw new RoutingError(400, "unknown_room", "No such room");
    // A resident shares its owner's invites, so it may launch only where the owner may go.
    const refusal =
      room === undefined ? null : (this.world.entryRefusal?.(this.callerId, room) ?? null);
    if (refusal) throw new RoutingError(403, "room_private", refusal);
    let name: string;
    if (input.name !== undefined) {
      name = text(input.name, "name", 64);
      const problem = residentNameProblem(name);
      if (problem) throw new RoutingError(400, "invalid_name", problem);
    } else {
      const fresh = generateResidentName(vendor, (candidate) => this.claim(candidate) !== "new");
      if (!fresh) throw new RoutingError(409, "name_taken", "No free resident name; pass one");
      name = fresh;
    }
    const arrival = room ?? this.world.roomOf(this.callerId);
    const result = this.db.transaction(() => {
      const verdict = this.claim(name);
      if (verdict instanceof RoutingError) throw verdict;
      // Config row and owned agent principal commit together (saveAgentConfig).
      this.db.saveAgentConfig({
        name,
        model: `supervised:${vendor}`,
        spawnedBy: this.ownerName,
        runtime: "supervised",
        vendor,
        room: arrival ?? "",
      });
      const principal = this.principalOf(name, true);
      // At most one live credential per resident: a relaunch ends the old one.
      this.db.revokeWorkloadCredentialsFor(principal.principal_id);
      this.db.setAgentRunSession(name, session.id);
      return { reused: verdict === "reuse", credential: this.issue(principal.principal_id) };
    });
    log.info("routing", "Supervised resident enrolled", {
      name,
      owner: this.ownerName,
      vendor,
      session: session.id,
      reused: result.reused,
    });
    const saved = this.db.getAgentConfig(name);
    return {
      name,
      vendor,
      ...(arrival ? { room: arrival } : {}),
      ...result,
      ...(saved
        ? {
            attention: {
              mode: saved.attention_mode,
              threshold: saved.attention_threshold,
              relay: saved.attention_relay ?? "all",
            },
          }
        : {}),
    };
  }

  /** A fresh credential for a live run the caller owns; the previous one is revoked. */
  renew(name: string, value: unknown): { name: string; credential: ResidentCredential } {
    const input = object(value);
    const config = this.owned(name);
    const session = this.run(text(input.sessionId, "sessionId"));
    if (config.run_session !== session.id)
      throw new RoutingError(409, "run_mismatch", "This run no longer holds the resident");
    const principal = this.principalOf(name);
    const credential = this.db.transaction(() => {
      this.db.revokeWorkloadCredentialsFor(principal.principal_id);
      return this.issue(principal.principal_id);
    });
    log.info("routing", "Supervised resident credential renewed", {
      name,
      owner: this.ownerName,
      session: session.id,
    });
    return { name, credential };
  }

  /**
   * Record what the run's attention bridge decided (refs and reasons, never
   * content) and the resident's presence. Only the run that holds the
   * resident reports; each kept decision and each presence change becomes one
   * content-free engine event (`attention_wake`, `agent_status`).
   */
  attention(name: string, value: unknown): { name: string; recorded: number } {
    const input = object(value) as Partial<ResidentAttentionReport>;
    const config = this.owned(name);
    const session = this.run(text(input.sessionId, "sessionId"));
    if (config.run_session !== session.id)
      throw new RoutingError(409, "run_mismatch", "This run no longer holds the resident");
    const raw = input.wakes ?? [];
    if (!Array.isArray(raw) || raw.length > 100)
      throw new RoutingError(400, "invalid_input", "At most 100 wakes per report");
    const wakes = raw.map((entry) => {
      const wake = object(entry);
      const decision = String(wake.decision);
      if (!WAKE_DECISIONS.has(decision))
        throw new RoutingError(400, "invalid_input", "Unknown wake decision");
      const ref = wake.ref === undefined ? undefined : text(wake.ref, "ref", 128);
      const hop = Number(wake.hop);
      const at = Number(wake.at);
      return {
        entity: name,
        ...(ref ? { perceptionRef: ref } : {}),
        source: token(wake.source, "source"),
        decision,
        reason: token(wake.reason, "reason"),
        hop: Number.isFinite(hop) ? Math.max(0, Math.min(1_000_000, Math.floor(hop))) : 0,
        steered: wake.steered === true,
        at: Number.isFinite(at) && at > 0 ? Math.floor(at) : Date.now(),
      };
    });
    if (wakes.length) this.db.recordAttentionWakes(wakes);
    for (const wake of wakes)
      if (wake.decision !== "drop")
        this.world.logEvent?.({
          type: "attention_wake",
          name,
          source: wake.source,
          decision: wake.decision as "now" | "next" | "context",
          steered: wake.steered,
          timestamp: wake.at,
        });
    if (input.status !== undefined) {
      const status = object(input.status);
      const state = String(status.status);
      const steer = String(status.steer);
      if (!RESIDENT_STATUSES.has(state) || !STEER_KINDS.has(steer))
        throw new RoutingError(400, "invalid_input", "Unknown resident status");
      this.world.logEvent?.({
        type: "agent_status",
        name,
        status: state as ResidentAttentionStatus,
        steer: steer as "mid-turn" | "next-turn" | "none",
        timestamp: Date.now(),
      });
    }
    return { name, recorded: wakes.length };
  }

  /**
   * End a run's hold on the resident: revoke its credentials and session
   * tokens. A run that no longer holds the resident (it was relaunched
   * elsewhere) revokes nothing, so a late stop never ends the newer run.
   */
  revoke(name: string, value: unknown): { name: string; revoked: number } {
    const input = object(value);
    const config = this.owned(name);
    const sessionId = text(input.sessionId, "sessionId");
    const session = this.db.getRoutingSession(sessionId);
    if (!session || session.ownerId !== this.ownerKey)
      throw new RoutingError(404, "not_found", "Participant session not found");
    if (config.run_session !== sessionId) return { name, revoked: 0 };
    const principal = this.db.getPrincipal("agent", name);
    const revoked = this.db.transaction(() => {
      const count = principal ? this.db.revokeWorkloadCredentialsFor(principal.principal_id) : 0;
      this.db.setAgentRunSession(name, null);
      return count;
    });
    const live = this.world.findLive(name);
    if (live) this.world.revokeSessions(live.id);
    log.info("routing", "Supervised resident revoked", {
      name,
      owner: this.ownerName,
      session: sessionId,
      revoked,
    });
    return { name, revoked };
  }
}
