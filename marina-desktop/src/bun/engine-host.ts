// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { RateLimiter } from "../../../src/auth/rate-limiter";
import { Engine } from "../../../src/engine/engine";
import { Logger } from "../../../src/engine/logger";
import type { Adapter } from "../../../src/net/adapter";
import { DashboardBroadcaster } from "../../../src/net/dashboard-ws";
import { formatPerception } from "../../../src/net/formatter";
import { McpServerAdapter } from "../../../src/net/mcp-server";
import { TelnetServer } from "../../../src/net/telnet-server";
import { WebSocketServer } from "../../../src/net/websocket-server";
import { MarinaDB } from "../../../src/persistence/database";
import { LocalStorageProvider } from "../../../src/storage/local-provider";
import type { StorageProvider } from "../../../src/storage/provider";
import type { RoomId } from "../../../src/types";
import { seedGuidePool } from "../../../src/world/seed-guide";
import type { WorldDefinition } from "../../../src/world/world-definition";
import { loadRooms } from "./room-loader";

export interface EngineHostConfig {
  dbPath: string;
  wsPort: number;
  telnetPort: number;
  mcpPort: number;
  tickMs: number;
  startRoom: string;
  roomsDir: string;
  world?: WorldDefinition;
}

export interface EngineStatus {
  running: boolean;
  uptime: number;
  entityCount: number;
  agentCount: number;
  roomCount: number;
  connectionCount: number;
  memory: { heapUsed: number; rss: number };
}

export class EngineHost {
  private logger = new Logger();
  private db: MarinaDB | null = null;
  private engine: Engine | null = null;
  private storage: StorageProvider | null = null;
  private rateLimiter: RateLimiter | null = null;
  private wsServer: WebSocketServer | null = null;
  private telnetServer: TelnetServer | null = null;
  private mcpServer: McpServerAdapter | null = null;
  private dashboardBroadcaster: DashboardBroadcaster | null = null;
  private stateInterval: ReturnType<typeof setInterval> | null = null;
  private eventListener: ((event: import("../../../src/types").EngineEvent) => void) | null = null;
  private adapters: Adapter[] = [];
  private running = false;

  constructor(private config: EngineHostConfig) {}

  /** Start the engine and all network servers. */
  async start(): Promise<void> {
    if (this.running) return;

    this.logger.info("desktop", "Starting engine...");

    // Database
    this.db = new MarinaDB(this.config.dbPath);
    const migratedKeys = this.db.migrateApiKeysToEncrypted();
    if (migratedKeys > 0) {
      this.logger.info("security", `Encrypted ${migratedKeys} existing API key(s) at rest`);
    }
    this.rateLimiter = new RateLimiter();

    // Asset storage — next to the database file
    const { join, dirname } = await import("node:path");
    const assetsDir = join(dirname(this.config.dbPath), "assets");
    this.storage = new LocalStorageProvider(assetsDir);
    await this.storage.init();
    const storage = this.storage;

    // Engine
    this.engine = new Engine({
      tickInterval: this.config.tickMs,
      startRoom: this.config.startRoom as RoomId,
      db: this.db,
      dbPath: this.config.dbPath,
      rateLimiter: this.rateLimiter,
      storage,
      world: this.config.world,
      logger: this.logger,
      instanceName: process.env.MARINA_NAME ?? this.config.world?.name,
    });

    // Register inline rooms from world definition (if provided)
    if (this.config.world) {
      this.engine.registerWorldRooms(this.config.world);
    }

    // Load the world's rooms. The world definition owns its room directory
    // (e.g. worlds/default/), exactly like src/main.ts. In dev that absolute
    // path exists in the repo; in a packaged app it won't, so we fall back to
    // the bundled resources copy: <roomsDir>/<world-folder>. Room files import
    // only types, so they carry no runtime deps and import cleanly from either
    // location.
    const { join: joinPath, basename } = await import("node:path");
    const { existsSync } = await import("node:fs");
    let roomsDir: string | undefined = this.config.world?.roomsDir;
    if (roomsDir && !existsSync(roomsDir) && this.config.roomsDir) {
      const bundled = joinPath(this.config.roomsDir, basename(roomsDir));
      if (existsSync(bundled)) roomsDir = bundled;
    }
    await loadRooms(this.engine, roomsDir ?? this.config.roomsDir);
    this.logger.info(
      "desktop",
      `Loaded ${this.engine.rooms.size} rooms (world: ${this.config.world?.name ?? "none"}).`,
    );

    // Validate START_ROOM override now that rooms are loaded
    if (this.config.startRoom) {
      const override = this.config.startRoom as RoomId;
      if (this.engine.rooms.has(override)) {
        this.engine.config.startRoom = override;
      } else {
        this.logger.warn(
          "desktop",
          `START_ROOM="${override}" not found, using ${this.config.world?.startRoom}`,
        );
      }
    }

    // Restore persisted state
    this.engine.loadWorldState();

    // Detect world change and clear stale dynamic data
    const worldName = this.config.world?.name;
    if (worldName) {
      const storedWorld = this.db.getMetaValue("world_name");
      if (storedWorld && storedWorld !== worldName) {
        this.logger.info(
          "desktop",
          `World changed "${storedWorld}" \u2192 "${worldName}", clearing stale dynamic data`,
        );
        this.db.clearDynamicRooms();
        this.db.clearDynamicCommands();
      }
      this.db.setMetaValue("world_name", worldName);
    }

    // Dynamic rooms & commands
    await this.engine.loadDynamicRooms();
    await this.engine.loadDynamicCommands();

    // MCP connectors
    await this.engine.initConnectors();

    // Peer Marina gateways
    await this.engine.initGateways();

    // Seed world data (traits, roles, projects, pools, macros — idempotent)
    if (this.config.world?.seed) {
      this.config.world.seed(this.db);
    }

    // Seed guide memory pool
    seedGuidePool(this.db, this.config.world?.guideNotes ?? []);

    // Seed canvas from world definition (idempotent)
    const canvasCfg = this.config.world?.canvas;
    if (canvasCfg && !this.db.getCanvasByName(canvasCfg.name)) {
      const id = crypto.randomUUID();
      this.db.createCanvas({
        id,
        name: canvasCfg.name,
        description: canvasCfg.description,
        scope: canvasCfg.scope ?? "global",
        creatorName: "system",
      });
    }

    // Dashboard broadcaster
    this.dashboardBroadcaster = new DashboardBroadcaster();
    this.eventListener = (event) => this.dashboardBroadcaster!.broadcastEvent(event);
    this.engine.addEventListener(this.eventListener);
    this.stateInterval = setInterval(
      () => this.dashboardBroadcaster!.broadcastState(this.engine!),
      2000,
    );

    // Network servers — best-effort inside Electrobun
    // Bun.serve() may not process requests in Electrobun's event loop,
    // so we wrap each in try/catch and log warnings instead of crashing.
    try {
      this.wsServer = new WebSocketServer(this.engine, this.config.wsPort, this.rateLimiter);
      this.wsServer.setBroadcaster(this.dashboardBroadcaster);
      this.wsServer.setDb(this.db);
      this.wsServer.setStorage(storage);
      this.wsServer.start();
    } catch (err) {
      this.logger.warn("desktop", "WebSocket server failed to start", {
        err,
      });
    }

    try {
      this.telnetServer = new TelnetServer(this.engine, this.config.telnetPort, this.rateLimiter);
      this.telnetServer.start();
    } catch (err) {
      this.logger.warn("desktop", "Telnet server failed to start", { err });
    }

    try {
      this.mcpServer = new McpServerAdapter(this.engine, this.config.mcpPort, this.rateLimiter);
      this.mcpServer.start();
    } catch (err) {
      this.logger.warn("desktop", "MCP server failed to start", { err });
    }

    // Initialize agent runtime (auto-respawn saved agents if AGENT_AUTORESPAWN=true)
    await this.engine.initAgents(this.config.wsPort);

    // Optional adapters (from env)
    await this.startOptionalAdapters();

    // Start tick loop
    this.engine.start();
    this.running = true;

    this.logger.info(
      "desktop",
      `Engine running — WS :${this.config.wsPort}, Telnet :${this.config.telnetPort}, MCP :${this.config.mcpPort}`,
    );
  }

  /** Graceful shutdown — does NOT call process.exit(). */
  async shutdown(): Promise<void> {
    if (!this.running) return;

    this.logger.info("desktop", "Shutting down engine...");

    if (this.stateInterval) {
      clearInterval(this.stateInterval);
      this.stateInterval = null;
    }

    // Remove event listener before engine shutdown
    if (this.eventListener && this.engine) {
      this.engine.removeEventListener(this.eventListener);
      this.eventListener = null;
    }

    // Stop adapters
    for (const adapter of this.adapters) {
      try {
        await adapter.stop();
      } catch (err) {
        this.logger.error("desktop", `Failed to stop ${adapter.name}`, {
          err,
        });
      }
    }
    this.adapters = [];

    // Stop agents before engine shutdown
    if (this.engine?.agentRuntime) {
      await this.engine.agentRuntime.stopAll();
    }

    // Stop engine (saves state + stops tick loop)
    this.engine?.shutdown();

    // Stop network servers
    this.wsServer?.stop();
    this.telnetServer?.stop();
    this.mcpServer?.stop();

    // Close database
    this.db?.close();

    this.engine = null;
    this.db = null;
    this.storage = null;
    this.wsServer = null;
    this.telnetServer = null;
    this.mcpServer = null;
    this.dashboardBroadcaster = null;
    this.rateLimiter = null;
    this.running = false;

    this.logger.info("desktop", "Engine stopped.");
  }

  /** Get current engine status for tray/menu/RPC. */
  getStatus(): EngineStatus {
    if (!this.engine || !this.running) {
      return {
        running: false,
        uptime: 0,
        entityCount: 0,
        agentCount: 0,
        roomCount: 0,
        connectionCount: 0,
        memory: { heapUsed: 0, rss: 0 },
      };
    }

    const mem = process.memoryUsage();
    return {
      running: true,
      uptime: this.engine.getUptime(),
      entityCount: this.engine.entities.size,
      agentCount: this.engine.getOnlineAgents().length,
      roomCount: this.engine.rooms.size,
      connectionCount: this.engine.getConnections().size,
      memory: { heapUsed: mem.heapUsed, rss: mem.rss },
    };
  }

  /** Access the underlying engine (for RPC handlers). */
  getEngine(): Engine | null {
    return this.engine;
  }

  /** Access the underlying database (for RPC handlers). */
  getDb(): MarinaDB | null {
    return this.db;
  }

  /** Access the storage provider (for asset RPC handlers). */
  getStorage(): StorageProvider | null {
    return this.storage;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async startOptionalAdapters(): Promise<void> {
    if (!this.engine || !this.rateLimiter) return;

    // Telegram
    if (process.env.TELEGRAM_TOKEN) {
      try {
        const { TelegramAdapter } = await import("../../../src/net/telegram-adapter");
        const ctx = {
          engine: this.engine,
          rateLimiter: this.rateLimiter,
          db: this.db ?? undefined,
          formatPerception,
        };
        const telegram = new TelegramAdapter(ctx, process.env.TELEGRAM_TOKEN);
        this.adapters.push(telegram);
        await telegram.start();
      } catch (err) {
        this.logger.error("desktop", "Telegram start failed", { err });
      }
    }

    // Discord
    if (process.env.DISCORD_TOKEN) {
      try {
        const { DiscordAdapter } = await import("../../../src/net/discord-adapter");
        const channelIds = process.env.DISCORD_CHANNEL_IDS?.split(",").filter(Boolean);
        const ctx = {
          engine: this.engine,
          rateLimiter: this.rateLimiter,
          db: this.db ?? undefined,
          formatPerception,
        };
        const discord = new DiscordAdapter(ctx, process.env.DISCORD_TOKEN, channelIds);
        this.adapters.push(discord);
        await discord.start();
      } catch (err) {
        this.logger.error("desktop", "Discord start failed", { err });
      }
    }
  }
}
