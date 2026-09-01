// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { AgentRuntime } from "../agent/agent-runtime";
import { applyRankProgression } from "../agent/rank-progression";
import { isSeedDisabled } from "../agent/seed-registry";
import {
  recomputeAll as recomputeStanding,
  recordFromEvent as recordStandingEvent,
} from "../agent/standing";
import type { RateLimiter } from "../auth/rate-limiter";
import { secretsEqual } from "../auth/secret-compare";
import { SessionManager } from "../auth/session-manager";
import { BoardManager } from "../coordination/board-manager";
import { ChannelManager } from "../coordination/channel-manager";
import { CrewManager } from "../coordination/crew-manager";
import { GroupManager } from "../coordination/group-manager";
import { MacroManager } from "../coordination/macro-manager";
import { TaskManager } from "../coordination/task-manager";
import { FlywheelManager, type FlywheelToolBackend } from "../integrations/flywheel-manager";
import type { AdapterManager } from "../net/adapter-manager";
import { connects, disconnects } from "../net/ansi";
import { cleanupStaleConversationChannels } from "../net/model-api";
import { guardedFetch, validateFetchUrl } from "../net/url-guard";
import type { MarinaDB } from "../persistence/database";
import { writeSample } from "../resolvers/sample-writer";
import type { StorageProvider } from "../storage/provider";
import type { OtlpExporterStatus } from "../telemetry/otlp-exporter";
import type { OtlpLogExporterStatus } from "../telemetry/otlp-log-exporter";
import { classifyPrimitive, isMarinaTool } from "../telemetry/primitive-usage";
import type {
  CommandContext,
  Connection,
  EngineEvent,
  Entity,
  EntityId,
  EntityRank,
  Perception,
  RoomBoardAPI,
  RoomChannelAPI,
  RoomContext,
  RoomId,
  RoomModule,
} from "../types";
import { EntityManager } from "../world/entity-manager";
import { type LoadedRoom, RoomManager } from "../world/room-manager";
import type { WorldDefinition } from "../world/world-definition";
import { BenchmarkRunner } from "./benchmark-runner";
import { BriefManager } from "./brief-manager";
import { recordEngineCognition } from "./cognitive-provenance";
import { registerBuiltinCommands } from "./command-registry";
import { CommandRouter } from "./command-router";
import { isLoopbackConnection } from "./commands/code";
import { isIgnoring } from "./commands/ignore";
import { syncOperationalAlerts } from "./commands/ops";
import { trackQuestProgress } from "./commands/quest";
import { ConnectionManager } from "./connection-manager";
import { ConnectorRuntime } from "./connector-runtime";
import {
  AGENT_CLEANUP_INTERVAL,
  BOARD_ARCHIVE_AGE_DAYS,
  BOARD_ARCHIVE_INTERVAL,
  CHANNEL_PRUNE_INTERVAL,
  CONVERSATION_CLEANUP_INTERVAL,
  MAX_COMMAND_QUEUE_SIZE,
  MAX_COMMANDS_PER_TICK,
  NOTE_IMPORTANCE_INTERVAL,
  ROOM_FETCH_RATE_MS,
  ROOM_FETCH_TIMEOUT_MS,
} from "./constants";
import { sanitizeEntityName } from "./entity-name";
import { getErrorMessage, tryLog, tryLogAsync } from "./errors";
import { EventLog } from "./event-log";
import { GatewayRuntime } from "./gateway-runtime";
import { Logger } from "./logger";
import { MediaManager } from "./media/manager";
import { getRank, rankName, setRank } from "./permissions";
import { computeReadiness } from "./readiness";
import { RoomSandbox } from "./room-sandbox";
import { checkUnattendedGate, grantGatesForRank } from "./safety-gates";
import { compileCommandModule, compileRoomModule } from "./sandbox";
import { ShellRuntime } from "./shell-runtime";

/** A verified external identity (from the better-auth bridge) passed to login(). */
export interface LoginIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
}

export interface EngineConfig {
  tickInterval: number; // ms between ticks (default 1000)
  startRoom: RoomId; // where new entities spawn
  instanceName?: string; // human-readable instance name (env MARINA_NAME)
  db?: MarinaDB; // optional persistence layer
  dbPath?: string; // path to the DB file (for export)
  rateLimiter?: RateLimiter; // optional rate limiter
  loginRateLimiter?: RateLimiter; // optional limiter for login/reconnect attempts (keyed per IP)
  maxLogins?: number; // instance-wide concurrent login cap; 0/undefined = unlimited
  internalAuthToken?: string; // token exempting internal agent logins from cap + rate limit
  authRequired?: boolean; // when true, external passwordless name-login is rejected (MARINA_AUTH on)
  storage?: StorageProvider; // optional asset storage
  world?: WorldDefinition; // optional world definition
  logger?: Logger; // optional structured logger
  flywheel?: FlywheelToolBackend; // optional isolated execution provider
}

const DEFAULT_TICK_INTERVAL = 1000;

export class Engine {
  readonly entities: EntityManager;
  readonly rooms: RoomManager;
  readonly commands: CommandRouter;
  readonly config: EngineConfig;

  // Auth & rate limiting
  readonly sessionManager?: SessionManager;
  readonly rateLimiter?: RateLimiter;
  readonly loginRateLimiter?: RateLimiter;

  // Coordination managers (available when db is provided)
  readonly channelManager?: ChannelManager;
  readonly boardManager?: BoardManager;
  readonly groupManager?: GroupManager;
  readonly taskManager?: TaskManager;
  readonly macroManager?: MacroManager;
  readonly crewManager?: CrewManager;

  readonly world?: WorldDefinition;
  readonly sandbox: RoomSandbox;
  readonly connectorRuntime?: ConnectorRuntime;
  readonly gatewayRuntime?: GatewayRuntime;
  readonly agentRuntime: AgentRuntime;
  adapterManager?: AdapterManager;
  readonly shellRuntime: ShellRuntime;
  readonly storage?: StorageProvider;
  readonly flywheel?: FlywheelToolBackend;
  readonly benchmarkRunner?: BenchmarkRunner;
  readonly mediaManager?: MediaManager;
  /** @internal */ db?: MarinaDB;
  private startedAt = Date.now();
  private fetchLastCall = new Map<string, number>(); // roomId -> timestamp
  private readonly briefManager = new BriefManager();
  /** @internal */ readonly _connections: ConnectionManager;
  /** @internal — backward-compatible accessor for the raw connections map */
  get connections(): Map<string, Connection> {
    return this._connections.getAll();
  }
  /** Human-readable instance name (from MARINA_NAME env, world name, or "Marina"). */
  get instanceName(): string {
    return this.config.instanceName ?? this.world?.name ?? "Marina";
  }
  private commandQueue: { entity: EntityId; raw: string }[] = [];
  /** @internal */ readonly _eventLog: EventLog;
  /** @internal — backward-compatible accessor for the raw event array */
  get eventLog(): EngineEvent[] {
    return this._eventLog.getAll();
  }
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false;
  private tickCount = 0;
  /** @internal */ readonly logger: Logger;
  private otlpStatusProvider?: () => OtlpExporterStatus;
  private otlpLogStatusProvider?: () => OtlpLogExporterStatus;

  constructor(config?: Partial<EngineConfig>) {
    // Derive startRoom: explicit config > world definition > generic fallback
    const startRoom = config?.startRoom ?? config?.world?.startRoom ?? ("hub/crossroads" as RoomId);
    this.config = {
      tickInterval: DEFAULT_TICK_INTERVAL,
      ...config,
      startRoom,
    };
    this.world = this.config.world;
    this.logger = this.config.logger ?? new Logger();
    this.entities = new EntityManager();
    this.rooms = new RoomManager();
    this.commands = new CommandRouter();
    this._connections = new ConnectionManager();
    this.sandbox = new RoomSandbox();
    this.db = this.config.db;
    this._eventLog = new EventLog(this.logger, this.db);
    this.rateLimiter = this.config.rateLimiter;
    this.loginRateLimiter = this.config.loginRateLimiter;
    this.storage = this.config.storage;
    this.flywheel = this.config.flywheel ?? FlywheelManager.fromEnv(this.db);

    // Wire DB into EntityManager for write-through persistence
    if (this.db) {
      this.entities.setDb(this.db);
    }

    // Initialize session manager if db is available
    if (this.db) {
      this.sessionManager = new SessionManager(this.db);
    }

    // Initialize connector runtime if db is available
    if (this.db) {
      this.connectorRuntime = new ConnectorRuntime(this.db);
    }

    // Initialize shell runtime
    this.shellRuntime = new ShellRuntime(this.db);
    this.shellRuntime.init();

    // Initialize coordination managers if db is available
    if (this.db) {
      this.channelManager = new ChannelManager(this.db, (target, msg, tag?, metadata?) =>
        this.sendToEntity(target, msg, tag, metadata),
      );
      // Ensure the default "model" channel exists so /v1/models always lists this instance
      if (!this.channelManager.getChannelByName("model")) {
        this.channelManager.createChannel({ type: "model", name: "model" });
      }
      this.boardManager = new BoardManager(this.db);
      this.groupManager = new GroupManager(
        this.db,
        this.channelManager,
        this.boardManager,
        (event) => this.logEvent(event),
      );
      this.taskManager = new TaskManager(this.db);
      this.macroManager = new MacroManager(this.db, (entityId, raw) =>
        this.processCommand(entityId, raw),
      );
      this.crewManager = new CrewManager({
        channels: this.channelManager,
        db: this.db,
        onEvent: (event) => this.logEvent(event),
        resolveAgentId: (name) => this.entities.findAgentByName(name)?.id,
      });
      // Reattach persisted crews from previous boot. Idempotent.
      this.crewManager.loadFromDb();

      // Benchmark runner — spawns the harness subprocess + persists runs
      this.benchmarkRunner = new BenchmarkRunner(this.db, (event) => this.logEvent(event));

      // Initialize gateway runtime (must be after channelManager)
      const channelMgr = this.channelManager;
      this.gatewayRuntime = new GatewayRuntime({
        db: this.db,
        localRelay: (channel, body, meta) => {
          const ch = channelMgr.getChannelByName(channel);
          // Tag gateway-relayed channel content as an untrusted, cross-instance
          // source so downstream logic can keep it out of tool-influencing /
          // auto-action paths. Provenance is also visible in the `[from …]` trail.
          //
          // The message body persisted/delivered locally is the CLEAN inner body
          // (no `[relay …]` framing). The relay envelope (origin/hops) rides
          // out-of-band in metadata: it reaches bridged peer gateway clients via
          // the perception payload — preserving multi-hop loop detection — but
          // never appears in a local channel message or a user's view.
          if (ch) {
            channelMgr.send(ch.id, "gateway", "Gateway", body, {
              untrusted: true,
              source: "gateway",
              relayOrigin: meta.origin,
              relayHops: meta.hops,
            });
          }
        },
        localTellRelay: (target, senderLabel, message, _originEntity) => {
          // A gateway-relayed tell is untrusted cross-instance content. Deliver
          // ONLY to the addressed local recipient — never broadcast to every
          // agent. When the target is unrecoverable from the relay framing we
          // drop it rather than fan out (documented in gateway-runtime.ts).
          const formatted = `[gateway] ${senderLabel}: ${message}`;
          const meta = { untrusted: true, source: "gateway", gatewaySender: senderLabel };
          if (!target) {
            console.warn(
              `[gateway] dropped relayed tell from ${senderLabel}: no recoverable local target (not broadcasting)`,
            );
            return;
          }
          const recipient =
            this.entities.findAgentByName(target) ??
            this.entities.all().find((e) => e.name.toLowerCase() === target.toLowerCase());
          if (!recipient) {
            console.warn(
              `[gateway] dropped relayed tell from ${senderLabel}: local target "${target}" not found`,
            );
            return;
          }
          this.sendToEntity(recipient.id, formatted, "gateway", meta);
        },
        // Present as the per-instance name (MARINA_NAME), not the world
        // template name — many instances of the same world must federate
        // as distinct Gateway_<name> identities.
        localWorldName: this.instanceName,
      });
    }

    // Initialize agent runtime (always present, activation gated on API keys)
    this.agentRuntime = new AgentRuntime({
      db: this.db,
      onEvent: (event) => this.logEvent(event),
    });

    if (this.db && this.storage) {
      this.mediaManager = new MediaManager({
        engine: this,
        db: this.db,
        storage: this.storage,
        resolveApiKey: (provider) => this.agentRuntime.getProviderKey(provider),
        logEvent: (event) => this.logEvent(event),
      });
    }

    this.registerBuiltinCommands();
  }

  // ─── Room Registration ──────────────────────────────────────────────────

  registerRoom(id: RoomId, module: RoomModule): void {
    const wrapped = this.sandbox.wrapModule(id, module, (_roomId, error) => {
      this.logger.error("sandbox", error);
    });
    this.rooms.register(id, wrapped);
  }

  /** Register all rooms from a WorldDefinition.
   *  Shallow-copies each module so build mutations don't bleed between instances. */
  registerWorldRooms(world: WorldDefinition): void {
    for (const [id, module] of Object.entries(world.rooms)) {
      this.registerRoom(id as RoomId, {
        ...module,
        exits: module.exits ? { ...module.exits } : undefined,
        items: module.items ? { ...module.items } : undefined,
      });
    }
  }

  // ─── Connection Management ──────────────────────────────────────────────

  addConnection(conn: Connection): void {
    this._connections.add(conn);
    this.logEvent({
      type: "connect",
      connectionId: conn.id,
      protocol: conn.protocol,
      timestamp: Date.now(),
    });
  }

  /** Per-name grace-period timers — entities linger this long after WS
   * close so a token-bearing reconnect can reclaim the same EntityId. */
  private entityEvictionTimers = new Map<EntityId, ReturnType<typeof setTimeout>>();
  private static readonly RECONNECT_GRACE_MS = 60_000;

  /** Cancel a pending grace-period eviction for an entity (it's being rebound). */
  private cancelEviction(entityId: EntityId): void {
    const pending = this.entityEvictionTimers.get(entityId);
    if (pending) {
      clearTimeout(pending);
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
    const conn = this._connections.get(connId);
    if (!conn) return;

    if (conn.entity) {
      this.briefManager.unsubscribe(conn.entity);
      this._connections.unbindEntity(conn.entity);
      const entity = this.entities.get(conn.entity);
      if (entity) {
        const ctx = this.buildContext(entity.room);
        if (ctx) {
          ctx.broadcastExcept(conn.entity, disconnects(entity.name), "disconnect");
        }
        const entityId = conn.entity;
        const entityRoom = entity.room;
        if (intent === "explicit") {
          // Cancel any pending eviction (this is a hard quit) and remove now.
          const existing = this.entityEvictionTimers.get(entityId);
          if (existing) {
            clearTimeout(existing);
            this.entityEvictionTimers.delete(entityId);
          }
          this.emitEntityLeave(entityId, entityRoom);
          this.entities.remove(entityId);
        } else {
          // Transient close — schedule deferred eviction so reconnect can rebind.
          const existing = this.entityEvictionTimers.get(entityId);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            if (!this._connections.isEntityConnected(entityId)) {
              this.emitEntityLeave(entityId, entityRoom);
              this.entities.remove(entityId);
            }
            this.entityEvictionTimers.delete(entityId);
          }, Engine.RECONNECT_GRACE_MS);
          this.entityEvictionTimers.set(entityId, timer);
        }
      }
    }

    this._connections.remove(connId);
    this.logEvent({ type: "disconnect", connectionId: connId, timestamp: Date.now() });
  }

  /**
   * Emit an `entity_leave` event — the symmetric counterpart to the
   * `entity_enter` fired on fresh spawn. Fires at the moment the entity is
   * actually removed from the world (not on transient disconnect, since a
   * grace-window reconnect rebinds the same id without re-emitting enter).
   */
  private emitEntityLeave(entityId: EntityId, room: RoomId): void {
    this.logEvent({ type: "entity_leave", entity: entityId, room, timestamp: Date.now() });
  }

  /** Bind a connection to a new entity (login) */
  spawnEntity(connId: string, name: string): Entity | undefined {
    const conn = this._connections.get(connId);
    if (!conn) return undefined;

    // Sanitize name: alphanumeric + underscores only, 2-20 chars
    const cleanName = sanitizeEntityName(name);
    if (cleanName.length < 2) return undefined;

    const entity = this.entities.create({
      kind: "agent",
      name: cleanName,
      short: `${cleanName} is here.`,
      long: `You see ${cleanName}, a connected agent.`,
      room: this.config.startRoom,
    });

    this._connections.bindEntity(connId, entity.id);

    // Broadcast arrival
    const ctx = this.buildContext(entity.room);
    if (ctx) {
      ctx.broadcastExcept(entity.id, connects(cleanName), "connect");
    }

    this.logEvent({
      type: "entity_enter",
      entity: entity.id,
      room: entity.room,
      timestamp: Date.now(),
    });

    // Fire onEnter for the start room (spawning room agents, quests, etc.)
    const room = this.rooms.get(entity.room);
    if (room?.module.onEnter && ctx) {
      try {
        room.module.onEnter(ctx, entity.id);
      } catch (err) {
        this.logger.warn("room", `onEnter error in ${entity.room as string}: ${err}`);
      }
    }

    return entity;
  }

  // ─── Session-based Auth ─────────────────────────────────────────────────

  private static readonly ERR_LOGIN_RATE_LIMITED =
    "Too many login attempts. Please slow down and retry shortly.";
  private static readonly ERR_AT_CAPACITY =
    "Instance at capacity: too many concurrent logins. Try again later.";

  /** Resolve and tag whether a connection is an internal agent (room/crew
   * agents pass the process-local internal token). Internal connections are
   * exempt from the instance login cap and the login rate limit, and don't
   * consume cap slots. */
  private resolveInternal(connId: string, internalToken?: string, claimedName?: string): boolean {
    const expected = this.config.internalAuthToken;
    const legacy = !!expected && !!internalToken && secretsEqual(internalToken, expected);
    const workload = internalToken ? this.db?.verifyWorkloadCredential(internalToken) : undefined;
    const workloadMatches =
      !!workload &&
      (!claimedName || workload.display_name.toLowerCase() === claimedName.toLowerCase());
    const isInternal = legacy || workloadMatches;
    if (isInternal) {
      const conn = this._connections.get(connId);
      if (conn) conn.internal = true;
    }
    return isInternal;
  }

  /** Consume a login-attempt token. Keyed per client IP, falling back to the
   * connection id when IP is unknown (e.g. MCP sessions). */
  private checkLoginRate(connId: string, internal: boolean): boolean {
    if (internal || !this.loginRateLimiter) return true;
    const conn = this._connections.get(connId);
    return this.loginRateLimiter.consume(`login:${conn?.ip ?? connId}`);
  }

  /** True when binding one more external login would exceed MARINA_MAX_LOGINS. */
  private atLoginCapacity(internal: boolean): boolean {
    const cap = this.config.maxLogins ?? 0;
    if (internal || cap <= 0) return false;
    return this._connections.boundExternalCount() >= cap;
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
    if (isLoopbackConnection(this._connections.get(connId))) return storedRank as EntityRank;
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
      ? this.db?.verifyWorkloadCredential(internalToken)
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
      return { error: Engine.ERR_LOGIN_RATE_LIMITED };
    }

    // Auth-required mode: reject untrusted passwordless name-login. Internal
    // agents (internal token) and identity-verified logins are allowed; everyone
    // else must present a session token via reconnect(). Single choke point for
    // every surface (WS/telnet/MCP/dashboard-api/adapters).
    if (this.config.authRequired && !internal && !identity) {
      return { error: Engine.ERR_AUTH_REQUIRED };
    }

    // Check ban list
    if (this.db?.isBanned(name)) {
      return { error: "You are banned from this server." };
    }

    // Sanitize name once, then pass through to spawnEntity
    const cleanName = sanitizeEntityName(name);
    const principal = this.db?.getPrincipal(internal ? "agent" : "human", cleanName);
    if (principal && principal.status !== "active") {
      return { error: `This identity is ${principal.status}. Contact the Marina operator.` };
    }
    // If an entity with this name exists but has no live connection, the login is a
    // re-attach (typical at server restart — `restoreEntities` reinstated the row but
    // no WebSocket is bound to it yet). Bind the new connection to the existing entity
    // and proceed; preserves room location, properties, rank, and persistent state
    // across restarts. If a live connection IS bound, reject — concurrent logins with
    // the same name would race on entity state. Mirrors the same logic `reconnect()` uses.
    const existing = this.entities.findAgentByName(cleanName);
    if (existing && this._connections.isEntityConnected(existing.id)) {
      return { error: "That name is already in use." };
    }
    if (existing) {
      // Re-attach still consumes a cap slot — this branch is what every user
      // hits after a server restart, so exempting it would leave the cap
      // unenforced post-restart.
      if (this.atLoginCapacity(internal)) {
        return { error: Engine.ERR_AT_CAPACITY };
      }
      // Re-attaching to a still-in-memory entity: cancel any pending grace
      // eviction so it isn't torn out from under the new connection.
      this.cancelEviction(existing.id);
      this._connections.bindEntity(connId, existing.id);
      if (this.db) {
        const existingUser = this.db.getUserByName(existing.name);
        if (existingUser) {
          this.db.updateUserLastLogin(existingUser.id);
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
      if (this.sessionManager) {
        // Bind the granted rank to the token: a remote passwordless re-attach was
        // capped at rank 0 above, so its token must not later restore an elevated
        // rank via reconnect().
        const session = this.sessionManager.create(
          existing.id,
          existing.name,
          (existing.properties.rank as number) ?? 0,
        );
        return { entityId: existing.id, name: existing.name, token: session.token };
      }
      return { entityId: existing.id, name: existing.name, token: "" };
    }

    if (this.atLoginCapacity(internal)) {
      return { error: Engine.ERR_AT_CAPACITY };
    }
    const entity = this.spawnEntity(connId, cleanName);
    if (!entity) {
      return { error: "Login failed. Name must be 2-20 alphanumeric characters." };
    }

    // Look up or create user record
    let isNewUser = true;
    if (this.db) {
      const existingUser = this.db.getUserByName(entity.name);
      if (existingUser) {
        isNewUser = false;
        this.db.updateUserLastLogin(existingUser.id);
        // Apply stored rank to entity — but SECURITY: a passwordless name-login
        // never inherits an elevated rank (a name is not proof of identity).
        entity.properties.rank = this.restorableRank(existingUser.rank, connId, internal, identity);
      } else {
        // Use a stable UUID for user IDs (entity IDs are transient and reset on restart)
        const userId = crypto.randomUUID();
        this.db.createUser({ id: userId, name: entity.name });
      }
    }

    this.applyAdminBootstrap(entity, connId, identity);

    // Auto-start quest for new entities (rank 0)
    const rank = (entity.properties.rank as number) ?? 0;
    if (rank === 0 && this.world?.autoQuest) {
      entity.properties.active_quest = this.world.autoQuest;
    }

    // Auto-bootstrap commands for new entities
    if (isNewUser && this.world?.autoBootstrap) {
      for (const cmd of this.world.autoBootstrap) {
        this.processCommand(entity.id, cmd);
      }
    }

    // Auto-subscribe new users to brief compass and set first-login flag
    if (isNewUser) {
      this.briefManager.subscribe(entity.id, 120);
      // Transient flag: consumed by sendCompass() in brief.ts to emit bootstrap packet
      entity.properties._isFirstLogin = true;
    }

    if (this.sessionManager) {
      // Bind the granted rank to the token so a remote passwordless login (capped
      // at rank 0 above) cannot launder that cap into a full rank restore on
      // reconnect().
      const session = this.sessionManager.create(
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
      !this.db?.verifyWorkloadCredential(internalToken)
    ) {
      return { error: "Workload credential is expired, revoked, or disabled." };
    }
    const internal = this.resolveInternal(connId, internalToken);

    if (!this.checkLoginRate(connId, internal)) {
      return { error: Engine.ERR_LOGIN_RATE_LIMITED };
    }

    if (!this.sessionManager) {
      return { error: "Session management not available." };
    }

    const session = this.sessionManager.validate(token);
    if (!session) {
      return { error: "Invalid or expired session token." };
    }

    // Check ban list
    if (this.db?.isBanned(session.name)) {
      this.sessionManager.revoke(token);
      return { error: "You are banned from this server." };
    }

    this.sessionManager.refresh(token);

    // Preserve entity identity across reconnects when the old entity is
    // still in memory (typical back-to-back CLI case). Previously we
    // removed and respawned every reconnect, which gave the user a fresh
    // EntityId — fine for DB-migrated state, but in-memory indexes keyed
    // by EntityId (CrewManager owner/member, room presence, command-queue
    // state) lost the binding. Now: if the old entity is alive and
    // disconnected, just rebind the new connection. Fresh-spawn only when
    // the entity is truly gone (server restart, eviction).
    const existing = this.entities.findAgentByName(session.name);
    let entity: Entity | undefined;
    if (existing) {
      if (this._connections.isEntityConnected(existing.id)) {
        return { error: "That name is already in use." };
      }
      // The cap applies to every unbound→bound transition — a grace-window
      // reconnect that finds the instance full is rejected (hard cap; the
      // entity was unbound on transient close so it isn't double-counted).
      if (this.atLoginCapacity(internal)) {
        return { error: Engine.ERR_AT_CAPACITY };
      }
      // Rebind: unbind any stale connection pointer, bind the new one to
      // the SAME entity id. No removal, no respawn, no migration needed.
      // Cancel any pending eviction so the grace timer doesn't yank the
      // entity out from under the freshly bound connection.
      this.cancelEviction(existing.id);
      this._connections.unbindEntity(existing.id);
      this._connections.bindEntity(connId, existing.id);
      entity = existing;
    } else {
      // Old entity gone — create a fresh one.
      if (this.atLoginCapacity(internal)) {
        return { error: Engine.ERR_AT_CAPACITY };
      }
      entity = this.spawnEntity(connId, session.name);
      if (!entity) {
        return { error: "Reconnection failed." };
      }
      // Migrate task claims by name as a best-effort recovery for
      // restarts where the old EntityId is unknowable.
      if (this.db) {
        tryLog(this.logger, "reconnect", "Task claim migration failed", () =>
          this.db!.migrateTaskClaimsByName(session.name, entity!.id),
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
    if (this.db) {
      const user = this.db.getUserByName(entity.name);
      if (user) {
        const trustedNow = internal || isLoopbackConnection(this._connections.get(connId));
        const ceiling = trustedNow ? user.rank : (session.grantedRank ?? 0);
        restoredRank = Math.min(user.rank, ceiling);
        entity.properties.rank = restoredRank as EntityRank;
        this.db.updateUserLastLogin(user.id);
      }
    }

    // Update the session to point to the new entity, carrying the restored rank
    // forward as the new token's ceiling so subsequent reconnects stay capped.
    this.sessionManager.revoke(token);
    const newSession = this.sessionManager.create(entity.id, entity.name, restoredRank);

    this.applyAdminBootstrap(entity, connId);

    return { entityId: entity.id, name: entity.name, token: newSession.token };
  }

  /** Validate a session token. Returns entity ID if valid. */
  authenticate(token: string): EntityId | null {
    if (!this.sessionManager) return null;
    const session = this.sessionManager.validate(token);
    return session?.entityId ?? null;
  }

  /** Check rate limit for a key. Returns true if allowed. */
  checkRateLimit(key: string): boolean {
    if (!this.rateLimiter) return true;
    return this.rateLimiter.consume(key);
  }

  /** Register a listener for engine events */
  addEventListener(listener: (event: EngineEvent) => void): void {
    this._eventLog.addListener(listener);
  }

  /** Remove a previously registered event listener */
  removeEventListener(listener: (event: EngineEvent) => void): void {
    this._eventLog.removeListener(listener);
  }

  /** Get server uptime in ms */
  getUptime(): number {
    return Date.now() - this.startedAt;
  }

  /** Get all active connections */
  getConnections(): Map<string, Connection> {
    return this._connections.getAll();
  }

  // ─── Command Processing ─────────────────────────────────────────────────

  /** Queue a command from a connected entity */
  queueCommand(entity: EntityId, raw: string): void {
    // Drop commands if queue is overloaded (DoS prevention)
    if (this.commandQueue.length >= MAX_COMMAND_QUEUE_SIZE) return;
    this.commandQueue.push({ entity, raw });
  }

  /** Process a single command immediately */
  async processCommand(
    entityId: EntityId,
    raw: string,
    opts?: { bypassModal?: boolean },
  ): Promise<void> {
    const commandStartedAt = Date.now();
    const entity = this.entities.get(entityId);
    if (!entity) return;

    // Engine-initiated housekeeping (brief heartbeat, login look) must not be
    // captured by an entity's active modal — inside Code Mode the rewrite
    // would turn "brief" into the coding task `code brief`.
    const routedRaw = opts?.bypassModal ? raw : this.routeModalCommand(entity, raw);
    const input = this.commands.parse(routedRaw, entityId, entity.room);

    if (!input.verb) return;
    const def = this.commands.getDef(input.verb);

    const recordUsage = (success: boolean) => {
      if (!this.db) return;
      const classification = classifyPrimitive(routedRaw, def?.name);
      const promptVersion =
        entity.kind === "agent"
          ? this.agentRuntime.get(entity.name)?.getStatus().promptVersion
          : undefined;
      tryLog(this.logger, "telemetry", "Primitive usage recording failed", () => {
        this.db!.recordPrimitiveUsage({
          actorId: String(entityId),
          actorName: entity.name,
          actorKind: entity.kind,
          source: "command",
          ...classification,
          success,
          latencyMs: Date.now() - commandStartedAt,
          createdAt: commandStartedAt,
          promptVersion,
        });
      });
    };

    const room = this.rooms.get(entity.room);
    const handler = this.commands.resolve(input.verb, room?.module.commands);

    if (!handler) {
      // Macro fallback: entity macros first, then system macros
      if (this.macroManager) {
        const macro =
          this.macroManager.getByName(input.verb, entityId as string) ??
          this.macroManager.getByName(input.verb, "system");
        if (macro) {
          const commands = macro.command
            .split(";")
            .map((c) => c.trim())
            .filter(Boolean);
          for (const cmd of commands) {
            this.processCommand(entityId, cmd);
          }
          return;
        }
      }
      this.sendToEntity(entityId, `Unknown command: ${input.verb}. Type "help" for commands.`);
      recordUsage(false);
      return;
    }

    // Enforce minRank on built-in commands
    if (def?.minRank && def.minRank > 0) {
      const rank = getRank(entity);
      if (rank < def.minRank) {
        this.sendToEntity(
          entityId,
          `You must be at least ${rankName(def.minRank)} (rank ${def.minRank}) to use "${def.name}".`,
        );
        recordUsage(false);
        return;
      }
    }

    // Enforce safety gate if declared. A gate is a per-operation competence
    // proof — see src/engine/safety-gates.ts. Every command that declares
    // `def.gate` (shell.exec, agent.run, adapter.enable, connect.manage,
    // gateway.connect, key.manage, admin.destructive) is an UNATTENDED dangerous
    // op dispatched through the router with no live witness or per-command human
    // approver in the loop. So this uses `checkUnattendedGate`, NOT `checkGate`:
    // a standing-only (supervisedOnly) holder is REFUSED. Otherwise the router
    // itself would let an entity self-certify a gate by running the op N times
    // unwatched (the demos recorded here). Unsupervised competence is earned
    // only by an operator grant, a rank promotion (`grantGatesForRank`), or an
    // externally-witnessed demonstration (`recordWitnessedDemonstration`) —
    // never self-report.
    if (def?.gate && this.db) {
      const result = checkUnattendedGate(this.db, entityId, def.gate);
      if (!result.ok) {
        this.sendToEntity(entityId, result.reason ?? `Gate "${def.gate}" denied.`);
        recordUsage(false);
        return;
      }
    }

    const ctx = this.buildCommandContext(entity.room, entityId) ?? this.buildContext(entity.room);
    if (!ctx) return;

    let handlerThrew = false;
    try {
      const result = handler(ctx, input);
      // Await async handlers so callers that `await processCommand` get
      // proper sequencing. Non-awaiting callers ignore the returned Promise
      // and behavior is unchanged for them.
      if (result instanceof Promise) {
        try {
          await result;
        } catch (err) {
          handlerThrew = true;
          const msg = getErrorMessage(err);
          this.logger.error("command", `Async error in "${input.verb}"`, { error: msg });
          this.sendToEntity(entityId, `Command error: ${msg}`);
        }
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      this.logger.error("command", `Error in "${input.verb}"`, { error: msg });
      this.sendToEntity(entityId, `Command error: ${msg}`);
      // Track failed command
      if (this.db) {
        const entity = this.entities.get(entityId);
        if (entity) {
          tryLog(this.logger, "tick", "Activity tracking failed", () => {
            this.db!.trackActivity(entity.name, "command", input.verb, false);
          });
        }
      }
      recordUsage(false);
      return;
    }

    // Track quest progress based on command type
    this.trackQuest(entityId, input.verb, routedRaw);

    // Track activity for novelty scoring (with success)
    if (this.db) {
      const entity = this.entities.get(entityId);
      if (entity) {
        tryLog(this.logger, "tick", "Activity tracking failed", () => {
          this.db!.trackActivity(entity.name, "command", input.verb, true);
          this.db!.trackActivity(entity.name, "room_visit", entity.room);
        });
      }
    }

    // NOTE: no self-reported demonstration recording here. Gated commands are
    // unattended dangerous ops (see the gate check above) — self-recording a
    // demonstration on a clean run is exactly the self-certification path that
    // let a standing-only entity auto-unlock a gate. Competence is earned only
    // via operator grant / rank promotion / witnessed demonstration.
    recordUsage(!handlerThrew);

    this.logEvent({ type: "command", entity: entityId, input: routedRaw, timestamp: Date.now() });
  }

  private routeModalCommand(entity: Entity, raw: string): string {
    const activeModal = entity.properties.active_modal;
    if (activeModal !== "code") return raw;

    const trimmed = raw.trim();
    if (!trimmed) return raw;

    const verb = trimmed.split(/\s+/, 1)[0]?.toLowerCase();
    if (!verb || verb === "code") return raw;

    if (verb === "exit" || verb === "back" || verb === "world") {
      return "code exit";
    }
    if (verb === "help" || verb === "?") {
      return "code help";
    }

    return `code ${trimmed}`;
  }

  private trackQuest(entityId: EntityId, verb: string, raw?: string): void {
    const entity = this.entities.get(entityId);
    if (!entity?.properties.active_quest) return;

    if (verb === "look" || verb === "l") {
      trackQuestProgress(entity, "look");
    } else if (verb === "say" || verb === "'") {
      trackQuestProgress(entity, "say");
    } else if (verb === "examine" || verb === "ex" || verb === "x") {
      trackQuestProgress(entity, "examine");
    } else if (
      [
        "move",
        "go",
        "north",
        "south",
        "east",
        "west",
        "up",
        "down",
        "n",
        "s",
        "e",
        "w",
        "u",
        "d",
        "northeast",
        "northwest",
        "southeast",
        "southwest",
        "ne",
        "nw",
        "se",
        "sw",
      ].includes(verb)
    ) {
      trackQuestProgress(entity, "move", entity.room);
    } else if (verb === "memory") {
      const lower = raw?.toLowerCase() ?? "";
      if (lower.startsWith("memory set ") || lower.startsWith("memory set\t")) {
        trackQuestProgress(entity, "memory_set");
      }
    } else if (verb === "note") {
      const lower = raw?.toLowerCase().trim() ?? "";
      const noteSubs = [
        "list",
        "search",
        "space",
        "delete",
        "link",
        "trace",
        "graph",
        "correct",
        "types",
        "evolve",
      ];
      const firstToken = lower.split(/\s+/)[1] ?? "";
      if (lower !== "note" && !noteSubs.includes(firstToken)) {
        trackQuestProgress(entity, "note_create");
      }
    } else if (verb === "recall") {
      trackQuestProgress(entity, "recall");
    } else if (verb === "reflect") {
      trackQuestProgress(entity, "reflect");
    } else if (verb === "project") {
      const lower = raw?.toLowerCase().trim() ?? "";
      if (lower.includes(" join")) {
        trackQuestProgress(entity, "project_join");
      }
    } else if (verb === "task") {
      const lower = raw?.toLowerCase().trim() ?? "";
      if (lower.startsWith("task claim ")) {
        trackQuestProgress(entity, "task_claim");
      } else if (lower.startsWith("task submit ")) {
        trackQuestProgress(entity, "task_submit");
      }
    } else if (verb === "pool") {
      const lower = raw?.toLowerCase().trim() ?? "";
      if (lower.includes(" add ")) {
        trackQuestProgress(entity, "pool_add");
      }
    } else if (verb === "channel") {
      const lower = raw?.toLowerCase().trim() ?? "";
      if (lower.startsWith("channel send ")) {
        trackQuestProgress(entity, "channel_send");
      }
    }
  }

  // ─── Tick Loop ──────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.flywheel?.reconcile?.().catch((error) => {
      this.logger.warn("flywheel", "Workspace reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.logger.info(
      "engine",
      `Marina engine started (tick: ${this.config.tickInterval}ms, rooms: ${this.rooms.size})`,
    );

    this.tickTimer = setInterval(() => this.tick(), this.config.tickInterval);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    // Cancel any pending grace-period eviction timers so they don't fire
    // after stop()/shutdown() — important for tests that create/tear down
    // engines repeatedly, and clean for production restarts.
    for (const timer of this.entityEvictionTimers.values()) {
      clearTimeout(timer);
    }
    this.entityEvictionTimers.clear();
    this.mediaManager?.stop();
    this.logger.info("engine", "Marina engine stopped.");
  }

  private tick(): void {
    // Re-entrancy guard: prevent overlapping ticks from setInterval
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.tickInner();
    } finally {
      this.ticking = false;
    }
  }

  private tickInner(): void {
    this.tickCount++;
    this.sandbox.tick();

    // Lease expiry is persisted coordination state. Recover abandoned work
    // before entities inspect the queue on this tick.
    for (const claim of this.taskManager?.recoverExpired() ?? []) {
      this.logEvent({
        type: "task_released",
        entity: claim.entityId as EntityId,
        taskId: claim.taskId,
        reason: "lease_expired",
        timestamp: Date.now(),
      });
    }
    this.db?.expireDirectMessages();

    // 1. Process queued commands — per-entity round-robin for fairness
    //    No single entity can monopolize a tick; each gets one command per round.
    if (this.commandQueue.length > 0) {
      // Group by entity, preserving per-entity FIFO order
      const byEntity = new Map<EntityId, { entity: EntityId; raw: string }[]>();
      for (const cmd of this.commandQueue) {
        let list = byEntity.get(cmd.entity);
        if (!list) {
          list = [];
          byEntity.set(cmd.entity, list);
        }
        list.push(cmd);
      }

      // Round-robin: one command per entity per round, up to tick budget
      const entityQueues = [...byEntity.values()];
      const cursors: number[] = entityQueues.map(() => 0);
      let processed = 0;
      let anyLeft = true;
      while (processed < MAX_COMMANDS_PER_TICK && anyLeft) {
        anyLeft = false;
        for (let i = 0; i < entityQueues.length; i++) {
          const eq = entityQueues[i]!;
          const ci = cursors[i]!;
          if (ci < eq.length) {
            const cmd = eq[ci]!;
            this.processCommand(cmd.entity, cmd.raw);
            cursors[i] = ci + 1;
            processed++;
            anyLeft = true;
            if (processed >= MAX_COMMANDS_PER_TICK) break;
          }
        }
      }

      // Keep unprocessed commands for next tick
      const leftover: { entity: EntityId; raw: string }[] = [];
      for (let i = 0; i < entityQueues.length; i++) {
        const eq = entityQueues[i]!;
        for (let j = cursors[i]!; j < eq.length; j++) {
          leftover.push(eq[j]!);
        }
      }
      this.commandQueue = leftover;
    }

    // 2. Run room ticks (randomized order to prevent positional bias)
    // Budget: skip remaining rooms if total tick time exceeds limit
    const TICK_BUDGET_MS = 200;
    const tickStart = performance.now();
    const rooms = this.rooms.all();
    shuffleArray(rooms);
    let roomsSkipped = 0;
    const SLOW_ROOM_THRESHOLD_MS = 100;
    const slowRooms: Array<{ room: string; ms: number }> = [];
    for (const room of rooms) {
      if (room.module.onTick) {
        if (performance.now() - tickStart > TICK_BUDGET_MS) {
          roomsSkipped++;
          continue;
        }
        const ctx = this.buildContext(room.id);
        if (ctx) {
          const roomStart = performance.now();
          try {
            const result = room.module.onTick!(ctx);
            // async onTick: capture post-await rejections so a throw after an
            // `await` doesn't escape as an unhandled rejection (sync throws are
            // caught below). Work after the first await isn't counted in roomMs.
            if (result instanceof Promise) {
              result.catch((err) =>
                this.logger.warn("tick", `Async room tick error in ${room.id}`, {
                  error: getErrorMessage(err),
                }),
              );
            }
          } catch (err) {
            this.logger.warn("tick", `Room tick error in ${room.id}`, {
              error: getErrorMessage(err),
            });
          }
          const roomMs = performance.now() - roomStart;
          if (roomMs > SLOW_ROOM_THRESHOLD_MS) {
            slowRooms.push({ room: room.id, ms: Math.round(roomMs) });
          }
        }
      }
    }
    if (roomsSkipped > 0) {
      this.logger.warn("tick", `Tick budget exceeded: skipped ${roomsSkipped} room tick(s)`);
    }
    if (slowRooms.length > 0) {
      // Name-and-log slow rooms so operators can identify offenders.
      // We don't interrupt — that would leave room state mid-mutation —
      // but we surface the signal so over-budget handlers don't stay hidden.
      const detail = slowRooms.map((s) => `${s.room}=${s.ms}ms`).join(", ");
      this.logger.warn("tick", `Slow room onTick(s): ${detail}`);
    }

    // 3. Periodic maintenance (boards auto-archive, channel pruning, note importance adjustment)
    if (this.tickCount % BOARD_ARCHIVE_INTERVAL === 0 && this.boardManager) {
      const bm = this.boardManager;
      tryLog(this.logger, "tick", "Board auto-archive failed", () =>
        bm.autoArchive(BOARD_ARCHIVE_AGE_DAYS, 0),
      );
    }
    if (this.tickCount % CHANNEL_PRUNE_INTERVAL === 0 && this.channelManager) {
      const cm = this.channelManager;
      tryLog(this.logger, "tick", "Channel prune failed", () => cm.pruneExpiredMessages());
    }
    if (this.tickCount % CHANNEL_PRUNE_INTERVAL === 0) {
      this.flywheel?.maintenance?.().catch((error) => {
        this.logger.warn("flywheel", "Workspace maintenance failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    // Every tick: crew idle GC + dissolved cleanup. Cheap (in-memory map walk).
    if (this.crewManager) {
      const crews = this.crewManager;
      tryLog(this.logger, "tick", "Crew tick failed", () => crews.tick());
    }
    // Hourly: clean up stale model conversation channels
    if (this.tickCount % CONVERSATION_CLEANUP_INTERVAL === 0 && this.channelManager) {
      const cm = this.channelManager;
      tryLog(this.logger, "tick", "Conversation cleanup failed", () =>
        cleanupStaleConversationChannels(cm),
      );
    }
    // Hourly: adjust note importance based on recall patterns
    if (this.tickCount % NOTE_IMPORTANCE_INTERVAL === 0 && this.db) {
      const db = this.db;
      tryLog(this.logger, "tick", "Note importance adjustment failed", () =>
        db.adjustNoteImportance(),
      );
      tryLog(this.logger, "tick", "Memory confidence calibration failed", () =>
        db.calibrateMemoryConfidence(),
      );
      tryLog(this.logger, "tick", "Shared contradiction scan failed", () =>
        db.refreshContradictionCases(),
      );
    }
    if (this.tickCount % NOTE_IMPORTANCE_INTERVAL === 0 && this.db && this.taskManager) {
      tryLog(this.logger, "tick", "Operational alert sync failed", () =>
        syncOperationalAlerts({
          db: this.db!,
          tasks: this.taskManager!,
          runtime: this.agentRuntime,
          readiness: () => computeReadiness(this),
        }),
      );
    }

    // Hourly: refresh civic-standing rollup cache from the ledger.
    // Decay is real-valued; reads recompute on cache stale, but a periodic
    // pass keeps the leaderboard hot without waiting for a read on every
    // entity.
    if (this.tickCount % NOTE_IMPORTANCE_INTERVAL === 0 && this.db) {
      const db = this.db;
      tryLog(this.logger, "tick", "Standing recompute failed", () => recomputeStanding(db));
    }

    // Periodic: clean up orphaned agents (entities without active connections)
    if (this.tickCount % AGENT_CLEANUP_INTERVAL === 0) {
      this.cleanupOrphanedAgents();
    }

    // Hourly: check rank progression for all online entities
    if (this.tickCount % NOTE_IMPORTANCE_INTERVAL === 0 && this.db) {
      const db = this.db;
      for (const entity of this.entities.all()) {
        try {
          const oldRank = getRank(entity);
          if (applyRankProgression(db, entity)) {
            const newRank = getRank(entity);
            const direction: "promoted" | "demoted" = newRank > oldRank ? "promoted" : "demoted";
            this.sendToEntity(
              entity.id,
              `Your rank has changed to ${rankName(newRank)} (${newRank}).`,
            );
            // Record the rank change as a high-importance decision note
            // in the agent's own memory so future selves / successors
            // recall their growth arc via normal memory retrieval.
            try {
              db.createNote(
                entity.name,
                `[rank ${direction}] ${rankName(oldRank)} (${oldRank}) → ${rankName(newRank)} (${newRank})`,
                entity.room,
                { importance: 9, noteType: "decision" },
              );
            } catch {
              // Note write is best-effort — don't block the rank change.
            }
            // Emit engine event so dashboards and peers observe the change.
            this.logEvent({
              type: "rank_change",
              entity: entity.id,
              name: entity.name,
              oldRank,
              newRank,
              direction,
              timestamp: Date.now(),
            });
          }
        } catch {
          // Non-critical — don't let one entity's check block others
        }
      }
    }

    // Brief heartbeat: send compass to subscribed entities
    for (const eid of this.briefManager.getReadySubscribers(this.tickCount)) {
      this.sendBrief(eid);
    }

    this.logEvent({ type: "tick", timestamp: Date.now() });
  }

  // ─── Messaging ──────────────────────────────────────────────────────────

  sendToEntity(
    target: EntityId,
    message: string,
    tag?: string,
    metadata?: Record<string, unknown>,
  ): void {
    const perception: Perception = {
      kind: "message",
      timestamp: Date.now(),
      ...(tag && { tag }),
      data: { text: message, ...metadata },
    };
    this._connections.sendToEntity(target, perception);
  }

  /** Reserved engine-authored control perception. Room code only receives the
   * ordinary RoomContext message API and cannot emit this system-kind channel. */
  sendSystemControl(
    target: EntityId,
    controlType: string,
    metadata: Record<string, unknown>,
  ): void {
    this._connections.sendToEntity(target, {
      kind: "system",
      timestamp: Date.now(),
      tag: "marina-control",
      data: { controlType, ...metadata },
    });
  }

  getActiveEvolutionSessions(entityName: string): Array<{
    id: number;
    experimentId: number;
  }> {
    if (!/^(1|true|on)$/i.test(process.env.MARINA_EVOLUTION_PROTOCOLS ?? "") || !this.db) return [];
    return this.db.listActiveEvolutionSessionsForParticipant(entityName).map((session) => ({
      id: session.id,
      experimentId: session.experiment_id,
    }));
  }

  broadcastToRoom(room: RoomId, message: string, tag?: string): void {
    const entities = this.entities.inRoom(room);
    for (const entity of entities) {
      this.sendToEntity(entity.id, message, tag);
    }
  }

  broadcastToRoomExcept(room: RoomId, exclude: EntityId, message: string, tag?: string): void {
    const sender = this.entities.get(exclude);
    const senderName = sender?.name;
    const entities = this.entities.inRoom(room);
    for (const entity of entities) {
      if (entity.id !== exclude) {
        if (senderName && isIgnoring(entity, senderName)) continue;
        this.sendToEntity(entity.id, message, tag);
      }
    }
  }

  // ─── Context Building ───────────────────────────────────────────────────

  buildContext(roomId: RoomId): RoomContext | undefined {
    const emitEvent = (event: EngineEvent) => this.logEvent(event);
    return this.rooms.buildContext(roomId, {
      send: (target, msg, tag?, metadata?) => this.sendToEntity(target, msg, tag, metadata),
      broadcast: (room, msg, tag?) => this.broadcastToRoom(room, msg, tag),
      broadcastExcept: (room, exclude, msg, tag?) =>
        this.broadcastToRoomExcept(room, exclude, msg, tag),
      entitiesInRoom: (room) => this.entities.inRoom(room),
      findEntity: (name, room) => this.entities.findByName(name, room),
      spawnNpc: (room, opts) => this.spawnNpc(room, opts),
      despawnNpc: (id) => this.despawnNpc(id),
      boards: this.buildBoardAPI(emitEvent),
      channels: this.buildChannelAPI(emitEvent),
      roomFetch: (room, url) => this.roomFetch(room, url),
      brief: (eid) => this.sendBrief(eid),
      logEvent: emitEvent,
      writeSample: this.db
        ? (params) =>
            writeSample({
              db: this.db!,
              sample: params.sample,
              authorName: params.authorName,
              watchSpecNoteId: params.watchSpecNoteId,
              previousSampleNoteId: params.previousSampleNoteId,
              emitEvent,
            })
        : undefined,
      spawnAgent: this.agentRuntime.isAvailable()
        ? async (config) => {
            try {
              const handle = await this.agentRuntime.spawn(config);
              const s = handle.getStatus();
              return { name: s.name, entityId: s.entityId };
            } catch {
              return null;
            }
          }
        : undefined,
      spawnRoomAgent:
        this.agentRuntime.isAvailable() && process.env.MARINA_ROOM_AGENTS !== "false"
          ? async (config) => {
              // Operator retired this seeded host — don't respawn it on room
              // entry (same disable registry the agent seeders honor).
              if (isSeedDisabled(this.db, config.name)) return null;
              // Idempotency: skip if entity with this name already exists
              const existing =
                this.entities.findByName(config.name, roomId) ??
                this.entities.findAgentByName(config.name);
              if (existing) return { entityId: existing.id as string };
              try {
                const handle = await this.agentRuntime.spawn({
                  ...config,
                  model: config.model ?? "marina/default",
                  room: roomId as string,
                });
                const s = handle.getStatus();
                // Move agent to the target room (it spawns in start room by default)
                if (s.entityId) {
                  this.entities.move(s.entityId as EntityId, roomId);
                }
                return { entityId: s.entityId as string | null };
              } catch (err) {
                this.logger.warn(
                  "room-agent",
                  `Failed to spawn "${config.name}" in ${roomId as string}: ${err instanceof Error ? err.message : err}`,
                );
                return null;
              }
            }
          : undefined,
    });
  }

  /** Send a "look" to an entity (used by move and login) */
  sendLook(entityId: EntityId): void {
    const entity = this.entities.get(entityId);
    if (!entity) return;
    this.processCommand(entityId, "look", { bypassModal: true });
  }

  /** Send a brief orientation to an entity (used on first login) */
  sendBrief(entityId: EntityId): void {
    const entity = this.entities.get(entityId);
    if (!entity) return;
    this.processCommand(entityId, "brief", { bypassModal: true });
  }

  /** Subscribe an entity to periodic brief pulses */
  subscribeBrief(entityId: EntityId, interval: number): void {
    this.briefManager.subscribe(entityId, interval);
  }

  /** Unsubscribe an entity from periodic brief pulses */
  unsubscribeBrief(entityId: EntityId): void {
    this.briefManager.unsubscribe(entityId);
  }

  /** Check if an entity is subscribed to brief pulses */
  isBriefSubscribed(entityId: EntityId): boolean {
    return this.briefManager.isSubscribed(entityId);
  }

  // ─── NPC Management ─────────────────────────────────────────────────────

  /** Spawn an NPC entity in a room (not tied to any connection) */
  spawnNpc(
    room: RoomId,
    opts: { name: string; short: string; long: string; properties?: Record<string, unknown> },
  ): EntityId {
    const entity = this.entities.create({
      kind: "npc",
      name: opts.name,
      short: opts.short,
      long: opts.long,
      room,
      properties: opts.properties,
    });
    return entity.id;
  }

  /** Remove an NPC entity. Returns false if not found or not an NPC. */
  despawnNpc(entityId: EntityId): boolean {
    const entity = this.entities.get(entityId);
    if (entity?.kind !== "npc") return false;
    this.entities.remove(entityId);
    return true;
  }

  /** Remove an entity from the engine (kick if connected, despawn if NPC/orphan). */
  async removeEntity(entityId: EntityId): Promise<{ ok: true; name: string } | { error: string }> {
    const entity = this.entities.get(entityId);
    if (!entity) {
      return { error: "Entity not found." };
    }
    const name = entity.name;

    // If a live agent is driving this entity, stop its loop and delete its
    // saved config first. Without this the agent loop keeps running against a
    // deleted entity, and persistent/room agents would simply respawn — so
    // "remove" wouldn't actually remove them from the Marina.
    if (this.agentRuntime.get(name)) {
      await tryLogAsync(this.logger, "entity", "Agent stop on removal failed", () =>
        this.agentRuntime.stop(name),
      );
    }

    // If the entity has an active connection, kick them. Use the "explicit"
    // intent so the entity is evicted immediately — the default "transient"
    // intent defers removal for RECONNECT_GRACE_MS (so a token-bearing
    // reconnect can rebind), which would leave a deleted entity lingering in
    // the live roster for up to a minute after an admin clicks Remove.
    const conn = this._connections.getConnectionForEntity(entityId);
    if (conn) {
      conn.send({
        kind: "system",
        timestamp: Date.now(),
        data: { text: "You have been removed by an admin." },
      });
      this.removeConnection(conn.id, "explicit");
    } else {
      // No connection — broadcast departure and remove directly
      const ctx = this.buildContext(entity.room);
      if (ctx) {
        ctx.broadcast(`${name} vanishes.`, "leave");
      }
      this.emitEntityLeave(entityId, entity.room);
      this.entities.remove(entityId);
    }

    // Clean up persisted data if db is available
    if (this.db) {
      const db = this.db;
      tryLog(this.logger, "entity", "DB delete failed", () => db.deleteEntity(entityId));
    }

    return { ok: true, name };
  }

  /** Promote entity to sovereign if listed in MARINA_ADMINS env var */
  private applyAdminBootstrap(entity: Entity, connId: string, identity?: LoginIdentity): void {
    // Auth mode: bind the verified identity to this named entity and grant admin
    // by VERIFIED EMAIL (MARINA_AUTH_ADMIN_EMAILS) — never by name. This closes
    // the name-based admin hole that makes name-login unsafe for public hosting.
    if (identity) {
      if (this.db) {
        const user = this.db.getUserByName(entity.name);
        if (user) this.db.bindAuthSubject(user.id, identity.subject, identity.email);
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
    if (this.config.authRequired) return;

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
    if (isLoopbackConnection(this._connections.get(connId))) {
      this.grantSovereign(entity);
    } else {
      this.logger.warn(
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
    if (this.db) {
      const user = this.db.getUserByName(entity.name);
      if (user) this.db.updateUserRank(user.id, 9);
      // A sovereign needs full capability immediately, not after earning
      // standing + demonstrations. Gate grants mirror the historical rank ladder.
      grantGatesForRank(this.db, entity.id, 9);
    }
  }

  /** Promote an entity to a rank if they are below it */
  /** @internal */ maybePromote(entityId: EntityId, toRank: EntityRank): void {
    const entity = this.entities.get(entityId);
    if (!entity || getRank(entity) >= toRank) return;
    setRank(entity, toRank);
    this.sendToEntity(entityId, `Your rank is now ${rankName(toRank)} (${toRank}).`);
    if (this.db) {
      const user = this.db.getUserByName(entity.name);
      if (user) this.db.updateUserRank(user.id, toRank);
      // Promotions to rank ≥ 5 grant the corresponding safety-gate set.
      // No-op below the safety threshold — the rank-0..4 tiers are
      // descriptive only and don't unlock gates.
      if (toRank >= 5) grantGatesForRank(this.db, entityId, toRank);
    }
  }

  /** Hot-reload a room module from the filesystem. */
  async reloadRoom(roomIdStr: string): Promise<string> {
    const id = roomIdStr as RoomId;
    if (!this.rooms.has(id)) {
      return `Room "${roomIdStr}" not found.`;
    }
    const baseDir = this.world?.roomsDir ?? join(import.meta.dir, "../../rooms");
    const filePath = join(baseDir, `${roomIdStr}.ts`);
    try {
      // Bust the module cache by appending a timestamp query
      const mod = await import(`${filePath}?t=${Date.now()}`);
      const room: RoomModule = mod.default ?? mod;
      if (!room.short || !room.long) {
        return "Reload failed: room module missing short or long.";
      }
      this.rooms.replace(id, room);
      return `Room "${roomIdStr}" reloaded successfully.`;
    } catch (err) {
      return `Reload failed: ${err}`;
    }
  }

  // ─── Room API Builders ─────────────────────────────────────────────────

  private buildBoardAPI(logEvent?: (event: EngineEvent) => void): RoomBoardAPI | undefined {
    if (!this.boardManager) return undefined;
    const bm = this.boardManager;
    return {
      getBoard(name: string) {
        const board = bm.getBoardByName(name);
        return board ? { id: board.id, name: board.name } : undefined;
      },
      listPosts(boardId: string, limit = 10) {
        return bm.listPosts(boardId, { limit }).map((p) => ({
          id: p.id,
          title: p.title,
          body: p.body,
          authorName: p.authorName,
          createdAt: p.createdAt,
        }));
      },
      post(boardId, authorId, authorName, title, body) {
        const p = bm.createPost({ boardId, authorId, authorName, title, body });
        const board = bm.getBoard(boardId);
        logEvent?.({
          type: "board_post",
          entity: authorId as EntityId,
          postId: p.id,
          boardId,
          boardName: board?.name ?? boardId,
          title,
          body,
          timestamp: Date.now(),
        });
        return p.id;
      },
      search(boardId, query) {
        return bm.searchPosts(boardId, query).map((p) => ({
          id: p.id,
          title: p.title,
          body: p.body,
          authorName: p.authorName,
        }));
      },
    };
  }

  private buildChannelAPI(logEvent?: (event: EngineEvent) => void): RoomChannelAPI | undefined {
    if (!this.channelManager) return undefined;
    const cm = this.channelManager;
    return {
      send(channelName, senderId, senderName, content) {
        const ch = cm.getChannelByName(channelName);
        if (ch) {
          cm.send(ch.id, senderId, senderName, content);
          logEvent?.({
            type: "channel_message",
            entity: senderId as EntityId,
            messageId: 0,
            channelName,
            content,
            timestamp: Date.now(),
          });
        }
      },
      history(channelName, limit = 20) {
        const ch = cm.getChannelByName(channelName);
        if (!ch) return [];
        return cm.getHistory(ch.id, limit).map((m) => ({
          senderName: m.senderName,
          content: m.content,
          createdAt: m.createdAt,
        }));
      },
      onMessage(channelName, handler) {
        return cm.onMessage((channelId, senderId, senderName, content) => {
          const ch = cm.getChannelByName(channelName);
          if (ch && ch.id === channelId) {
            handler(senderId, senderName, content);
          }
        });
      },
    };
  }

  // ─── Room Fetch (rate-limited HTTP) ─────────────────────────────────────

  private async roomFetch(
    room: RoomId,
    url: string,
  ): Promise<{ status: number; body: string } | { error: string }> {
    // Rate limit: 1 request per ROOM_FETCH_RATE_MS per room
    const now = Date.now();
    const lastCall = this.fetchLastCall.get(room) ?? 0;
    if (now - lastCall < ROOM_FETCH_RATE_MS) {
      return { error: "Rate limited. Wait before fetching again." };
    }
    this.fetchLastCall.set(room, now);

    // SSRF protection: block private/internal URLs
    const urlError = await validateFetchUrl(url);
    if (urlError) return { error: urlError };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ROOM_FETCH_TIMEOUT_MS);
      const response = await guardedFetch(url, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const body = await response.text();
      // Limit response size to 10KB
      return {
        status: response.status,
        body: body.length > 10240 ? body.slice(0, 10240) : body,
      };
    } catch (err) {
      return { error: `Fetch failed: ${getErrorMessage(err)}` };
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /** Get the entity ID bound to a connection */
  getConnectionEntity(connId: string): EntityId | null {
    return this._connections.getEntity(connId);
  }

  getEntityRoom(entityId: EntityId): LoadedRoom | undefined {
    const entity = this.entities.get(entityId);
    if (!entity) return undefined;
    return this.rooms.get(entity.room);
  }

  /** Find an entity by name across all rooms (for tell) */
  findEntityGlobal(name: string): Entity | undefined {
    const lower = name.toLowerCase();
    for (const entity of this.entities.all()) {
      if (entity.kind !== "agent") continue;
      if (entity.name.toLowerCase() === lower) return entity;
      if (entity.name.toLowerCase().startsWith(lower)) return entity;
    }
    return undefined;
  }

  getOnlineAgents(): Entity[] {
    return this.entities.all().filter((e) => {
      if (e.kind !== "agent") return false;
      return this._connections.isEntityConnected(e.id);
    });
  }

  /** Get connection for an entity (for quit command) */
  getConnectionForEntity(entityId: EntityId): Connection | undefined {
    return this._connections.getConnectionForEntity(entityId);
  }

  getEventLog(): EngineEvent[] {
    return this._eventLog.getAll();
  }

  setOtlpStatusProvider(provider: () => OtlpExporterStatus): void {
    this.otlpStatusProvider = provider;
  }

  getOtlpExporterStatus(): OtlpExporterStatus {
    return (
      this.otlpStatusProvider?.() ?? {
        enabled: false,
        pendingTraces: 0,
        exportedSpans: 0,
        rejectedSpans: 0,
        droppedTraces: 0,
        exportFailures: 0,
        consecutiveFailures: 0,
      }
    );
  }

  setOtlpLogStatusProvider(provider: () => OtlpLogExporterStatus): void {
    this.otlpLogStatusProvider = provider;
  }

  getOtlpLogExporterStatus(): OtlpLogExporterStatus {
    return (
      this.otlpLogStatusProvider?.() ?? {
        enabled: false,
        pendingLogs: 0,
        exportedLogs: 0,
        rejectedLogs: 0,
        droppedLogs: 0,
        exportFailures: 0,
        consecutiveFailures: 0,
      }
    );
  }

  /** @internal */ logEvent(event: EngineEvent): void {
    this._eventLog.log(event);
    // Crews react to agent stops — depart the crew when the agent goes away.
    if (event.type === "agent_stop" && this.crewManager) {
      this.crewManager.onAgentStopped(event.name);
    }
    // Standing ledger absorbs civic-contribution events (pool notes today;
    // more kinds wired as later phases land). Task standing stays on the
    // task path to preserve per-task.standing values.
    if (this.db) {
      const db = this.db;
      try {
        recordEngineCognition(db, event);
      } catch {
        // Optional provenance must never interrupt the canonical event path.
      }
      try {
        recordStandingEvent(
          db,
          event,
          (id) => this.entities.get(id as EntityId)?.name,
          (name) => this.entities.findAgentByName(name)?.id,
        );
      } catch {
        // Non-critical — standing accounting failures must never break the
        // event log. Cache invalidation happens on the next read regardless.
      }
      try {
        if (event.type === "agent_tool_call") {
          const entity = this.entities.findAgentByName(event.name);
          const promptVersion = this.agentRuntime.get(event.name)?.getStatus().promptVersion;
          db.recordPrimitiveUsage({
            actorId: entity ? String(entity.id) : undefined,
            actorName: event.name,
            actorKind: "agent",
            source: "agent_tool",
            primitive: isMarinaTool(event.toolName) ? "marina" : "reasoning",
            action: event.toolName,
            safeLabel: event.toolName,
            toolName: event.toolName,
            meaningful: false,
            worldAction: false,
            communication: false,
            createdAt: event.timestamp,
            promptVersion,
            riskClass: event.risk,
            trustSources: event.trustSources,
          });
        } else if (event.type === "agent_tool_result") {
          db.finishAgentToolUsage(event.name, event.toolName, !event.isError, event.timestamp);
        }
        if (event.type === "task_claimed") {
          const entity = this.entities.get(event.entity);
          if (entity) {
            const status = this.agentRuntime.get(entity.name)?.getStatus();
            db.startProductivitySession(
              String(event.entity),
              entity.name,
              event.taskId,
              event.timestamp,
              status?.toolCalls ?? 0,
              status?.promptVersion,
              status?.totalInputTokens ?? 0,
              status?.totalOutputTokens ?? 0,
              status?.totalCostUsd ?? 0,
            );
          }
        } else if (
          event.type === "task_approved" ||
          event.type === "task_rejected" ||
          event.type === "task_released"
        ) {
          const kind = event.type;
          const desired =
            kind === "task_approved"
              ? "approved"
              : kind === "task_rejected"
                ? "rejected"
                : "expired";
          const claims = db.getTaskClaims(event.taskId);
          const claim =
            kind === "task_released"
              ? claims.find((row) => row.entity_id === String(event.entity))
              : ([...claims].reverse().find((row) => row.status === desired) ??
                claims.find((row) => row.entity_id === String(event.entity)));
          if (claim) {
            const status = this.agentRuntime.get(claim.entity_name)?.getStatus();
            const recorded = db.finishProductivitySession(
              claim.entity_id,
              claim.entity_name,
              event.taskId,
              desired,
              event.timestamp,
              status?.toolCalls ?? 0,
              status?.totalInputTokens ?? 0,
              status?.totalOutputTokens ?? 0,
              status?.totalCostUsd ?? 0,
            );
            if (recorded) {
              this.agentRuntime.recordAttentionOutcome(
                claim.entity_name,
                desired === "approved" ? "success" : "failure",
              );
            }
          }
        }
      } catch {
        // Outcome learning is telemetry: never interrupt the underlying work event.
      }
    }
    this.notifyActionableEvent(event);
  }

  private notifyActionableEvent(event: EngineEvent): void {
    if (event.type === "canvas_intent" && event.status === "pending") {
      const prompt = event.prompt.length > 120 ? `${event.prompt.slice(0, 117)}...` : event.prompt;
      const message = `Pending canvas intent: "${prompt}" -> canvas intent claim ${event.nodeId.slice(0, 8)} or next`;
      for (const agent of this.agentRuntime.list()) {
        if (!agent.entityId || !["connected", "autonomous", "idle"].includes(agent.state)) {
          continue;
        }
        if (agent.entityId === event.entity || agent.name === event.entity) continue;
        this.sendToEntity(agent.entityId as EntityId, message, "canvas_intent", {
          canvasId: event.canvasId,
          nodeId: event.nodeId,
        });
      }
      return;
    }

    if (event.type === "canvas_intent" && event.status !== "pending" && this.db) {
      const node = this.db.getNode(event.nodeId);
      const requester = node?.creator_name ? this.findEntityGlobal(node.creator_name) : undefined;
      if (requester && requester.id !== event.entity) {
        const actor = this.entities.get(event.entity)?.name ?? String(event.entity);
        const prompt = event.prompt.length > 100 ? `${event.prompt.slice(0, 97)}...` : event.prompt;
        const message =
          event.status === "active"
            ? `${actor} claimed your canvas intent ${event.nodeId.slice(0, 8)}: "${prompt}"`
            : event.status === "done"
              ? `${actor} completed your canvas intent ${event.nodeId.slice(0, 8)}.`
              : `${actor} marked your canvas intent ${event.nodeId.slice(0, 8)} failed.`;
        this.sendToEntity(requester.id, message, "canvas_intent", {
          canvasId: event.canvasId,
          nodeId: event.nodeId,
          status: event.status,
        });
      }
      return;
    }

    if (event.type === "task_claimed" && this.taskManager) {
      const task = this.taskManager.get(event.taskId);
      if (!task || task.creatorId === event.entity) return;
      const claimant = this.entities.get(event.entity)?.name ?? "Someone";
      this.sendToEntity(
        task.creatorId as EntityId,
        `${claimant} claimed task #${event.taskId}: ${task.title}`,
        "task",
        { taskId: event.taskId },
      );
      return;
    }

    if (
      event.type === "crew_created" ||
      event.type === "crew_member_joined" ||
      event.type === "crew_state_changed" ||
      event.type === "crew_completed" ||
      event.type === "crew_dissolved" ||
      event.type === "crew_member_stalled" ||
      event.type === "crew_stage_completed" ||
      event.type === "crew_artifact_deposited"
    ) {
      this.notifyCrewEvent(event);
    }
  }

  private notifyCrewEvent(
    event: Extract<
      EngineEvent,
      {
        type:
          | "crew_created"
          | "crew_member_joined"
          | "crew_state_changed"
          | "crew_completed"
          | "crew_dissolved"
          | "crew_member_stalled"
          | "crew_stage_completed"
          | "crew_artifact_deposited";
      }
    >,
  ): void {
    if (!this.crewManager) return;
    const crew = this.crewManager.get(event.crew);
    if (!crew) return;

    const message =
      event.type === "crew_created"
        ? `Crew "${crew.name}" created for: ${crew.goal || "(no goal)"}`
        : event.type === "crew_member_joined"
          ? `${event.agentName} joined crew "${crew.name}" as ${event.role}.`
          : event.type === "crew_state_changed"
            ? `Crew "${crew.name}" state changed: ${event.from} -> ${event.to}.`
            : event.type === "crew_completed"
              ? `Crew "${crew.name}" completed.${event.resultNoteId ? ` Note ${event.resultNoteId}.` : ""}`
              : event.type === "crew_dissolved"
                ? `Crew "${crew.name}" dissolved: ${event.reason}.`
                : event.type === "crew_member_stalled"
                  ? `${event.agentName} was flagged stalled in crew "${crew.name}": ${event.reason}.`
                  : event.type === "crew_stage_completed"
                    ? `${event.agentName} completed crew "${crew.name}" stage: ${event.stage}.`
                    : `${event.agentName} deposited ${event.kind} artifact for crew "${crew.name}": ${event.artifactRef}.`;

    const targets = new Set<EntityId>();
    for (const member of crew.members) {
      const entity = this.findEntityGlobal(member.agentName);
      if (entity) targets.add(entity.id);
    }
    targets.add(crew.ownerId);
    for (const target of targets) {
      this.sendToEntity(target, message, "crew", { crewId: crew.id, eventType: event.type });
    }
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  /** Save all world state to the database */
  saveWorldState(): void {
    if (!this.db) return;
    this.db.saveAllEntities(this.entities.all());
    for (const room of this.rooms.all()) {
      for (const key of room.store.keys()) {
        this.db.setRoomStoreValue(room.id, key, room.store.get(key));
      }
    }
    this.logger.info("engine", "World state saved to database.");
  }

  /** Load world state from the database */
  loadWorldState(): void {
    if (!this.db) return;
    const entities = this.db.loadAllEntities();
    let maxId = 0;
    let relocated = 0;
    for (const entity of entities) {
      // If the entity's saved room doesn't exist in the current world,
      // relocate them to the start room so they aren't stuck in limbo.
      if (!this.rooms.has(entity.room)) {
        entity.room = this.config.startRoom;
        relocated++;
      }
      this.entities.restore(entity);
      const match = entity.id.match(/^e_(\d+)$/);
      if (match) {
        const num = Number.parseInt(match[1]!, 10);
        if (num > maxId) maxId = num;
      }
    }
    if (maxId > 0) {
      this.entities.setNextId(maxId + 1);
    }
    this.dedupeAgentEntities();
    for (const room of this.rooms.all()) {
      const keys = this.db.getRoomStoreKeys(room.id);
      for (const key of keys) {
        const value = this.db.getRoomStoreValue(room.id, key);
        if (value !== undefined) {
          this.rooms.restoreStoreData(room.id, key, value);
        }
      }
    }
    if (relocated > 0) {
      this.logger.info(
        "engine",
        `Relocated ${relocated} entities to ${this.config.startRoom} (room no longer exists).`,
      );
    }
    this.logger.info("engine", `Restored ${entities.length} entities from database.`);
  }

  /**
   * Collapse duplicate same-named agent entities after a restore.
   *
   * A login only ever binds (and a reconnect only rebinds) ONE entity per name
   * via `findAgentByName`, so any extra rows sharing that name are invisible
   * ghosts — but `loadAllEntities` restores every row and the dashboard lists
   * them all, so a name can appear several times. These accumulate from older
   * respawn-on-reconnect behavior, crashes mid-session, or restore races.
   *
   * Keep the strongest survivor per name (highest rank, then most recently
   * created) and delete the rest from memory + DB. Safe because reconnect
   * rebinds by NAME, not by the token's original entity id, so the user's
   * next reconnect lands on the survivor and keeps its persisted state.
   */
  private dedupeAgentEntities(): void {
    const byName = new Map<string, Entity[]>();
    for (const e of this.entities.all()) {
      if (e.kind !== "agent") continue;
      const key = e.name.toLowerCase();
      const list = byName.get(key);
      if (list) list.push(e);
      else byName.set(key, [e]);
    }

    let removed = 0;
    for (const list of byName.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => {
        const rankA = (a.properties.rank as number) ?? 0;
        const rankB = (b.properties.rank as number) ?? 0;
        if (rankB !== rankA) return rankB - rankA; // highest rank wins
        return (b.createdAt ?? 0) - (a.createdAt ?? 0); // then most recent
      });
      for (const dupe of list.slice(1)) {
        this.entities.remove(dupe.id); // removes in-memory + deletes the DB row
        removed++;
      }
      this.logger.warn(
        "engine",
        `Collapsed ${list.length} duplicate "${list[0]!.name}" entities → kept ${list[0]!.id}`,
      );
    }

    if (removed > 0) {
      this.logger.warn("engine", `Removed ${removed} duplicate agent entity row(s) on restore.`);
    }
  }

  /** Load rooms stored in the DB (dynamic/built rooms) */
  async loadDynamicRooms(): Promise<number> {
    if (!this.db) return 0;
    const roomIds = this.db.getAllRoomSourceIds();
    let loaded = 0;
    for (const roomId of roomIds) {
      // Skip rooms already loaded from files
      if (this.rooms.has(roomId as RoomId)) continue;

      const source = this.db.getRoomSource(roomId);
      if (!source?.valid) continue;

      try {
        const module = await compileRoomModule(source.source);
        this.registerRoom(roomId as RoomId, module);
        loaded++;
      } catch (err) {
        this.logger.error("engine", `Failed to load dynamic room ${roomId}`, {
          error: getErrorMessage(err),
        });
      }
    }
    if (loaded > 0) {
      this.logger.info("engine", `Loaded ${loaded} dynamic rooms from database.`);
    }
    return loaded;
  }

  /** Load dynamic commands stored in the DB */
  async loadDynamicCommands(): Promise<number> {
    if (!this.db) return 0;
    const names = this.db.getAllValidCommandNames();
    let loaded = 0;
    for (const name of names) {
      const cmd = this.db.getCommandByName(name);
      if (!cmd) continue;
      try {
        const compiled = await compileCommandModule(cmd.source);
        this.commands.registerBuiltin(compiled);
        loaded++;
      } catch (err) {
        this.logger.error("engine", `Failed to load dynamic command "${name}"`, {
          error: getErrorMessage(err),
        });
      }
    }
    if (loaded > 0) {
      this.logger.info("engine", `Loaded ${loaded} dynamic commands from database.`);
    }
    return loaded;
  }

  /** Initialize the connector runtime (call after construction) */
  async initConnectors(): Promise<void> {
    if (!this.connectorRuntime) return;
    const available = await this.connectorRuntime.init();
    if (available) {
      await this.connectorRuntime.loadFromDB();
    }
  }

  /** Initialize the agent runtime. Auto-respawns saved agents only if AGENT_AUTORESPAWN=true. */
  async initAgents(wsPort?: number): Promise<void> {
    if (wsPort) {
      // Keep the original runtime object: command handlers, media resolution,
      // and other engine services already hold references to it.
      this.agentRuntime.setWsPort(wsPort);
    }
    const autoRespawn = process.env.AGENT_AUTORESPAWN === "true";
    if (!autoRespawn) {
      this.logger.info(
        "agents",
        "Agent auto-respawn disabled (set AGENT_AUTORESPAWN=true to enable)",
      );
      return;
    }
    const count = await this.agentRuntime.init();
    if (count > 0) {
      this.logger.info("agents", `Auto-respawned ${count} agent(s)`);
    }
    // World hook for runtime constructs that depend on live agents
    // (e.g. crews referencing seeded agent names). Idempotent by contract.
    if (this.world?.afterAgentsReady) {
      try {
        await this.world.afterAgentsReady(this);
      } catch (err) {
        this.logger.warn("world", `afterAgentsReady failed: ${(err as Error).message}`);
      }
    }
  }

  /** Initialize the gateway runtime (call after construction) */
  async initGateways(): Promise<void> {
    if (!this.gatewayRuntime) return;
    await this.gatewayRuntime.loadFromDB();
  }

  /** Build a CommandContext for dynamic commands (extends RoomContext) */
  buildCommandContext(roomId: RoomId, entityId: EntityId): CommandContext | undefined {
    const base = this.buildContext(roomId);
    if (!base) return undefined;

    const entity = this.entities.get(entityId);
    if (!entity) return undefined;

    const db = this.db;
    const runtime = this.connectorRuntime;
    const entityName = entity.name;
    const rank = (entity.properties.rank as number) ?? 0;

    return {
      ...base,
      mcp: {
        call: async (server, tool, args) => {
          if (!runtime?.isAvailable()) throw new Error("Connector runtime not available.");
          return runtime.callTool(server, tool, args, entityId);
        },
        listTools: async (server) => {
          if (!runtime?.isAvailable()) return [];
          return runtime.listTools(server);
        },
        listServers: () => runtime?.listServers() ?? [],
      },
      http: {
        get: async (url) => {
          if (!runtime) return { error: "HTTP not available." };
          return runtime.httpGet(url, entityId);
        },
        post: async (url, body) => {
          if (!runtime) return { error: "HTTP not available." };
          return runtime.httpPost(url, body, entityId);
        },
      },
      notes: {
        recall: (query) => {
          if (!db) return [];
          return db.recallNotes(entityName, query).map((n) => ({
            id: n.id,
            content: n.content,
            importance: n.importance,
            score: n.score,
          }));
        },
        search: (query) => {
          if (!db) return [];
          return db.searchNotes(entityName, query).map((n) => ({
            id: n.id,
            content: n.content,
            importance: n.importance,
          }));
        },
        add: (content, importance, noteType) => {
          if (!db) return -1;
          return db.createNote(entityName, content, roomId, { importance, noteType });
        },
      },
      memory: {
        get: (key) => db?.getCoreMemory(entityName, key)?.value,
        set: (key, value) => db?.setCoreMemory(entityName, key, value),
        list: () => {
          if (!db) return [];
          return db.listCoreMemory(entityName).map((m) => ({
            key: m.key,
            value: m.value,
          }));
        },
      },
      pool: {
        recall: (poolName, query) => {
          if (!db) return [];
          const pool = db.getMemoryPool(poolName);
          if (!pool) return [];
          return db.recallPoolNotes(pool.id, query).map((n) => ({
            id: n.id,
            content: n.content,
            score: n.score,
          }));
        },
        add: (poolName, content, importance) => {
          if (!db) return;
          const pool = db.getMemoryPool(poolName);
          if (!pool) return;
          db.addPoolNote(pool.id, entityName, content, importance);
        },
      },
      caller: { id: entityId, name: entityName, rank },
    };
  }

  /** Remove agents that have no active connection (ghost entities). */
  private cleanupOrphanedAgents(): void {
    const agents = this.entities.all().filter((e) => e.kind === "agent");
    for (const agent of agents) {
      if (!this._connections.isEntityConnected(agent.id)) {
        // Orphaned agent — clean up silently
        this._connections.unbindEntity(agent.id);
        const ctx = this.buildContext(agent.room);
        if (ctx) {
          ctx.broadcastExcept(agent.id, `${agent.name} fades away.`, "leave");
        }
        this.emitEntityLeave(agent.id, agent.room);
        this.entities.remove(agent.id);
      }
    }
  }

  /** Save world state and stop the engine */
  shutdown(): void {
    this.saveWorldState();
    this.stop();
    // Close connector and gateway runtimes (fire and forget)
    this.connectorRuntime?.close().catch(() => {});
    this.gatewayRuntime?.close().catch(() => {});
  }

  // ─── Built-in Command Registration ──────────────────────────────────────

  private registerBuiltinCommands(): void {
    registerBuiltinCommands(this);
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────

/** Fisher-Yates shuffle — mutates array in place. */
function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}
