// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RateLimiter } from "../auth/rate-limiter";
import { secretsEqual } from "../auth/secret-compare";
import type { SessionManager } from "../auth/session-manager";
import { disconnects } from "../net/ansi";
import type { MarinaDB } from "../persistence/database";
import type { EngineEvent, Entity, EntityId, EntityRank, RoomContext, RoomId } from "../types";
import type { EntityManager } from "../world/entity-manager";
import type { WorldDefinition } from "../world/world-definition";
import type { BriefManager } from "./brief-manager";
import { isLoopbackConnection } from "./commands/code";
import type { ConnectionManager } from "./connection-manager";
import { sanitizeEntityName } from "./entity-name";
import { tryLog } from "./errors";
import type { Logger } from "./logger";
import { setRank } from "./permissions";
import { grantGatesForRank } from "./safety-gates";
import { isLocalProfile, isLocalUngated } from "./trust-profile";

/** Identity already verified by the external authentication bridge. */
export interface LoginIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
}
export type LoginResult = { entityId: EntityId; name: string; token: string } | { error: string };

/** World lifecycle stays with the host; this coordinator owns authentication policy and sessions. */
export interface AuthHost {
  readonly config: { internalAuthToken?: string; authRequired?: boolean; maxLogins?: number };
  readonly db?: MarinaDB;
  readonly sessionManager?: Pick<SessionManager, "create" | "validate" | "refresh" | "revoke">;
  readonly loginRateLimiter?: Pick<RateLimiter, "consume">;
  readonly connections: Pick<
    ConnectionManager,
    "get" | "bindEntity" | "unbindEntity" | "isEntityConnected" | "boundExternalCount" | "remove"
  >;
  readonly entities: Pick<EntityManager, "get" | "findAgentByName" | "remove">;
  readonly briefs: Pick<BriefManager, "subscribe" | "unsubscribe">;
  readonly logger: Logger;
  readonly world?: Pick<WorldDefinition, "autoQuest" | "autoBootstrap">;
  spawnEntity(connId: string, name: string): Entity | undefined;
  processCommand(entityId: EntityId, raw: string): Promise<void>;
  buildContext(room: RoomId): RoomContext | undefined;
  logEvent(event: EngineEvent): void;
}

export interface AuthTimers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export class AuthCoordinator {
  constructor(
    private readonly host: AuthHost,
    private readonly timers: AuthTimers = { setTimeout, clearTimeout },
  ) {}

  stop(): void {
    for (const timer of this.entityEvictionTimers.values()) this.timers.clearTimeout(timer);
    this.entityEvictionTimers.clear();
  }

  /** Per-name grace-period timers — entities linger this long after WS
   * close so a token-bearing reconnect can reclaim the same EntityId. */
  private entityEvictionTimers = new Map<EntityId, ReturnType<typeof setTimeout>>();
  private static readonly RECONNECT_GRACE_MS = 60_000;

  /** Cancel a pending grace-period eviction for an entity (it's being rebound). */
  private cancelEviction(entityId: EntityId): void {
    const pending = this.entityEvictionTimers.get(entityId);
    if (pending) {
      this.timers.clearTimeout(pending);
      this.entityEvictionTimers.delete(entityId);
    }
  }

  /**
   * Tear down a connection. With `intent: "transient"` (default) the
   * entity lingers for RECONNECT_GRACE_MS so a token-bearing reconnect
   * can reclaim the same EntityId — covers WS hiccups, browser tab
   * close, and back-to-back CLI invocations. With `intent: "explicit"`
   * (quit, kick, ban) the entity is removed immediately because the
   * user/operator stated they're done.
   */
  removeConnection(connId: string, intent: "transient" | "explicit" = "transient"): void {
    const conn = this.host.connections.get(connId);
    if (!conn) return;

    if (conn.entity) {
      this.host.briefs.unsubscribe(conn.entity);
      this.host.connections.unbindEntity(conn.entity);
      const entity = this.host.entities.get(conn.entity);
      if (entity) {
        const ctx = this.host.buildContext(entity.room);
        if (ctx) {
          ctx.broadcastExcept(conn.entity, disconnects(entity.name), "disconnect");
        }
        const entityId = conn.entity;
        const entityRoom = entity.room;
        if (intent === "explicit") {
          // Cancel any pending eviction (this is a hard quit) and remove now.
          const existing = this.entityEvictionTimers.get(entityId);
          if (existing) {
            this.timers.clearTimeout(existing);
            this.entityEvictionTimers.delete(entityId);
          }
          this.emitEntityLeave(entityId, entityRoom);
          this.host.entities.remove(entityId);
        } else {
          // Transient close — schedule deferred eviction so reconnect can rebind.
          const existing = this.entityEvictionTimers.get(entityId);
          if (existing) this.timers.clearTimeout(existing);
          const timer = this.timers.setTimeout(() => {
            if (!this.host.connections.isEntityConnected(entityId)) {
              this.emitEntityLeave(entityId, entityRoom);
              this.host.entities.remove(entityId);
            }
            this.entityEvictionTimers.delete(entityId);
          }, AuthCoordinator.RECONNECT_GRACE_MS);
          this.entityEvictionTimers.set(entityId, timer);
        }
      }
    }

    this.host.connections.remove(connId);
    this.host.logEvent({ type: "disconnect", connectionId: connId, timestamp: Date.now() });
  }

  /**
   * Emit an `entity_leave` event — the symmetric counterpart to the
   * `entity_enter` fired on fresh spawn. Fires at the moment the entity is
   * actually removed from the world (not on transient disconnect, since a
   * grace-window reconnect rebinds the same id without re-emitting enter).
   */
  private emitEntityLeave(entityId: EntityId, room: RoomId): void {
    this.host.logEvent({ type: "entity_leave", entity: entityId, room, timestamp: Date.now() });
  }

  private static readonly ERR_LOGIN_RATE_LIMITED =
    "Too many login attempts. Please slow down and retry shortly.";
  private static readonly ERR_AT_CAPACITY =
    "Instance at capacity: too many concurrent logins. Try again later.";

  /** Resolve and tag whether a connection is an internal agent (room/crew
   * agents pass the process-local internal token). Internal connections are
   * exempt from the instance login cap and the login rate limit, and don't
   * consume cap slots. */
  private resolveInternal(connId: string, internalToken?: string, claimedName?: string): boolean {
    const expected = this.host.config.internalAuthToken;
    const legacy = !!expected && !!internalToken && secretsEqual(internalToken, expected);
    const workload = internalToken
      ? this.host.db?.verifyWorkloadCredential(internalToken)
      : undefined;
    const workloadMatches =
      !!workload &&
      (!claimedName || workload.display_name.toLowerCase() === claimedName.toLowerCase());
    const isInternal = legacy || workloadMatches;
    if (isInternal) {
      const conn = this.host.connections.get(connId);
      if (conn) conn.internal = true;
    }
    return isInternal;
  }

  /** Consume a login-attempt token. Keyed per client IP, falling back to the
   * connection id when IP is unknown (e.g. MCP sessions). */
  private checkLoginRate(connId: string, internal: boolean): boolean {
    if (internal || !this.host.loginRateLimiter) return true;
    const conn = this.host.connections.get(connId);
    return this.host.loginRateLimiter.consume(`login:${conn?.ip ?? connId}`);
  }

  /** True when binding one more external login would exceed MARINA_MAX_LOGINS. */
  private atLoginCapacity(internal: boolean): boolean {
    const cap = this.host.config.maxLogins ?? 0;
    if (internal || cap <= 0 || isLocalProfile()) return false;
    return this.host.connections.boundExternalCount() >= cap;
  }

  /**
   * Rank to restore for a passwordless name-login. A bare name is NOT proof of
   * identity: an untrusted passwordless login must NEVER inherit an elevated rank
   * from the persisted users row (that would let anyone re-attach to another
   * user's name and get their rank). Rank is forced to 0 until the login is
   * genuinely authenticated:
   *   - `internal` (process-local internal token — room/crew agents),
   *   - `identity` (better-auth verified subject/email), or
   *   - a genuine loopback connection (the local desktop operator — the same
   *     unspoofable trust anchor exec uses).
   * Token-based `reconnect()` restores rank directly (the token IS the proof), so
   * the normal desktop CLI/dashboard flow keeps its rank across reconnects. Only
   * a REMOTE, tokenless name-login is capped at 0.
   */
  private restorableRank(
    storedRank: number,
    connId: string,
    internal: boolean,
    identity?: LoginIdentity,
  ): EntityRank {
    if (internal || identity) return storedRank as EntityRank;
    if (isLoopbackConnection(this.host.connections.get(connId))) return storedRank as EntityRank;
    return 0 as EntityRank;
  }

  private static readonly ERR_AUTH_REQUIRED =
    "This instance requires sign-in. Authenticate via the dashboard, or connect with a session token.";

  /** Login: create entity + session, returns token. Checks ban list.
   *  `identity` marks a login already verified by the external auth layer
   *  (better-auth bridge) — it bypasses the passwordless guard and binds the
   *  verified subject/email to the named entity. */
  login(
    connId: string,
    name: string,
    internalToken?: string,
    identity?: LoginIdentity,
  ): { entityId: EntityId; name: string; token: string } | { error: string } {
    const workloadPrincipal = internalToken
      ? this.host.db?.verifyWorkloadCredential(internalToken)
      : undefined;
    if (internalToken?.startsWith("marina-agent-") && !workloadPrincipal) {
      return { error: "Workload credential is expired, revoked, or disabled." };
    }
    if (workloadPrincipal && workloadPrincipal.display_name.toLowerCase() !== name.toLowerCase()) {
      return { error: "Workload credential subject does not match the requested identity." };
    }
    const internal = this.resolveInternal(connId, internalToken, name);

    // Login attempts are rate-limited before any other work (success or failure
    // both consume a token — attempts are what's limited).
    if (!this.checkLoginRate(connId, internal)) {
      return { error: AuthCoordinator.ERR_LOGIN_RATE_LIMITED };
    }

    // Auth-required mode: reject untrusted passwordless name-login. Internal
    // agents (internal token) and identity-verified logins are allowed; everyone
    // else must present a session token via reconnect(). Single choke point for
    // every surface (WS/telnet/MCP/dashboard-api/adapters).
    if (this.host.config.authRequired && !internal && !identity) {
      return { error: AuthCoordinator.ERR_AUTH_REQUIRED };
    }

    // Check ban list
    if (this.host.db?.isBanned(name)) {
      return { error: "You are banned from this server." };
    }

    // Sanitize name once, then pass through to spawnEntity
    const cleanName = sanitizeEntityName(name);
    const principal = this.host.db?.getPrincipal(internal ? "agent" : "human", cleanName);
    if (principal && principal.status !== "active") {
      return { error: `This identity is ${principal.status}. Contact the Marina operator.` };
    }
    // If an entity with this name exists but has no live connection, the login is a
    // re-attach (typical at server restart — `restoreEntities` reinstated the row but
    // no WebSocket is bound to it yet). Bind the new connection to the existing entity
    // and proceed; preserves room location, properties, rank, and persistent state
    // across restarts. If a live connection IS bound, reject — concurrent logins with
    // the same name would race on entity state. Mirrors the same logic `reconnect()` uses.
    const existing = this.host.entities.findAgentByName(cleanName);
    if (existing && this.host.connections.isEntityConnected(existing.id)) {
      return { error: "That name is already in use." };
    }
    if (existing) {
      // Re-attach still consumes a cap slot — this branch is what every user
      // hits after a server restart, so exempting it would leave the cap
      // unenforced post-restart.
      if (this.atLoginCapacity(internal)) {
        return { error: AuthCoordinator.ERR_AT_CAPACITY };
      }
      // Re-attaching to a still-in-memory entity: cancel any pending grace
      // eviction so it isn't torn out from under the new connection.
      this.cancelEviction(existing.id);
      this.host.connections.bindEntity(connId, existing.id);
      if (this.host.db) {
        const existingUser = this.host.db.getUserByName(existing.name);
        if (existingUser) {
          this.host.db.updateUserLastLogin(existingUser.id);
          // SECURITY: a passwordless re-attach must not inherit a stored rank.
          existing.properties.rank = this.restorableRank(
            existingUser.rank,
            connId,
            internal,
            identity,
          );
        }
      }
      this.applyAdminBootstrap(existing, connId, identity);
      if (this.host.sessionManager) {
        // Bind the granted rank to the token: a remote passwordless re-attach was
        // capped at rank 0 above, so its token must not later restore an elevated
        // rank via reconnect().
        const session = this.host.sessionManager.create(
          existing.id,
          existing.name,
          (existing.properties.rank as number) ?? 0,
        );
        return { entityId: existing.id, name: existing.name, token: session.token };
      }
      return { entityId: existing.id, name: existing.name, token: "" };
    }

    if (this.atLoginCapacity(internal)) {
      return { error: AuthCoordinator.ERR_AT_CAPACITY };
    }
    const entity = this.host.spawnEntity(connId, cleanName);
    if (!entity) {
      return { error: "Login failed. Name must be 2-20 alphanumeric characters." };
    }

    // Look up or create user record
    let isNewUser = true;
    if (this.host.db) {
      const existingUser = this.host.db.getUserByName(entity.name);
      if (existingUser) {
        isNewUser = false;
        this.host.db.updateUserLastLogin(existingUser.id);
        // Apply stored rank to entity — but SECURITY: a passwordless name-login
        // never inherits an elevated rank (a name is not proof of identity).
        entity.properties.rank = this.restorableRank(existingUser.rank, connId, internal, identity);
      } else {
        // Use a stable UUID for user IDs (entity IDs are transient and reset on restart)
        const userId = crypto.randomUUID();
        this.host.db.createUser({ id: userId, name: entity.name });
      }
    }

    this.applyAdminBootstrap(entity, connId, identity);

    // Auto-start quest for new entities (rank 0)
    const rank = (entity.properties.rank as number) ?? 0;
    if (rank === 0 && this.host.world?.autoQuest) {
      entity.properties.active_quest = this.host.world.autoQuest;
    }

    // Auto-bootstrap commands for new entities
    if (isNewUser && this.host.world?.autoBootstrap) {
      for (const cmd of this.host.world.autoBootstrap) {
        this.host.processCommand(entity.id, cmd);
      }
    }

    // Auto-subscribe new users to brief compass and set first-login flag
    if (isNewUser) {
      this.host.briefs.subscribe(entity.id, 120);
      // Transient flag: consumed by sendCompass() in brief.ts to emit bootstrap packet
      entity.properties._isFirstLogin = true;
    }

    if (this.host.sessionManager) {
      // Bind the granted rank to the token so a remote passwordless login (capped
      // at rank 0 above) cannot launder that cap into a full rank restore on
      // reconnect().
      const session = this.host.sessionManager.create(
        entity.id,
        entity.name,
        (entity.properties.rank as number) ?? 0,
      );
      return { entityId: entity.id, name: entity.name, token: session.token };
    }

    return { entityId: entity.id, name: entity.name, token: "" };
  }

  /** Reconnect with a session token. Returns entity ID or error. */
  reconnect(
    connId: string,
    token: string,
    internalToken?: string,
  ): { entityId: EntityId; name: string; token: string } | { error: string } {
    if (
      internalToken?.startsWith("marina-agent-") &&
      !this.host.db?.verifyWorkloadCredential(internalToken)
    ) {
      return { error: "Workload credential is expired, revoked, or disabled." };
    }
    const internal = this.resolveInternal(connId, internalToken);

    if (!this.checkLoginRate(connId, internal)) {
      return { error: AuthCoordinator.ERR_LOGIN_RATE_LIMITED };
    }

    if (!this.host.sessionManager) {
      return { error: "Session management not available." };
    }

    const session = this.host.sessionManager.validate(token);
    if (!session) {
      return { error: "Invalid or expired session token." };
    }

    // Check ban list
    if (this.host.db?.isBanned(session.name)) {
      this.host.sessionManager.revoke(token);
      return { error: "You are banned from this server." };
    }

    this.host.sessionManager.refresh(token);

    // Preserve entity identity across reconnects when the old entity is
    // still in memory (typical back-to-back CLI case). Previously we
    // removed and respawned every reconnect, which gave the user a fresh
    // EntityId — fine for DB-migrated state, but in-memory indexes keyed
    // by EntityId (CrewManager owner/member, room presence, command-queue
    // state) lost the binding. Now: if the old entity is alive and
    // disconnected, just rebind the new connection. Fresh-spawn only when
    // the entity is truly gone (server restart, eviction).
    const existing = this.host.entities.findAgentByName(session.name);
    let entity: Entity | undefined;
    if (existing) {
      if (this.host.connections.isEntityConnected(existing.id)) {
        return { error: "That name is already in use." };
      }
      // The cap applies to every unbound→bound transition — a grace-window
      // reconnect that finds the instance full is rejected (hard cap; the
      // entity was unbound on transient close so it isn't double-counted).
      if (this.atLoginCapacity(internal)) {
        return { error: AuthCoordinator.ERR_AT_CAPACITY };
      }
      // Rebind: unbind any stale connection pointer, bind the new one to
      // the SAME entity id. No removal, no respawn, no migration needed.
      // Cancel any pending eviction so the grace timer doesn't yank the
      // entity out from under the freshly bound connection.
      this.cancelEviction(existing.id);
      this.host.connections.unbindEntity(existing.id);
      this.host.connections.bindEntity(connId, existing.id);
      entity = existing;
    } else {
      // Old entity gone — create a fresh one.
      if (this.atLoginCapacity(internal)) {
        return { error: AuthCoordinator.ERR_AT_CAPACITY };
      }
      entity = this.host.spawnEntity(connId, session.name);
      if (!entity) {
        return { error: "Reconnection failed." };
      }
      // Migrate task claims by name as a best-effort recovery for
      // restarts where the old EntityId is unknowable.
      if (this.host.db) {
        tryLog(this.host.logger, "reconnect", "Task claim migration failed", () =>
          this.host.db!.migrateTaskClaimsByName(session.name, entity!.id),
        );
      }
    }

    // Apply stored rank — but a session token is NOT unconditional proof of
    // identity. A remote passwordless login is capped at rank 0 at login() yet
    // still mints a valid token; restoring the persisted (elevated) rank from
    // that token would launder the login cap into a full rank restore. Restore
    // at most the rank the minting login was actually granted (session.grantedRank),
    // UNLESS the reconnecting connection is itself a trusted anchor (loopback
    // desktop operator or internal room/crew agent) — in which case the current
    // connection re-establishes identity directly, exactly like login().
    let restoredRank = 0;
    if (this.host.db) {
      const user = this.host.db.getUserByName(entity.name);
      if (user) {
        const trustedNow = internal || isLoopbackConnection(this.host.connections.get(connId));
        const ceiling = trustedNow ? user.rank : (session.grantedRank ?? 0);
        restoredRank = Math.min(user.rank, ceiling);
        entity.properties.rank = restoredRank as EntityRank;
        this.host.db.updateUserLastLogin(user.id);
      }
    }

    // Update the session to point to the new entity, carrying the restored rank
    // forward as the new token's ceiling so subsequent reconnects stay capped.
    this.host.sessionManager.revoke(token);
    const newSession = this.host.sessionManager.create(entity.id, entity.name, restoredRank);

    this.applyAdminBootstrap(entity, connId);

    return { entityId: entity.id, name: entity.name, token: newSession.token };
  }

  /** Validate a session token. Returns entity ID if valid. */
  authenticate(token: string): EntityId | null {
    if (!this.host.sessionManager) return null;
    const session = this.host.sessionManager.validate(token);
    return session?.entityId ?? null;
  }

  /** Promote entity to sovereign if listed in MARINA_ADMINS env var */
  private applyAdminBootstrap(entity: Entity, connId: string, identity?: LoginIdentity): void {
    // Auth mode: bind the verified identity to this named entity and grant admin
    // by VERIFIED EMAIL (MARINA_AUTH_ADMIN_EMAILS) — never by name. This closes
    // the name-based admin hole that makes name-login unsafe for public hosting.
    if (identity) {
      if (this.host.db) {
        const user = this.host.db.getUserByName(entity.name);
        if (user) this.host.db.bindAuthSubject(user.id, identity.subject, identity.email);
      }
      const adminEmails = new Set(
        (process.env.MARINA_AUTH_ADMIN_EMAILS ?? "")
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      );
      if (identity.emailVerified && adminEmails.has(identity.email.toLowerCase())) {
        this.grantSovereign(entity);
      }
      return;
    }

    // Under auth-required mode, name-based admin promotion is disabled entirely
    // (an unauthenticated name can no longer claim admin).
    if (this.host.config.authRequired) return;

    // LOCAL trust profile: this instance is one operator's own machine and
    // binds loopback only (main.ts refuses `local` on ANY non-loopback bind —
    // sign-in does not lift that — unless MARINA_ALLOW_INSECURE_PUBLIC=true).
    // Every loopback login — the human and the agents they run — is the
    // operator, so it is sovereign without MARINA_ADMINS. A remote connection
    // (only possible under that explicit insecure ack) gets nothing here.
    if (isLocalUngated()) {
      if (isLoopbackConnection(this.host.connections.get(connId))) this.grantSovereign(entity);
      return;
    }

    const adminNames = new Set(
      (process.env.MARINA_ADMINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (!adminNames.has(entity.name)) return;

    // SECURITY: MARINA_ADMINS is name-based, and under passwordless login a name
    // is not proof of identity. Honor it ONLY for a genuine local operator — a
    // loopback (or in-process/internal) connection, the same unspoofable trust
    // anchor exec uses. A REMOTE connection claiming an admin name is refused
    // with a loud log. This keeps the desktop-first flow (local operator on
    // loopback becomes sovereign, zero config) while closing the public hole.
    // For a hard, network-safe admin boundary use MARINA_AUTH=better-auth +
    // MARINA_AUTH_ADMIN_EMAILS instead.
    if (isLoopbackConnection(this.host.connections.get(connId))) {
      this.grantSovereign(entity);
    } else {
      this.host.logger.warn(
        "security",
        `Refusing MARINA_ADMINS sovereign promotion for "${entity.name}" — passwordless ` +
          `name-login from a non-loopback connection is not proof of identity. Enable ` +
          `MARINA_AUTH=better-auth and use MARINA_AUTH_ADMIN_EMAILS for network admin access.`,
      );
    }
  }

  /** Promote an entity to sovereign (rank 9) + all safety gates (operator bootstrap). */
  private grantSovereign(entity: Entity): void {
    setRank(entity, 9);
    if (this.host.db) {
      const user = this.host.db.getUserByName(entity.name);
      if (user) this.host.db.updateUserRank(user.id, 9);
      // A sovereign needs full capability immediately, not after earning
      // standing + demonstrations. Gate grants mirror the historical rank ladder.
      grantGatesForRank(this.host.db, entity.id, 9);
    }
  }
}
