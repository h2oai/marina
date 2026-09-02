// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { getInternalModelToken } from "./agent/agent-runtime";
import { RateLimiter } from "./auth/rate-limiter";
import { parseExecUnrestricted } from "./coding/exec-approver";
import { ensureConfiguredRoots } from "./coding/workspace-registry";
import { describeAutonomyPosture, getAutonomyPosture } from "./engine/autonomy";
import {
  DASHBOARD_BROADCAST_INTERVAL_MS,
  MARINA_LOGIN_ATTEMPTS_PER_MIN,
  MARINA_MAX_LOGINS,
} from "./engine/constants";
import { Engine } from "./engine/engine";
import { Logger } from "./engine/logger";
import { projectTraces } from "./engine/trace-projection";
import { AdapterManager } from "./net/adapter-manager";
import { DashboardBroadcaster } from "./net/dashboard-ws";
import { FeedPublisher } from "./net/feed-publisher";
import { formatPerception } from "./net/formatter";
import { LogServer } from "./net/log-server";
import { McpServerAdapter } from "./net/mcp-server";
import { describeDefaultUpstream } from "./net/model-api";
import { detectLocalContextWindow } from "./net/model-discovery";
import { TelnetServer } from "./net/telnet-server";
import { isLoopbackHostname, resolveWsBindHostname, WebSocketServer } from "./net/websocket-server";
import { MarinaDB } from "./persistence/database";
import { isKeyEncryptionEnabled } from "./persistence/key-crypto";
import { LocalStorageProvider } from "./storage/local-provider";
import { loadOtlpExporterConfig, MarinaOtlpExporter } from "./telemetry/otlp-exporter";
import { loadOtlpLogExporterConfig, MarinaOtlpLogExporter } from "./telemetry/otlp-log-exporter";
import type { RoomId } from "./types";
import { loadRooms } from "./world/room-loader";
import { seedGuidePool } from "./world/seed-guide";
import type { WorldDefinition } from "./world/world-definition";

// Port semantics: unset/empty/non-numeric env keeps the default; an explicit 0
// (or negative) DISABLES that listener so multiple instances can share a host.
// Exception: the WS/HTTP server is the primary surface and can't be disabled —
// WS_PORT=0 (or negative) asks Bun for a free ephemeral port instead, and the
// real bound port is read back after start via wsServer.getPort().
function parsePort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

const WS_PORT = Math.max(0, parsePort("WS_PORT", 3300));
// Telnet is plaintext and unauthenticated — off by default. Set TELNET_PORT
// explicitly (e.g. 4000) to enable it, and only on a trusted network.
const TELNET_PORT = parsePort("TELNET_PORT", 0);
const MCP_PORT = parsePort("MCP_PORT", 3301);
const LOG_PORT = parsePort("LOG_PORT", 3302);
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
// Secure-by-default bind: an unset WS_HOST/MARINA_HOST binds LOOPBACK-ONLY
// (127.0.0.1). Public exposure is a deliberate opt-in (WS_HOST=0.0.0.0 or
// MARINA_PUBLIC=true). The resolved host is honored by the actual bind (see
// WebSocketServer.start / McpServerAdapter.start). Headless-exec identity trust
// is NOT derived from this env — it is resolved per acting connection (loopback
// IP / in-process) at approval time, so even an intentionally-public port can
// never be spoofed as trusted.
const RESOLVED_WS_HOST = resolveWsBindHostname();
const LOOPBACK_ONLY_BIND = isLoopbackHostname(RESOLVED_WS_HOST);
// Explicit operator acknowledgement that they accept the risk of a public bind
// combined with passwordless login / open API. Without it, that combination is
// a FATAL startup error rather than a warning.
const INSECURE_PUBLIC_ACK = process.env.MARINA_ALLOW_INSECURE_PUBLIC === "true";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const logger = new Logger();

// ─── Ingress posture gate: fail fast on an unsafe public bind ─────────────────
// A non-loopback bind exposes Marina to the network. Combined with passwordless
// name-login (no MARINA_AUTH) or the open-API dev bypass, that lets anyone reach
// the instance as an ordinary entity or an unauthenticated API caller. This is a
// deliberate, dangerous configuration — refuse to start unless the operator has
// (a) enabled real auth, or (b) explicitly accepted the risk. A warning is not
// enough for this one.
if (!LOOPBACK_ONLY_BIND && !INSECURE_PUBLIC_ACK) {
  if (!AUTH_ENABLED) {
    const msg =
      `FATAL: Marina is configured to bind a NON-LOOPBACK interface ` +
      `("${RESOLVED_WS_HOST}") while passwordless name-login is in effect ` +
      `(MARINA_AUTH is not "better-auth"). Anyone who can reach this host could log ` +
      `in as any entity. Fix ONE of:\n` +
      `  • keep it local: unset WS_HOST/MARINA_HOST/MARINA_PUBLIC (binds 127.0.0.1), or\n` +
      `  • require sign-in: set MARINA_AUTH=better-auth (+ MARINA_AUTH_ADMIN_EMAILS), or\n` +
      `  • accept the risk explicitly: set MARINA_ALLOW_INSECURE_PUBLIC=true.`;
    logger.error("security", msg);
    throw new Error(msg);
  }
  if (process.env.MARINA_OPEN_API === "true") {
    const msg =
      `FATAL: MARINA_OPEN_API=true (unauthenticated API access) combined with a ` +
      `NON-LOOPBACK bind ("${RESOLVED_WS_HOST}") exposes every API endpoint to the ` +
      `network with no auth. Fix ONE of:\n` +
      `  • unset MARINA_OPEN_API and configure MODEL_API_KEYS/MEM_API_KEYS, or\n` +
      `  • bind loopback-only (unset WS_HOST/MARINA_HOST/MARINA_PUBLIC), or\n` +
      `  • accept the risk explicitly: set MARINA_ALLOW_INSECURE_PUBLIC=true.`;
    logger.error("security", msg);
    throw new Error(msg);
  }
}

// Autonomy posture gate: an OPEN posture means any logged-in entity can spawn
// agents, federate, and execute workspace code — combined with a public bind
// and passwordless login that would hand those capabilities to the whole
// network. A radical Marina is the OPERATOR's radical Marina.
if (
  getAutonomyPosture() === "open" &&
  !LOOPBACK_ONLY_BIND &&
  !AUTH_ENABLED &&
  !INSECURE_PUBLIC_ACK
) {
  const msg =
    `FATAL: MARINA_AUTONOMY=open combined with a NON-LOOPBACK bind ` +
    `("${RESOLVED_WS_HOST}") and passwordless login would grant gated capabilities ` +
    `to anyone who can reach this host. Fix ONE of:\n` +
    `  • keep it local: unset WS_HOST/MARINA_HOST/MARINA_PUBLIC, or\n` +
    `  • require sign-in: set MARINA_AUTH=better-auth, or\n` +
    `  • accept the risk explicitly: set MARINA_ALLOW_INSECURE_PUBLIC=true.`;
  logger.error("security", msg);
  throw new Error(msg);
}
if (getAutonomyPosture() !== "guarded") {
  logger.info("autonomy", `Autonomy posture: ${describeAutonomyPosture()}`);
}

const db = new MarinaDB(DB_PATH);
const structuredLogRetention = Math.max(
  100,
  Math.min(Number(process.env.MARINA_LOG_RETENTION) || 10_000, 1_000_000),
);
db.pruneStructuredLogs(structuredLogRetention);
let structuredLogWrites = 0;
logger.addSink((entry) => {
  db.appendStructuredLog(entry);
  structuredLogWrites++;
  if (structuredLogWrites % 250 === 0) db.pruneStructuredLogs(structuredLogRetention);
});
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

// Prepare any operator-configured Code Mode workspace roots (MARINA_CODE_ROOTS
// / MARINA_CODE_DEFAULT_ROOT): create the dirs (the data volume shadows an
// image-time mkdir) and git init them so checkpoint/revert/diff work. No-op
// when unset.
const codeRoots = ensureConfiguredRoots();
for (const warning of codeRoots.warnings) logger.warn("code", warning);
if (codeRoots.ensured.length > 0) {
  logger.info("code", `Code Mode workspace roots ready: ${codeRoots.ensured.join(", ")}`);
}

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

const otlpConfig = loadOtlpExporterConfig();
const otlpExporter = otlpConfig
  ? new MarinaOtlpExporter(otlpConfig, (traceIds) => {
      // One indexed batch fetch + one projection for the whole flush — the
      // previous per-trace-id 5,000-row scan ran up to 1,000 times per flush.
      const wanted = new Set(traceIds);
      return projectTraces(db.getTraceEventsByTraceIds(traceIds)).filter((trace) =>
        wanted.has(trace.traceId),
      );
    })
  : undefined;
if (otlpExporter) {
  engine.setOtlpStatusProvider(() => otlpExporter.getStatus());
  engine.addEventListener((event) => otlpExporter.handleEvent(event));
  logger.info(
    "observability",
    `OTLP/HTTP JSON trace export enabled → ${otlpExporter.getStatus().endpoint} (credentials redacted)`,
  );
}
const otlpLogConfig = loadOtlpLogExporterConfig();
const otlpLogExporter = otlpLogConfig ? new MarinaOtlpLogExporter(otlpLogConfig) : undefined;
if (otlpLogExporter) {
  engine.setOtlpLogStatusProvider(() => otlpLogExporter.getStatus());
  logger.addSink(otlpLogExporter.handleLog);
  logger.info(
    "observability",
    `OTLP/HTTP JSON log export enabled → ${otlpLogExporter.getStatus().endpoint} (credentials redacted)`,
  );
}

// Expired-session sweep: reclaim in-memory Map entries + DB rows whose TTL
// has elapsed. Without this, long-running instances leak expired sessions in
// memory (validate() only drops them when touched).
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const sessionCleanupInterval = setInterval(() => {
  const removed = engine.sessionManager?.cleanup() ?? 0;
  if (removed > 0) logger.info("auth", `Cleaned up ${removed} expired session(s)`);
}, SESSION_CLEANUP_INTERVAL_MS);

// ─── Live Log Server ────────────────────────────────────────────────────────

const logServer =
  LOG_PORT > 0
    ? new LogServer({
        port: LOG_PORT,
        hostname: RESOLVED_WS_HOST,
        resolveEntity: (id) => engine.entities.get(id)?.name,
      })
    : undefined;
if (logServer) {
  engine.addEventListener((event) => logServer.handleEvent(event));
  logServer.start();
} else {
  logger.info("engine", "Log server disabled (LOG_PORT <= 0)");
}

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
  // Bound the gated-exec audit trail too (90d retention — longer than the feed
  // since it's a security log, but still finite so it can't grow forever).
  const shellRemoved = db.trimShellLog(90 * 86_400_000);
  if (shellRemoved > 0) {
    console.log(`[shell] trimmed ${shellRemoved} shell_log rows older than 90d`);
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
  // Same storage the canvas HTTP API uses, so live broadcast snapshots resolve
  // asset urls identically to REST responses.
  storage,
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

const telnetServer =
  TELNET_PORT > 0 ? new TelnetServer(engine, TELNET_PORT, rateLimiter) : undefined;
const mcpServer = MCP_PORT > 0 ? new McpServerAdapter(engine, MCP_PORT, rateLimiter) : undefined;
if (!telnetServer) logger.info("engine", "Telnet server disabled (TELNET_PORT <= 0)");
if (!mcpServer) logger.info("engine", "MCP server disabled (MCP_PORT <= 0)");

// Adapter manager (hot-reloadable external platform adapters)
const adapterCtx = { engine, rateLimiter, db, formatPerception };
const adapterManager = new AdapterManager(adapterCtx, db);
engine.adapterManager = adapterManager;

wsServer.start();
telnetServer?.start();
mcpServer?.start();
// Real bound port — differs from WS_PORT when WS_PORT=0 (ephemeral).
const boundWsPort = wsServer.getPort();

// Auto-start adapters from env vars
for (const platform of ["telegram", "discord"] as const) {
  const envVar = platform === "telegram" ? "TELEGRAM_TOKEN" : "DISCORD_TOKEN";
  if (process.env[envVar]) {
    adapterManager.start(platform).catch((err) => {
      logger.error("adapter", `${platform} start failed`, { err });
    });
  }
}

// Auto-detect local-server context windows (llama.cpp /props) before agents
// spawn, so their completion budget scales to the real window instead of the
// conservative default. Best-effort; an explicit *_CONTEXT_WINDOW env wins.
await Promise.all(
  (["llama", "ollama"] as const).map(async (provider) => {
    const n = await detectLocalContextWindow(provider);
    if (n) logger.info("model", `Detected ${provider} context window: ${n} tokens`);
  }),
);

// Initialize agent runtime (auto-respawns saved configs, requires WS server ready)
await engine.initAgents(boundWsPort);

engine.start();

// Security warnings
if (!LOOPBACK_ONLY_BIND) {
  logger.warn(
    "security",
    `Bound to a NON-LOOPBACK interface ("${RESOLVED_WS_HOST}") — this instance is reachable ` +
      `from the network.` +
      (AUTH_ENABLED
        ? " Sign-in is required (MARINA_AUTH=better-auth)."
        : INSECURE_PUBLIC_ACK
          ? " Passwordless login is EXPOSED and MARINA_ALLOW_INSECURE_PUBLIC=true accepts the risk."
          : ""),
  );
} else {
  logger.info("security", "Bound loopback-only (127.0.0.1) — local-only, not reachable remotely.");
}
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
// Arbitrary (non-allowlisted) host code execution in a workspace is off unless
// explicitly enabled. When MARINA_CODE_EXEC_UNRESTRICTED lists entities, the
// headless approver still requires code.exec.unrestricted competence AND a
// trustworthy identity, which is decided PER acting connection at approval time:
// MARINA_AUTH=better-auth (every login verified), OR the acting entity's own
// connection is genuinely loopback (127.0.0.0/8, ::1) / in-process. A bare
// WS_HOST claim no longer confers trust — bind loopback AND accept only local
// connections, or enable auth. Interactive approval (code exec-mode prompt|auto)
// is orthogonal and always available to a verified loopback sovereign creator.
{
  const execUnrestricted = parseExecUnrestricted(process.env.MARINA_CODE_EXEC_UNRESTRICTED);
  if (execUnrestricted.length > 0) {
    const genuineLoopbackBind = LOOPBACK_ONLY_BIND; // bind is now honored (see WebSocketServer)
    const likelyTrusted = AUTH_ENABLED || genuineLoopbackBind;
    logger.warn(
      "security",
      `MARINA_CODE_EXEC_UNRESTRICTED admits ${execUnrestricted.length} entity(ies) for headless arbitrary code exec` +
        (likelyTrusted
          ? " (identity trust is resolved per acting connection: MARINA_AUTH or a genuine loopback connection; competence still required per entity)"
          : " — headless exec is refused for any non-loopback connection unless MARINA_AUTH=better-auth is set; set WS_HOST=127.0.0.1 to bind loopback-only, or enable auth"),
    );
  }
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

// ─── Boot banner: this instance's coordinates ────────────────────────────────
// One compact stdout announcement of every live surface. Marina instances are
// peers — the Federate line is this instance's invitation to bridge in.
{
  const surfaces = [
    `WebSocket ws://localhost:${boundWsPort}/ws`,
    `Dashboard http://localhost:${boundWsPort}/dashboard`,
  ];
  if (mcpServer) surfaces.push(`MCP http://localhost:${mcpServer.getPort()}/mcp`);
  if (telnetServer) surfaces.push(`Telnet localhost:${TELNET_PORT}`);
  if (logServer) surfaces.push(`Logs http://localhost:${LOG_PORT}`);
  console.log(
    [
      `Marina "${INSTANCE_NAME}" is up · world: ${world.name}`,
      `  ${surfaces.join(" · ")}`,
      `  Federate: gateway add <name> ws://<host>:${boundWsPort}/ws`,
      `  Autonomy: ${describeAutonomyPosture()}`,
    ].join("\n"),
  );
}

// ─── Marina-as-an-LLM: copy-paste wiring summary ───────────────────────────────
// Print the exact baseURL / model / auth so the OpenAI-compatible endpoint can be
// wired into any client (or another Marina instance) without reading the source.
{
  // Report the concrete upstream the marina/default channel would hit, not the
  // (possibly self-referential) configured default-model string.
  const defaultModel = describeDefaultUpstream(engine) ?? "(no upstream provider yet)";
  const hasUpstream = engine.agentRuntime.isAvailable();
  const authMode = process.env.MODEL_API_KEYS
    ? "Bearer <token from MODEL_API_KEYS>"
    : process.env.MARINA_OPEN_API === "true"
      ? "none (MARINA_OPEN_API=true, dev only)"
      : "NOT CONFIGURED — set MODEL_API_KEYS or MARINA_OPEN_API=true";
  logger.info(
    "model-api",
    `OpenAI-compatible LLM endpoint: baseURL http://localhost:${boundWsPort}/v1 · model "marina" → ${defaultModel}` +
      `${hasUpstream ? "" : " · NO upstream key yet (returns 503 until a provider key is set)"} · auth: ${authMode}`,
  );
  logger.info(
    "model-api",
    `Wire an agent to this instance: \`agent spawn <name> model marina\`. ` +
      `From another Marina: \`agent spawn <name> model marina@http://<this-host>:${boundWsPort}/v1 key <name>\`.`,
  );
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return; // re-entrancy guard (e.g. SIGTERM during a crash unwind)
  shuttingDown = true;
  logger.info("engine", "Shutting down...");

  // Hard watchdog: if graceful cleanup stalls (a hung upstream during an
  // agent's checkpoint flush, say), force-exit so a restart isn't blocked.
  const watchdog = setTimeout(() => process.exit(code), 10_000);
  watchdog.unref?.();

  clearInterval(stateInterval);
  clearInterval(sessionCleanupInterval);
  await otlpExporter?.stop().catch(() => {});
  await otlpLogExporter?.stop().catch(() => {});

  // Stop external adapters first
  await adapterManager.stopAll().catch(() => {});

  // Stop spawned agents (graceful checkpoint + disconnect). stopAll preserves
  // each agent's saved config so they respawn on the next boot.
  await engine.agentRuntime.stopAll().catch(() => {});

  engine.shutdown(); // saves state + stops tick loop
  logServer?.stop();
  wsServer.stop();
  telnetServer?.stop();
  mcpServer?.stop();
  db.close();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (err) => {
  logger.error("fatal", "Uncaught exception", { error: String(err) });
  console.error("[fatal] Uncaught exception:", err);
  // Best-effort: run graceful shutdown so agents flush checkpoints before the
  // process dies — otherwise a crash loses everything since the last periodic
  // save. The watchdog inside shutdown() bounds how long this can hang.
  void shutdown(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error("fatal", "Unhandled rejection", { error: String(reason) });
  console.error("[fatal] Unhandled rejection:", reason);
});
