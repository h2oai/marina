import { resolve } from "node:path";
import { getInternalModelToken } from "./agent/agent-runtime";
import { RateLimiter } from "./auth/rate-limiter";
import {
  DASHBOARD_BROADCAST_INTERVAL_MS,
  MARINA_LOGIN_ATTEMPTS_PER_MIN,
  MARINA_MAX_LOGINS,
} from "./engine/constants";
import { Engine } from "./engine/engine";
import { Logger } from "./engine/logger";
import { AdapterManager } from "./net/adapter-manager";
import { DashboardBroadcaster } from "./net/dashboard-ws";
import { FeedPublisher } from "./net/feed-publisher";
import { formatPerception } from "./net/formatter";
import { LogServer } from "./net/log-server";
import { McpServerAdapter } from "./net/mcp-server";
import { TelnetServer } from "./net/telnet-server";
import { WebSocketServer } from "./net/websocket-server";
import { MarinaDB } from "./persistence/database";
import { isKeyEncryptionEnabled } from "./persistence/key-crypto";
import { LocalStorageProvider } from "./storage/local-provider";
import type { RoomId } from "./types";
import { loadRooms } from "./world/room-loader";
import { seedGuidePool } from "./world/seed-guide";
import type { WorldDefinition } from "./world/world-definition";

const WS_PORT = Number(process.env.WS_PORT) || 3300;
const TELNET_PORT = Number(process.env.TELNET_PORT) || 4000;
const MCP_PORT = Number(process.env.MCP_PORT) || 3301;
const LOG_PORT = Number(process.env.LOG_PORT) || 3302;
const TICK_MS = Number(process.env.TICK_MS) || 1000;
const DB_PATH = process.env.DB_PATH || "marina.db";

// ─── Load World Definition ───────────────────────────────────────────────────

const WORLD_NAME = process.env.MARINA_WORLD ?? "default";
const worldModule = await import(`../worlds/${WORLD_NAME}`);
const world: WorldDefinition = worldModule.default;
const INSTANCE_NAME = process.env.MARINA_NAME ?? world.name;

// Optional external-identity layer (off by default). When enabled, the provider
// and the better-auth dependency are loaded lazily — standalone/local Marina
// never imports them. Passwordless name-login is then gated (see engine.login).
const AUTH_ENABLED = process.env.MARINA_AUTH === "better-auth";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const logger = new Logger();
const db = new MarinaDB(DB_PATH);
// Encrypt any plaintext API keys at rest once MARINA_KEY_SECRET is configured,
// then surface the "encrypted but can't decrypt" misconfiguration loudly —
// otherwise those keys silently read as missing.
try {
  const migrated = db.migrateApiKeysToEncrypted();
  if (migrated > 0) logger.info("security", `Encrypted ${migrated} API key(s) at rest`);

  const audit = db.auditEncryptedKeys();
  if (audit.encrypted > 0 && !isKeyEncryptionEnabled()) {
    logger.warn(
      "security",
      `${audit.encrypted} API key(s) are encrypted at rest but MARINA_KEY_SECRET is NOT set — ` +
        `they cannot be decrypted and will read as MISSING. Set the secret they were encrypted ` +
        `with, or delete and re-enter the keys.`,
    );
  } else if (audit.unreadable > 0) {
    logger.warn(
      "security",
      `${audit.unreadable} encrypted API key(s) could not be decrypted with the current ` +
        `MARINA_KEY_SECRET — the secret may have changed. Restore the original secret, or delete ` +
        `and re-enter the keys.`,
    );
  }
} catch (err) {
  logger.error("security", "API-key encryption migration failed", { err });
}
const rateLimiter = new RateLimiter({ maxTokens: 200, refillRate: 50, refillInterval: 1000 });
// Login-attempt throttle: N attempts/min per client IP with a burst of N.
const loginRateLimiter =
  MARINA_LOGIN_ATTEMPTS_PER_MIN > 0
    ? new RateLimiter({
        maxTokens: MARINA_LOGIN_ATTEMPTS_PER_MIN,
        refillRate: MARINA_LOGIN_ATTEMPTS_PER_MIN,
        refillInterval: 60_000,
      })
    : undefined;
const modelRateLimiter = new RateLimiter({ maxTokens: 100, refillRate: 20, refillInterval: 1000 });
const memRateLimiter = new RateLimiter({ maxTokens: 20, refillRate: 10, refillInterval: 1000 });
const assetsDir = process.env.ASSETS_DIR || "data/assets";
const storage = new LocalStorageProvider(assetsDir);
await storage.init();
logger.info("storage", `Asset storage initialized at ${assetsDir}`);

const engine = new Engine({
  tickInterval: TICK_MS,
  startRoom: world.startRoom,
  instanceName: INSTANCE_NAME,
  db,
  dbPath: DB_PATH,
  rateLimiter,
  loginRateLimiter,
  maxLogins: MARINA_MAX_LOGINS,
  internalAuthToken: getInternalModelToken(),
  authRequired: AUTH_ENABLED,
  storage,
  world,
  logger,
});

// Register inline rooms from world definition
engine.registerWorldRooms(world);

// Load file-based room overlays (if world specifies a roomsDir, or from /rooms)
const roomsDir = world.roomsDir ? resolve(world.roomsDir) : undefined;
await loadRooms(engine, roomsDir);
logger.info("engine", `Loaded ${engine.rooms.size} rooms (world: ${world.name}).`);

// Validate START_ROOM override now that rooms are loaded
if (process.env.START_ROOM) {
  const override = process.env.START_ROOM as RoomId;
  if (engine.rooms.has(override)) {
    engine.config.startRoom = override;
  } else {
    console.warn(`[warn] START_ROOM="${override}" not found, using ${world.startRoom}`);
  }
}

// Restore world state from DB (entities, room stores)
engine.loadWorldState();

// Detect world change and clear stale dynamic data
const storedWorld = db.getMetaValue("world_name");
if (storedWorld && storedWorld !== world.name) {
  logger.info(
    "engine",
    `World changed "${storedWorld}" \u2192 "${world.name}", clearing stale dynamic data`,
  );
  db.clearDynamicRooms();
  db.clearDynamicCommands();
}
db.setMetaValue("world_name", world.name);

// Load dynamic rooms from DB
await engine.loadDynamicRooms();

// Load dynamic commands from DB
await engine.loadDynamicCommands();

// Initialize MCP connector runtime
await engine.initConnectors();

// Initialize gateway runtime (peer Marina bridges)
await engine.initGateways();

// Seed the guide memory pool (idempotent)
seedGuidePool(db, world.guideNotes);

// Run world seed function (idempotent)
if (world.seed) {
  world.seed(db);
}

// Seed canvas from world definition (idempotent)
if (world.canvas && !db.getCanvasByName(world.canvas.name)) {
  const id = crypto.randomUUID();
  db.createCanvas({
    id,
    name: world.canvas.name,
    description: world.canvas.description,
    scope: world.canvas.scope ?? "global",
    creatorName: "system",
  });
  logger.info("canvas", `Created ${world.canvas.name} canvas`);
}

// ─── Dashboard Broadcaster ───────────────────────────────────────────────────

const dashboardBroadcaster = new DashboardBroadcaster();
engine.addEventListener((event) => dashboardBroadcaster.broadcastEvent(event));
const stateInterval = setInterval(
  () => dashboardBroadcaster.broadcastState(engine),
  DASHBOARD_BROADCAST_INTERVAL_MS,
);

// Expired-session sweep: reclaim in-memory Map entries + DB rows whose TTL
// has elapsed. Without this, long-running instances leak expired sessions in
// memory (validate() only drops them when touched).
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const sessionCleanupInterval = setInterval(() => {
  const removed = engine.sessionManager?.cleanup() ?? 0;
  if (removed > 0) logger.info("auth", `Cleaned up ${removed} expired session(s)`);
}, SESSION_CLEANUP_INTERVAL_MS);

// ─── Live Log Server ────────────────────────────────────────────────────────

const logServer = new LogServer({
  port: LOG_PORT,
  resolveEntity: (id) => engine.entities.get(id)?.name,
});
engine.addEventListener((event) => logServer.handleEvent(event));
logServer.start();

// ─── Network Layer ────────────────────────────────────────────────────────────

const wsServer = new WebSocketServer(engine, WS_PORT, rateLimiter);
wsServer.setBroadcaster(dashboardBroadcaster);
wsServer.setDb(db);
wsServer.setStorage(storage);
wsServer.setModelRateLimiter(modelRateLimiter);
wsServer.setMemRateLimiter(memRateLimiter);

// ─── Optional auth provider (better-auth) ────────────────────────────────────
if (AUTH_ENABLED) {
  try {
    const { createBetterAuthProvider } = await import("./auth/better-auth-provider");
    const authProvider = createBetterAuthProvider();
    wsServer.setAuthProvider(authProvider);
    logger.info(
      "auth",
      `External auth enabled (better-auth) — sign-in required; methods: ${authProvider.methods.join(", ")}`,
    );
  } catch (err) {
    logger.error(
      "auth",
      "Failed to initialize better-auth — refusing to start in a half-auth state",
      {
        error: String(err),
      },
    );
    process.exit(1);
  }
}

// ─── Feed Publisher (engine → canvas) ───────────────────────────────────────

// Hygiene: drop feed rows older than 7 days on startup so the table doesn't
// grow unbounded across long-running instances. New rows created after this
// call are retained until the next restart.
try {
  const removed = db.trimFeedEvents(7 * 86_400_000);
  if (removed > 0) {
    console.log(`[feed] trimmed ${removed} feed_events older than 7d`);
  }
} catch (err) {
  console.warn("[feed] startup trim failed:", (err as Error).message);
}

const feedPublisher = new FeedPublisher({
  db,
  resolveEntity: (id) => engine.entities.get(id)?.name,
  // Name → id lookup so chronicle citations can flow `chronicled` standing.
  // Checks agents first (most common chronicler-cited participants), then
  // falls back to a global scan for human users / NPCs.
  resolveEntityIdByName: (name) =>
    engine.entities.findAgentByName(name)?.id ??
    engine.entities.all().find((e) => e.name === name)?.id,
  broadcaster: wsServer.canvasBroadcaster,
  emitEvent: (event) => engine.logEvent(event),
});
engine.addEventListener((event) => feedPublisher.handleEvent(event));

// ─── Reverse Hook (canvas → engine) ────────────────────────────────────────

wsServer.setOnNodeCreated((event) => {
  // When a node is created via REST API (e.g. human drag-and-drop),
  // log it as an engine event so agents and the log viewer can see it.
  engine.logEvent({
    type: "canvas_publish",
    entity: event.creatorName as import("./types").EntityId,
    canvasId: event.canvasId,
    nodeId: event.nodeId,
    timestamp: Date.now(),
  });
});

const telnetServer = new TelnetServer(engine, TELNET_PORT, rateLimiter);
const mcpServer = new McpServerAdapter(engine, MCP_PORT, rateLimiter);

// Adapter manager (hot-reloadable external platform adapters)
const adapterCtx = { engine, rateLimiter, db, formatPerception };
const adapterManager = new AdapterManager(adapterCtx, db);
engine.adapterManager = adapterManager;

wsServer.start();
telnetServer.start();
mcpServer.start();

// Auto-start adapters from env vars
for (const platform of ["telegram", "discord"] as const) {
  const envVar = platform === "telegram" ? "TELEGRAM_TOKEN" : "DISCORD_TOKEN";
  if (process.env[envVar]) {
    adapterManager.start(platform).catch((err) => {
      logger.error("adapter", `${platform} start failed`, { err });
    });
  }
}

// Initialize agent runtime (auto-respawns saved configs, requires WS server ready)
await engine.initAgents(WS_PORT);

engine.start();

// Security warnings
if (process.env.MARINA_OPEN_API === "true") {
  logger.warn(
    "security",
    "MARINA_OPEN_API=true — API endpoints accept unauthenticated requests (development mode)",
  );
}
if (!process.env.MODEL_API_KEYS && process.env.MARINA_OPEN_API !== "true") {
  logger.warn(
    "security",
    "MODEL_API_KEYS is not set — model API endpoints will reject requests. Set MODEL_API_KEYS or MARINA_OPEN_API=true",
  );
}
if (!process.env.MEM_API_KEYS && process.env.MARINA_OPEN_API !== "true") {
  logger.warn(
    "security",
    "MEM_API_KEYS is not set — memory API endpoints will reject requests. Set MEM_API_KEYS or MARINA_OPEN_API=true",
  );
}
if (!process.env.ALLOWED_ORIGINS) {
  logger.info(
    "security",
    "ALLOWED_ORIGINS is not set — cross-origin API requests are blocked (same-origin only)",
  );
}
if (engine.agentRuntime.isAvailable()) {
  logger.info("agents", "Agent runtime ready — LLM API keys detected");
} else {
  logger.warn(
    "agents",
    "No LLM API keys configured — agents cannot be spawned. Set ANTHROPIC_API_KEY or use 'key add' in-world.",
  );
}
if (
  process.env.NODE_ENV === "production" &&
  !process.env.HTTPS_PROXY &&
  !process.env.REVERSE_PROXY
) {
  logger.info(
    "security",
    "TLS not detected — consider running behind a reverse proxy (nginx, caddy) for encrypted connections",
  );
}

// ─── Marina-as-an-LLM: copy-paste wiring summary ───────────────────────────────
// Print the exact baseURL / model / auth so the OpenAI-compatible endpoint can be
// wired into any client (or another Marina instance) without reading the source.
{
  const defaultModel = db.getDefaultModel();
  const hasUpstream = engine.agentRuntime.isAvailable();
  const authMode = process.env.MODEL_API_KEYS
    ? "Bearer <token from MODEL_API_KEYS>"
    : process.env.MARINA_OPEN_API === "true"
      ? "none (MARINA_OPEN_API=true, dev only)"
      : "NOT CONFIGURED — set MODEL_API_KEYS or MARINA_OPEN_API=true";
  logger.info(
    "model-api",
    `OpenAI-compatible LLM endpoint: baseURL http://localhost:${WS_PORT}/v1 · model "marina" → ${defaultModel}` +
      `${hasUpstream ? "" : " · NO upstream key yet (returns 503 until a provider key is set)"} · auth: ${authMode}`,
  );
  logger.info(
    "model-api",
    `Wire an agent to this instance: \`agent spawn <name> model marina\`. ` +
      `From another Marina: \`agent spawn <name> model marina@http://<this-host>:${WS_PORT}/v1 key <name>\`.`,
  );
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  logger.info("engine", "Shutting down...");
  clearInterval(stateInterval);
  clearInterval(sessionCleanupInterval);

  // Stop external adapters first
  await adapterManager.stopAll();

  // Stop spawned agents (graceful checkpoint + disconnect)
  await engine.agentRuntime.stopAll();

  engine.shutdown(); // saves state + stops tick loop
  logServer.stop();
  wsServer.stop();
  telnetServer.stop();
  mcpServer.stop();
  db.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  logger.error("fatal", "Uncaught exception", { error: String(err) });
  console.error("[fatal] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  logger.error("fatal", "Unhandled rejection", { error: String(reason) });
  console.error("[fatal] Unhandled rejection:", reason);
});
