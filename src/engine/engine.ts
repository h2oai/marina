import { localHttpBase } from "../net/listen-ports";
import { MARINA_ROOT } from "../runtime-paths";
import { AuthCoordinator, type LoginIdentity, type LoginResult } from "./auth-coordinator";
import { autoRespawnEnabled } from "./auto-respawn";
import { releaseChallengeHost } from "./challenges";
import { CommandCoordinator } from "./command-coordinator";
import { type CommandExecutionOptions, CommandPhaseCoordinator } from "./command-phase-coordinator";
import { RoomTickCoordinator } from "./room-tick-coordinator";
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { AgentRuntime, getInternalModelToken } from "../agent/agent-runtime";
import { applyRankProgression } from "../agent/rank-progression";
import { isSeedDisabled } from "../agent/seed-registry";
import { recordFromEvent as recordStandingEvent } from "../agent/standing";
import type { RateLimiter } from "../auth/rate-limiter";
import { SessionManager } from "../auth/session-manager";
import { BoardManager } from "../coordination/board-manager";
import { ChannelManager } from "../coordination/channel-manager";
import { CrewManager } from "../coordination/crew-manager";
import { GroupManager } from "../coordination/group-manager";
import { MacroManager } from "../coordination/macro-manager";
import { TaskManager } from "../coordination/task-manager";
import { FlywheelManager, type FlywheelToolBackend } from "../integrations/flywheel-manager";
import { memoryAccess } from "../memory/access";
import { residentMemoryAPI } from "../memory/resident-service";
import type { AdapterManager } from "../net/adapter-manager";
import { connects } from "../net/ansi";
import { guardedFetch, validateFetchUrl } from "../net/url-guard";
import type { MarinaDB } from "../persistence/database";
import { writeSample } from "../resolvers/sample-writer";
import type { StorageProvider } from "../storage/provider";
import type { OtlpExporterStatus } from "../telemetry/otlp-exporter";
import type { OtlpLogExporterStatus } from "../telemetry/otlp-log-exporter";
import { isMarinaTool } from "../telemetry/primitive-usage";
import type {
  CommandContext,
  Connection,
  EngineEvent,
  Entity,
  EntityId,
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
import { stopCodeStreamsFor } from "./commands/code/stream";
import { isIgnoring } from "./commands/ignore";
import { ConnectionManager } from "./connection-manager";
import { ConnectorRuntime } from "./connector-runtime";
import { positiveNumberFromEnv, ROOM_FETCH_RATE_MS, ROOM_FETCH_TIMEOUT_MS } from "./constants";
import { sanitizeEntityName } from "./entity-name";
import { getErrorMessage, tryLog, tryLogAsync } from "./errors";
import { EventLog } from "./event-log";
import { GatewayRuntime } from "./gateway-runtime";
import { Logger } from "./logger";
import { MediaManager } from "./media/manager";
import { engineSharedWriteHook } from "./memory-dispatch";
import { getRank, rankName } from "./permissions";
import { computeReadiness } from "./readiness";
import { RoomSandbox } from "./room-sandbox";
import { compileCommandModule, compileRoomModule } from "./sandbox";
import { ShellRuntime } from "./shell-runtime";
import { attachSpendLedger, dbSpendSink } from "./spend-ledger";
import { registerTickJobs } from "./tick-jobs";
import { type TickJobStatus, TickScheduler } from "./tick-scheduler";

/** Identical tick-failure messages are logged at most once per this interval. */
const TICK_ERROR_LOG_INTERVAL_MS = 30_000;
/** Longest `shutdown()` waits for detached work and async tick jobs (under main.ts's 30 s watchdog). */
export const BACKGROUND_DRAIN_TIMEOUT_MS = 10_000;

export type { LoginIdentity } from "./auth-coordinator";

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

/**
 * Wall-clock budget for the per-tick command phase: dispatch plus each
 * command's synchronous prefix (parse, gate checks, the handler up to its
 * first `await`). Sibling of the 200 ms room-tick budget; queued commands the
 * budget stops are kept for the next tick in the same per-entity FIFO order.
 * `MAX_COMMANDS_PER_TICK` still bounds the count. Override:
 * `MARINA_COMMAND_PHASE_BUDGET_MS`.
 */
export const COMMAND_PHASE_BUDGET_MS =
  positiveNumberFromEnv("MARINA_COMMAND_PHASE_BUDGET_MS") ?? 150;

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
  /** Detached DB-writing work (`trackBackground`), drained by `shutdown()`. */
  private readonly background = new Set<Promise<unknown>>();
  /** Periodic (`tick % every === phase`) maintenance jobs; see `registerTickJobs()`. */
  private readonly tickScheduler: TickScheduler;
  /** @internal */ readonly _connections: ConnectionManager;
  /** @internal — backward-compatible accessor for the raw connections map */
  get connections(): Map<string, Connection> {
    return this._connections.getAll();
  }
  /** Human-readable instance name (from MARINA_NAME env, world name, or "Marina"). */
  get instanceName(): string {
    return this.config.instanceName ?? this.world?.name ?? "Marina";
  }
  private readonly authCoordinator: AuthCoordinator;
  private readonly commandPhaseCoordinator: CommandPhaseCoordinator;
  private readonly commandCoordinator = new CommandCoordinator(
    (entity, raw) => this.processCommand(entity, raw),
    (error) => this.recordTickError(error),
  );
  private readonly roomTickCoordinator = new RoomTickCoordinator(
    (id) => this.buildContext(id),
    (message, fields) => this.logger.warn("tick", message, fields),
  );
  /** @internal — test seam for the command-phase budget. */
  commandPhaseBudgetMs = COMMAND_PHASE_BUDGET_MS;
  /** @internal */ readonly _eventLog: EventLog;
  /** @internal — backward-compatible accessor for the raw event array */
  get eventLog(): EngineEvent[] {
    return this._eventLog.getAll();
  }
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false;
  private tickCount = 0;
  /** Ticks whose body threw. Caught and logged; the loop always continues. */
  private _tickErrors = 0;
  private lastTickErrorMessage = "";
  private lastTickErrorLoggedAt = 0;
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
    this.db?.onResourceChange((change) =>
      this.logEvent({ type: "resource_changed", ...change, timestamp: Date.now() }),
    );
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
        logger: this.logger,
      });
      // Reattach persisted crews from previous boot. Idempotent.
      this.crewManager.loadFromDb();

      // Daily spend ledger: this world's upstream dollars, persisted by day, so
      // MARINA_DAILY_SPEND_CAP_USD survives a restart (src/engine/spend-ledger.ts).
      const spendDb = this.db;
      // Command-line processes on the same DB_PATH attach the same ledger, so
      // the day's total is shared across processes (re-read on every check).
      spendDb.onClose(
        attachSpendLedger(
          dbSpendSink(spendDb, (error) =>
            tryLog(this.logger, "spend", "Daily spend not recorded", () => {
              throw error;
            }),
          ),
        ),
      );

      // Benchmark runner — spawns the harness subprocess + persists runs
      this.benchmarkRunner = new BenchmarkRunner(
        this.db,
        (event) => this.logEvent(event),
        () => ({
          endpoint: localHttpBase(),
          apiKey: getInternalModelToken(),
        }),
      );

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
            this.logger.warn(
              "gateway",
              `dropped relayed tell from ${senderLabel}: no recoverable local target (not broadcasting)`,
            );
            return;
          }
          const recipient =
            this.entities.findAgentByName(target) ??
            this.entities.all().find((e) => e.name.toLowerCase() === target.toLowerCase());
          if (!recipient) {
            this.logger.warn(
              "gateway",
              `dropped relayed tell from ${senderLabel}: local target "${target}" not found`,
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

    const engine = this;
    this.authCoordinator = new AuthCoordinator({
      config: this.config,
      get db() {
        return engine.db;
      },
      sessionManager: this.sessionManager,
      loginRateLimiter: this.loginRateLimiter,
      connections: this._connections,
      entities: this.entities,
      briefs: this.briefManager,
      logger: this.logger,
      world: this.world,
      spawnEntity: (id, name) => this.spawnEntity(id, name),
      dispatchCommand: (id, raw) => this.dispatchCommand(id, raw),
      buildContext: (room) => this.buildContext(room),
      logEvent: (event) => this.logEvent(event),
    });
    this.commandPhaseCoordinator = new CommandPhaseCoordinator({
      entities: this.entities,
      rooms: this.rooms,
      commands: this.commands,
      get db() {
        return engine.db;
      },
      macroManager: this.macroManager,
      logger: this.logger,
      promptVersion: (name) => this.agentRuntime.get(name)?.getStatus().promptVersion,
      sendToEntity: (id, message) => this.sendToEntity(id, message),
      processCommand: (id, raw) => this.processCommand(id, raw),
      checkRateLimit: (id) => this.checkRateLimit(id),
      buildCommandContext: (room, id) => this.buildCommandContext(room, id),
      buildContext: (room) => this.buildContext(room),
      logEvent: (event) => this.logEvent(event),
    });

    this.registerBuiltinCommands();
    this.tickScheduler = new TickScheduler(this.logger);
    this.registerTickJobs();
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

  removeConnection(connId: string, intent: "transient" | "explicit" = "transient"): void {
    const entityId = this._connections.get(connId)?.entity;
    if (entityId) stopCodeStreamsFor(entityId);
    this.authCoordinator.removeConnection(connId, intent);
  }

  /** World lifecycle uses the same leave event for disconnects and explicit despawns. */
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

  login(
    connId: string,
    name: string,
    internalToken?: string,
    identity?: LoginIdentity,
  ): LoginResult {
    return this.authCoordinator.login(connId, name, internalToken, identity);
  }

  reconnect(connId: string, token: string, internalToken?: string): LoginResult {
    return this.authCoordinator.reconnect(connId, token, internalToken);
  }

  authenticate(token: string): EntityId | null {
    return this.authCoordinator.authenticate(token);
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

  /** Queue a command from a connected entity. */
  queueCommand(entity: EntityId, raw: string): void {
    if (!this.commandCoordinator.enqueue(entity, raw)) this.notifyCommandOverloaded(entity);
  }
  get commandAdmission() {
    return this.commandCoordinator.snapshot();
  }
  /** Finite admitted background work participates in the existing shutdown drain. */
  trackBackgroundCommand(pending: Promise<void>): void {
    this.commandCoordinator.track(
      pending.catch((error) => {
        this.logger.error("background-command", getErrorMessage(error));
      }),
    );
  }
  /** Settle queued and directly admitted commands before persistence closes. */
  async drainCommands(): Promise<void> {
    await this.roomTickCoordinator.drain();
    await this.commandCoordinator.drain();
  }
  get queuedCommandCount(): number {
    return this.commandCoordinator.queuedCount;
  }

  /**
   * Execute NOW, outside admission and the per-entity FIFO. Only for work that
   * already runs inside the entity's slot (macro expansion, `batch`) or for
   * tests; every ingress (transport, engine housekeeping, challenge re-run)
   * goes through `dispatchCommand()`.
   */
  processCommand(entityId: EntityId, raw: string, opts?: CommandExecutionOptions): Promise<void> {
    return this.commandCoordinator.track(this.commandPhaseCoordinator.execute(entityId, raw, opts));
  }

  /** Transport admission; nested commands continue through processCommand to avoid deadlock. */
  submitCommand(entityId: EntityId, raw: string, execute: () => Promise<void>): boolean {
    return this.commandCoordinator.submit(entityId, raw, execute);
  }

  /**
   * The ingress path for one command: bounded admission, then strict
   * per-entity FIFO behind anything this entity already queued. Resolves
   * `true` once the command has run, `false` when admission refused it
   * (capacity) — then the entity is told unless `notify: false`.
   *
   * Re-entrant: a caller already running inside this entity's slot (a
   * handler, a macro expansion, a command the slot is awaiting) executes
   * inline, because queuing behind its own running slot would never start.
   */
  dispatchCommand(
    entityId: EntityId,
    raw: string,
    opts?: CommandExecutionOptions & { notify?: boolean },
  ): Promise<boolean> {
    // Preserve the admitted destination while queued; execute validates the copied target.
    const executionOptions = opts && {
      ...opts,
      ...(opts.codingTarget ? { codingTarget: { ...opts.codingTarget } } : {}),
    };
    const run = () => this.commandPhaseCoordinator.execute(entityId, raw, executionOptions);
    if (this.commandCoordinator.isInSlot(entityId)) {
      return this.commandCoordinator.track(run()).then(
        () => true,
        (error) => {
          // Same destination as a slot's throw: the tick error path.
          this.recordTickError(error);
          return true;
        },
      );
    }
    return new Promise<boolean>((resolve) => {
      const admitted = this.commandCoordinator.submit(entityId, raw, async () => {
        try {
          await run();
        } finally {
          resolve(true);
        }
      });
      if (admitted) return;
      if (opts?.notify !== false) this.notifyCommandOverloaded(entityId);
      resolve(false);
    });
  }

  private notifyCommandOverloaded(entity: EntityId): void {
    this._connections.sendToEntity(entity, {
      kind: "error",
      timestamp: Date.now(),
      data: {
        text: "World command capacity reached. Retry shortly; this command did not execute.",
        code: "command_overloaded",
        retryable: true,
        executed: false,
      },
    });
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
    // Crew fallback timers are armed by dispatch, not by start(), so a
    // constructed-but-never-started engine (tests, aborted boots) can own
    // live timers. Tear them down before the running guard so stop() is
    // always a complete teardown.
    this.crewManager?.stop();
    this.authCoordinator.stop();
    if (!this.running) return;
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.mediaManager?.stop();
    this.logger.info("engine", "Marina engine stopped.");
  }

  /** Number of ticks whose body threw (each was caught; the loop kept running). */
  get tickErrors(): number {
    return this._tickErrors;
  }

  /** Snapshot of the periodic tick schedule (name / every / phase / last run) for operators. */
  describeTickSchedule(): TickJobStatus[] {
    return this.tickScheduler.describe();
  }

  /**
   * Declare the periodic maintenance jobs. The schedule itself lives in
   * `tick-jobs.ts`; this only supplies the engine's collaborators as LAZY
   * getters, because registration happens in the constructor while `db` and
   * the managers may be assigned afterwards — a job must see the current
   * value when it fires. → docs/architecture/persistence.md
   */
  private registerTickJobs(): void {
    const engine = this;
    registerTickJobs(
      {
        engine,
        get db() {
          return engine.db;
        },
        get logger() {
          return engine.logger;
        },
        get config() {
          return engine.config;
        },
        get channelManager() {
          return engine.channelManager;
        },
        get boardManager() {
          return engine.boardManager;
        },
        get taskManager() {
          return engine.taskManager;
        },
        get agentRuntime() {
          return engine.agentRuntime;
        },
        get flywheel() {
          return engine.flywheel;
        },
        readiness: () => computeReadiness(engine),
        cleanupOrphanedAgents: () => engine.cleanupOrphanedAgents(),
        applyRankProgression: (db) => engine.applyRankProgressionToOnlineEntities(db),
      },
      this.tickScheduler,
    );
  }

  private applyRankProgressionToOnlineEntities(db: MarinaDB): void {
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

  private tick(): void {
    // Re-entrancy guard: prevent overlapping ticks from setInterval
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.tickInner();
    } catch (err) {
      // A throw here (e.g. SQLITE_BUSY past the busy timeout) would otherwise
      // escape setInterval → uncaughtException → shutdown(1). Log and carry on;
      // the next tick retries whatever failed.
      this.recordTickError(err);
    } finally {
      this.ticking = false;
    }
  }

  /** Count + log a tick failure, collapsing identical messages to one log line per 30 s. */
  private recordTickError(err: unknown): void {
    this._tickErrors++;
    const message = getErrorMessage(err);
    const now = Date.now();
    const repeat =
      message === this.lastTickErrorMessage &&
      now - this.lastTickErrorLoggedAt < TICK_ERROR_LOG_INTERVAL_MS;
    if (repeat) return;
    this.lastTickErrorMessage = message;
    this.lastTickErrorLoggedAt = now;
    this.logger.error("tick", "Tick failed; loop continues", {
      error: message,
      tick: this.tickCount,
      tickErrors: this._tickErrors,
    });
  }

  private tickInner(): void {
    this.tickCount++;
    tryLog(this.logger, "tick", "Sandbox tick failed", () => this.sandbox.tick());

    // Lease expiry is persisted coordination state. Recover abandoned work
    // before entities inspect the queue on this tick.
    tryLog(this.logger, "tick", "Task lease recovery failed", () => {
      for (const claim of this.taskManager?.recoverExpired() ?? []) {
        this.logEvent({
          type: "task_released",
          entity: claim.entityId as EntityId,
          taskId: claim.taskId,
          reason: "lease_expired",
          timestamp: Date.now(),
        });
      }
    });
    tryLog(this.logger, "tick", "Direct-message expiry failed", () => {
      this.db?.expireDirectMessages();
    });

    // Admission/FIFO/budget semantics live behind an independently testable boundary.
    this.commandCoordinator.runPhase(this.commandPhaseBudgetMs);

    this.roomTickCoordinator.run(this.rooms.all());

    // 3. Every tick: crew idle GC + dissolved cleanup. Cheap (in-memory map walk).
    if (this.crewManager) {
      const crews = this.crewManager;
      tryLog(this.logger, "tick", "Crew tick failed", () => crews.tick());
    }

    // 4. Periodic maintenance — the declarative schedule built in
    //    `registerTickJobs()` (boards auto-archive, channel pruning, note
    //    importance, standing, hygiene, retention, rank progression, …).
    this.tickScheduler.runDue(this.tickCount);

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
    void this.dispatchCommand(entityId, "look", { bypassModal: true });
  }

  /** Send a brief orientation to an entity (used on first login) */
  sendBrief(entityId: EntityId): void {
    const entity = this.entities.get(entityId);
    if (!entity) return;
    void this.dispatchCommand(entityId, "brief", { bypassModal: true });
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

  /** Hot-reload a room module from the filesystem. */
  async reloadRoom(roomIdStr: string): Promise<string> {
    const id = roomIdStr as RoomId;
    if (!this.rooms.has(id)) {
      return `Room "${roomIdStr}" not found.`;
    }
    const baseDir = this.world?.roomsDir ?? join(MARINA_ROOT, "rooms");
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
    // Two passes, exact first: the old single-pass exact-or-prefix test meant
    // a prefix match on an earlier-iterated entity beat an exact match on a
    // later one ("tell Alex ..." reached Alexandra when Alex existed).
    const lower = name.toLowerCase();
    const agents = this.entities.all().filter((entity) => entity.kind === "agent");
    return (
      agents.find((entity) => entity.name.toLowerCase() === lower) ??
      agents.find((entity) => entity.name.toLowerCase().startsWith(lower))
    );
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
    // Pool deposits by crew members echo on their crew channels (dedup
    // visibility). Both write paths: share/pool-add emit pool_note with the
    // name inline; `note … pool:<x>` emits note_created with poolId.
    if (this.crewManager) {
      if (event.type === "pool_note") {
        const name = this.entities.get(event.entity)?.name;
        if (name) this.crewManager.onMemberPoolDeposit(name, event.poolName, event.content);
      } else if (event.type === "note_created" && event.poolId && this.db) {
        const poolName = this.db.listMemoryPools().find((p) => p.id === event.poolId)?.name;
        if (poolName) {
          this.crewManager.onMemberPoolDeposit(event.authorName, poolName, event.content);
        }
      }
    }
    // Low-standing shared write → evaluator review (memory-dispatch.ts).
    // Fire-and-forget: the hook returns synchronously and never awaits here;
    // skipped under the `local` profile, silent under shared/public.
    if (event.type === "pool_note" && this.db) {
      engineSharedWriteHook(this, event);
    } else if (event.type === "note_created" && event.poolId && this.db) {
      // Same trigger for the other pool write path (`note … pool:<x>`), which
      // emits note_created with a poolId instead of pool_note.
      const poolName = this.db.getMemoryPoolById(event.poolId)?.name;
      if (poolName) {
        engineSharedWriteHook(this, {
          type: "pool_note",
          entity: event.entity,
          noteId: event.noteId,
          poolName,
          content: event.content,
          importance: event.importance,
          timestamp: event.timestamp,
        });
      }
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
        this.commands.registerOwned(`dynamic:${name}`, compiled, true);
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

  /**
   * Initialize the agent runtime. Auto-respawns saved agents when
   * AGENT_AUTORESPAWN=true, or — unset — on a local install with a usable
   * provider ({@link autoRespawnEnabled}).
   */
  async initAgents(wsPort?: number): Promise<void> {
    if (wsPort) {
      // Keep the original runtime object: command handlers, media resolution,
      // and other engine services already hold references to it.
      this.agentRuntime.setWsPort(wsPort);
    }
    const autoRespawn = autoRespawnEnabled(this.agentRuntime.isAvailable());
    if (!autoRespawn) {
      this.logger.info(
        "agents",
        process.env.AGENT_AUTORESPAWN?.trim()
          ? "Agent auto-respawn disabled (AGENT_AUTORESPAWN)"
          : "Agent auto-respawn off (no usable provider, or not a local install; set AGENT_AUTORESPAWN=true to enable)",
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
      durableMemory: residentMemoryAPI(db, () => this.entities.get(entityId)?.name),
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
        // Same ACL as the `pool` command: members-only (group-scoped) pools are
        // invisible to non-members — recall returns [] and add is a no-op.
        recall: (poolName, query) => {
          if (!db) return [];
          const pool = db.getMemoryPool(poolName);
          if (!memoryAccess(db, { name: entityName, id: entityId }).pool(pool)) return [];
          return db.recallPoolNotes(pool!.id, query).map((n) => ({
            id: n.id,
            content: n.content,
            score: n.score,
          }));
        },
        add: (poolName, content, importance) => {
          if (!db) return;
          const pool = db.getMemoryPool(poolName);
          if (!memoryAccess(db, { name: entityName, id: entityId }).pool(pool)) return;
          db.addPoolNote(pool!.id, entityName, content, importance);
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
  shutdown(): Promise<void> {
    this.stop();
    const finish = () => {
      this.saveWorldState();
      releaseChallengeHost(this);
      return Promise.allSettled([
        this.connectorRuntime?.close(),
        this.gatewayRuntime?.close(),
      ]).then(() => undefined);
    };
    const pending =
      this.roomTickCoordinator.pendingCount +
      this.background.size +
      this.tickScheduler.pendingCount;
    return pending
      ? Promise.all([this.roomTickCoordinator.drain(), this.drainBackground()]).then(finish)
      : finish();
  }

  /**
   * Register detached work that may still write the database (an `evolve`
   * trial or replication). `shutdown()` drains it — with async tick jobs —
   * before the host closes persistence.
   */
  trackBackground<T>(work: Promise<T>): Promise<T> {
    this.background.add(work);
    const done = () => this.background.delete(work);
    void work.then(done, done);
    return work;
  }

  /**
   * Settle tracked background work and in-flight async tick jobs, waiting at
   * most `timeoutMs` (long model-backed work must not hold a restart past the
   * host's shutdown watchdog). Resolves `true` when everything settled.
   */
  async drainBackground(timeoutMs = BACKGROUND_DRAIN_TIMEOUT_MS): Promise<boolean> {
    const settle = async () => {
      for (;;) {
        const work = [...this.background];
        if (work.length === 0 && this.tickScheduler.pendingCount === 0) return true;
        await Promise.allSettled([...work, this.tickScheduler.drain()]);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const drained = await Promise.race([settle(), timeout]);
    if (timer) clearTimeout(timer);
    if (!drained) {
      this.logger.warn("engine", "Background work still running at shutdown", {
        background: this.background.size,
        tickJobs: this.tickScheduler.pendingCount,
      });
    }
    return drained;
  }

  // ─── Built-in Command Registration ──────────────────────────────────────

  private registerBuiltinCommands(): void {
    registerBuiltinCommands(this);
  }
}
