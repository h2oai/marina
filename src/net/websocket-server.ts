// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { MarinaAuthProvider } from "../auth/better-auth-provider";
import type { RateLimiter } from "../auth/rate-limiter";
import { secretsEqual } from "../auth/secret-compare";
import {
  WS_IDLE_TIMEOUT_SECONDS,
  WS_MAX_CONNECTIONS_PER_IP,
  WS_MAX_TOTAL_CONNECTIONS,
} from "../engine/constants";
import type { Engine } from "../engine/engine";
import type { MarinaDB } from "../persistence/database";
import type { StorageProvider } from "../storage/provider";
import type { Connection, Perception } from "../types";
import { handleAssetApi, handleAssetServing } from "./asset-api";
import { handleAuthApi } from "./auth-api";
import { DESKTOP_OPERATOR_ENTITY_ID, OPEN_API_ENTITY_ID } from "./auth-middleware";
import { type CanvasNodeCreatedEvent, handleCanvasApi } from "./canvas-api";
import { buildCanvasPrincipal, isLoopbackPeer, LOOPBACK_PRINCIPAL } from "./canvas-principal";
import { CanvasBroadcaster, type CanvasSubscriptionPrincipal } from "./canvas-ws";
import {
  buildConnectManifest,
  handleSkillRequest,
  negotiateConnectCapabilities,
  registerConnectEndpoint,
} from "./connect-api";
import { corsHeaders } from "./cors";
import { handleDashboardApi } from "./dashboard-api";
import type { DashboardBroadcaster, DashboardWSData } from "./dashboard-ws";
import { handleEntityApi } from "./entity-api";
import { handleMemApi } from "./mem-api";
import { handleModelApi } from "./model-api";
import { handleProbeApi } from "./probe-api";

const WEBCHAT_PATH = join(import.meta.dir, "webchat.html");
const ASK_PATH = join(import.meta.dir, "ask.html");
const DASHBOARD_DIST = join(import.meta.dir, "../../dist/dashboard");
const DASHBOARD_INDEX = join(DASHBOARD_DIST, "index.html");

const DASHBOARD_NOT_BUILT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Marina — dashboard not built</title>
<style>body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b1220;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}main{max-width:44rem;padding:2rem}h1{font-size:1.1rem;color:#7dd3fc}code{background:#1e293b;padding:.15rem .4rem;border-radius:.25rem;color:#a5f3fc}pre{background:#1e293b;padding:1rem;border-radius:.5rem;overflow-x:auto}a{color:#7dd3fc}</style>
</head><body><main>
<h1>Dashboard not built yet</h1>
<p>The Marina server is running, but the dashboard bundle (<code>dist/dashboard/</code>) hasn't been built. Build it once, then reload — no server restart needed:</p>
<pre>bun run dashboard:build</pre>
<p>Meanwhile, the <a href="/">web chat</a> works right away.</p>
</main></body></html>`;

async function serveDashboardIndex(): Promise<Response> {
  const index = Bun.file(DASHBOARD_INDEX);
  if (await index.exists()) {
    return new Response(index, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  return new Response(DASHBOARD_NOT_BUILT_HTML, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

interface WSData {
  connId: string;
  isDashboard?: boolean;
  isCanvas?: boolean;
  canvasId?: string;
  ip?: string;
  /** Real, unspoofable TCP peer address from `server.requestIP` — the exec/loopback trust anchor. */
  peerIp?: string;
  /**
   * Authenticated principal resolved at UPGRADE time for the dashboard/canvas
   * live streams. Either a real `EntityId` (valid session token), the
   * {@link OPEN_API_ENTITY_ID} sentinel (dev bypass / desktop token), or the
   * {@link LOOPBACK_PRINCIPAL} sentinel (genuine local operator on a loopback
   * bind, zero-config desktop). Cluster B reads `ws.data.principal` to scope
   * canvas subscriptions. Never undefined on an upgraded dashboard/canvas socket
   * (the upgrade is rejected before it can be).
   */
  principal?: string;
  [key: string]: unknown;
}

let wsIdCounter = 0;

/** Loopback host tokens that count as a secure, local-only bind. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Sentinel principal attached to a dashboard/canvas socket that was admitted
 * purely because it arrived over a genuine loopback peer with no session token.
 * This is the zero-config desktop path: a local client keeps working, but the
 * principal is explicitly "unauthenticated-but-local" rather than a real entity.
 */
// Re-exported from the shared canvas-principal module (single source of truth
// for the loopback trust anchor). Kept exported here for backward compatibility
// with existing importers/tests.
export { LOOPBACK_PRINCIPAL };

/**
 * Resolve the bind hostname from the environment. SECURE-BY-DEFAULT: an unset
 * WS_HOST/MARINA_HOST now binds LOOPBACK-ONLY (127.0.0.1) so a fresh desktop
 * node is never silently exposed on all interfaces. Public exposure is a
 * deliberate opt-in:
 *   - WS_HOST=0.0.0.0 (or any explicit non-loopback host), or
 *   - MARINA_PUBLIC=true (binds 0.0.0.0 without naming an interface).
 * An explicit WS_HOST/MARINA_HOST always wins over MARINA_PUBLIC. The value is
 * threaded into `Bun.serve({ hostname })` so the bind is real, and it is the
 * trust anchor behind loopback isolation (the headless-exec identity decision
 * stays per-connection and does not read it).
 */
export function resolveWsBindHostname(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.WS_HOST ?? env.MARINA_HOST ?? "").trim();
  if (explicit) return explicit;
  if ((env.MARINA_PUBLIC ?? "").trim().toLowerCase() === "true") return "0.0.0.0";
  return "127.0.0.1";
}

/** True when a resolved bind hostname is loopback-only (secure local default). */
export function isLoopbackHostname(host: string): boolean {
  const h = host.trim().toLowerCase();
  return LOOPBACK_HOSTNAMES.has(h) || h.startsWith("127.");
}

export class WebSocketServer {
  private server: Server<WSData> | null = null;
  private sockets = new Map<string, ServerWebSocket<WSData>>();
  private ipConnections = new Map<string, number>();
  private totalConnections = 0;
  private broadcaster: DashboardBroadcaster | null = null;
  readonly canvasBroadcaster = new CanvasBroadcaster();
  private db?: MarinaDB;
  private storage?: StorageProvider;
  private onNodeCreated?: (event: CanvasNodeCreatedEvent) => void;
  private modelRateLimiter?: RateLimiter;
  private memRateLimiter?: RateLimiter;
  private authProvider?: MarinaAuthProvider;
  /** Connection IDs that have successfully completed gateway auth. */
  private gatewayAuthed = new Set<string>();

  constructor(
    private engine: Engine,
    private port: number,
    private rateLimiter?: RateLimiter,
  ) {}

  setBroadcaster(broadcaster: DashboardBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  setDb(db: MarinaDB): void {
    this.db = db;
  }

  setOnNodeCreated(cb: (event: CanvasNodeCreatedEvent) => void): void {
    this.onNodeCreated = cb;
  }

  setStorage(storage: StorageProvider): void {
    this.storage = storage;
  }

  setModelRateLimiter(limiter: RateLimiter): void {
    this.modelRateLimiter = limiter;
  }

  setMemRateLimiter(limiter: RateLimiter): void {
    this.memRateLimiter = limiter;
  }

  setAuthProvider(provider: MarinaAuthProvider): void {
    this.authProvider = provider;
  }

  /**
   * Resolve the authenticated principal for a dashboard/canvas WebSocket UPGRADE.
   * Returns the principal string to attach to the socket, or `null` to REJECT
   * the upgrade. Accepted, in order of strength:
   *   1. A valid session token (Authorization: Bearer <t> header, or ?token=<t>
   *      query param) → the real EntityId.
   *   2. The desktop API token header (X-Marina-Desktop-Token) → DESKTOP_OPERATOR
   *      sentinel (a trusted local operator — mirrors authenticateRequest so the
   *      same token maps to {isOperator:true} on both the HTTP and WS surfaces).
   *   3. MARINA_OPEN_API=true dev bypass → OPEN_API sentinel.
   *   4. A genuine loopback peer (zero-config desktop) → LOOPBACK_PRINCIPAL.
   * Otherwise (a remote client on a public bind with no token) → null (reject).
   * This is defense-in-depth on the loopback-only default and essential on a
   * public bind; Cluster B scopes canvas subscriptions off the attached principal.
   */
  private resolveUpgradePrincipal(
    req: Request,
    url: URL,
    peerIp: string | undefined,
  ): string | null {
    const auth = req.headers.get("Authorization");
    const headerToken = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const token = headerToken ?? url.searchParams.get("token");
    if (token) {
      const entityId = this.engine.authenticate(token);
      if (entityId) return entityId as string;
    }

    const desktopToken = req.headers.get("X-Marina-Desktop-Token");
    const expectedDesktopToken = process.env.MARINA_DESKTOP_API_TOKEN;
    if (
      desktopToken &&
      expectedDesktopToken &&
      expectedDesktopToken.length >= 32 &&
      secretsEqual(desktopToken, expectedDesktopToken)
    ) {
      return DESKTOP_OPERATOR_ENTITY_ID as string;
    }

    if (process.env.MARINA_OPEN_API === "true") return OPEN_API_ENTITY_ID as string;

    // Zero-config desktop: a genuine loopback peer (never header-derived) is
    // admitted as an unauthenticated-but-local principal. A remote peer that
    // forges X-Forwarded-For does NOT set peerIp, so it stays rejected.
    if (isLoopbackPeer(peerIp)) return LOOPBACK_PRINCIPAL;

    return null;
  }

  /**
   * Translate the string principal attached at UPGRADE time into the structured
   * {@link CanvasSubscriptionPrincipal} the subscription gate understands.
   *
   *   - {@link LOOPBACK_PRINCIPAL}: genuine local desktop owner → operator (zero-
   *     config desktop keeps seeing its own/local canvases).
   *   - {@link DESKTOP_OPERATOR_ENTITY_ID}: provisioned desktop capability token → operator.
   *   - {@link OPEN_API_ENTITY_ID}: dev-open bypass — reads are already wide open,
   *     so it may observe any canvas (read-scope operator).
   *   - A real EntityId: owner of its own private canvas; operator only when it is
   *     a sovereign admin (rank ≥ 9) or holds the operator gate.
   *   - undefined: fully anonymous — private per-entity canvases stay closed.
   */
  private buildCanvasPrincipal(
    principal: string | undefined,
    db: MarinaDB | undefined,
  ): CanvasSubscriptionPrincipal {
    // Delegate to the shared builder so the WS and HTTP surfaces apply one rule.
    return buildCanvasPrincipal(principal, this.engine, db);
  }

  start(): void {
    const engine = this.engine;
    const sockets = this.sockets;
    const rateLimiter = this.rateLimiter;
    const self = this;

    const bindHostname = resolveWsBindHostname();

    this.server = Bun.serve<WSData>({
      port: this.port,
      // Secure-by-default: an unset host binds loopback-only (127.0.0.1). Public
      // exposure is an explicit opt-in (WS_HOST=0.0.0.0 or MARINA_PUBLIC=true).
      hostname: bindHostname,
      idleTimeout: WS_IDLE_TIMEOUT_SECONDS,

      async fetch(req, server) {
        const url = new URL(req.url);

        // CORS preflight
        if (req.method === "OPTIONS") {
          return new Response(null, {
            headers: corsHeaders(req.headers.get("Origin"), {
              headers: "Content-Type, Authorization, X-Conversation-Id, X-Load-Balance",
              expose: "X-Conversation-Id, x-request-id",
            }),
          });
        }

        // ─── WebSocket upgrade paths (with connection limits) ────────────
        const isWsUpgrade =
          url.pathname === "/dashboard-ws" ||
          url.pathname === "/ws" ||
          url.pathname === "/canvas-ws";

        if (isWsUpgrade) {
          // Real, unspoofable TCP peer address — the ONLY value usable as an exec/loopback
          // trust anchor. Never mix header values into this.
          const peerIp = server.requestIP(req)?.address;
          // Header-derived display/rate-limiting IP — SPOOFABLE (client controls the headers).
          // Never use this as a trust anchor; see `peerIp` above.
          const fwd = req.headers.get("x-forwarded-for");
          const ip =
            (fwd ? fwd.split(",")[0]!.trim() : null) ??
            req.headers.get("x-real-ip") ??
            peerIp ??
            "unknown";

          // Enforce total connection cap (all types: game + dashboard + canvas)
          if (self.totalConnections >= WS_MAX_TOTAL_CONNECTIONS) {
            return new Response("Too many connections", { status: 503 });
          }

          // Enforce per-IP connection cap
          const ipCount = self.ipConnections.get(ip) ?? 0;
          if (ipCount >= WS_MAX_CONNECTIONS_PER_IP) {
            return new Response("Too many connections from this IP", { status: 429 });
          }

          // Dashboard WebSocket upgrade — require an authenticated principal.
          if (url.pathname === "/dashboard-ws") {
            const principal = self.resolveUpgradePrincipal(req, url, peerIp);
            if (principal === null) {
              return new Response("Unauthorized", { status: 401 });
            }
            const connId = `dash_${++wsIdCounter}`;
            const upgraded = server.upgrade(req, {
              data: { connId, isDashboard: true, ip, peerIp, principal },
            });
            if (!upgraded) {
              return new Response("WebSocket upgrade failed", { status: 400 });
            }
            return undefined;
          }

          // Game WebSocket upgrade
          if (url.pathname === "/ws") {
            const connId = `ws_${++wsIdCounter}`;
            const upgraded = server.upgrade(req, { data: { connId, ip, peerIp } });
            if (!upgraded) {
              return new Response("WebSocket upgrade failed", { status: 400 });
            }
            return undefined;
          }

          // Canvas WebSocket upgrade — require an authenticated principal.
          if (url.pathname === "/canvas-ws") {
            const canvasId = url.searchParams.get("canvas");
            if (!canvasId) {
              return new Response("Missing canvas query param", { status: 400 });
            }
            const principal = self.resolveUpgradePrincipal(req, url, peerIp);
            if (principal === null) {
              return new Response("Unauthorized", { status: 401 });
            }
            const connId = `canvas_${++wsIdCounter}`;
            const upgraded = server.upgrade(req, {
              data: { connId, isCanvas: true, canvasId, ip, peerIp, principal },
            });
            if (!upgraded) {
              return new Response("WebSocket upgrade failed", { status: 400 });
            }
            return undefined;
          }
        }

        // Asset binary serving: GET /assets/*
        if (url.pathname.startsWith("/assets/") && self.storage) {
          return handleAssetServing(url, self.storage);
        }

        // Asset API routes: /api/assets*
        if (url.pathname.startsWith("/api/assets") && self.db && self.storage) {
          return handleAssetApi(url, req.method, req, self.db, self.storage, engine);
        }

        // Canvas API routes: /api/canvases*
        if (url.pathname.startsWith("/api/canvases") && self.db) {
          // Real, unspoofable TCP peer address — the loopback trust anchor for
          // the zero-config desktop reader (never header-derived).
          const canvasPeerIp = server.requestIP(req)?.address;
          return handleCanvasApi(
            url,
            req.method,
            req,
            self.db,
            self.storage,
            self.canvasBroadcaster,
            engine,
            self.onNodeCreated,
            canvasPeerIp,
          );
        }

        // Connect manifest
        if (url.pathname === "/api/connect") {
          return buildConnectManifest(req, engine);
        }
        if (url.pathname === "/api/connect/negotiate") {
          return negotiateConnectCapabilities(req);
        }

        // Skill document
        if (url.pathname === "/api/skill") {
          return handleSkillRequest();
        }

        // Memory API routes: /mem and /mem/*
        if ((url.pathname === "/mem" || url.pathname.startsWith("/mem/")) && self.db) {
          const memResp = await handleMemApi(url, req.method, req, self.db, self.memRateLimiter);
          if (memResp) return memResp;
        }

        // Probe API — external resolver dispatch. Same auth + rate limit as
        // /mem; emits engine events (feed_event, calibration follow-ups)
        // through the engine's logEvent fan-out.
        if (url.pathname === "/api/probe" && self.db) {
          const probeResp = await handleProbeApi(
            url,
            req.method,
            req,
            self.db,
            (event) => engine.logEvent(event),
            self.memRateLimiter,
          );
          if (probeResp) return probeResp;
        }

        // Entity profile API — public per-entity view (the /who pages' data
        // source). Read-only, no auth. Cached briefly. See entity-api.ts.
        if (url.pathname.startsWith("/api/entity/") && self.db) {
          const entityResp = await handleEntityApi(url, req.method, self.db, engine);
          if (entityResp) return entityResp;
        }

        // Model API routes (OpenAI + Ollama compatible)
        if (url.pathname.startsWith("/v1/")) {
          const modelResp = await handleModelApi(
            url,
            req.method,
            req,
            engine,
            self.modelRateLimiter,
            server,
          );
          if (modelResp) return modelResp;
        }
        if (
          url.pathname === "/api/tags" ||
          url.pathname === "/api/chat" ||
          url.pathname === "/api/generate"
        ) {
          const modelResp = await handleModelApi(
            url,
            req.method,
            req,
            engine,
            self.modelRateLimiter,
            server,
          );
          if (modelResp) return modelResp;
        }

        // Auth API (optional better-auth bridge). /api/auth-status always
        // answers (required:false when off); /api/auth/* + /api/auth-session
        // only when a provider is configured.
        if (url.pathname.startsWith("/api/auth")) {
          const authResp = await handleAuthApi(
            req,
            url,
            req.method,
            engine,
            self.db,
            self.authProvider,
          );
          if (authResp) return authResp;
        }

        // API routes
        if (url.pathname.startsWith("/api/")) {
          // Real, unspoofable TCP peer address — the loopback trust anchor for
          // the zero-config desktop reader on per-entity canvas routes (never
          // header-derived). Mirrors the canvas API above.
          const dashPeerIp = server.requestIP(req)?.address;
          return handleDashboardApi(req, url, req.method, engine, self.db, dashPeerIp);
        }

        // Health check
        if (url.pathname === "/health") {
          return Response.json({
            status: "ok",
            uptime: engine.getUptime(),
            connections: sockets.size,
            rooms: engine.rooms.size,
            entities: engine.entities.size,
            agents: engine.getOnlineAgents().length,
          });
        }

        // Dashboard SPA — serve static files from dist/dashboard/
        if (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) {
          const subPath =
            url.pathname === "/dashboard" ? "index.html" : url.pathname.replace("/dashboard/", "");

          const filePath = join(DASHBOARD_DIST, subPath);
          const file = Bun.file(filePath);

          // SPA fallback: if file doesn't match a known extension, serve index.html
          return file
            .exists()
            .then((exists) => {
              if (exists) {
                return new Response(file);
              }
              // SPA fallback
              return serveDashboardIndex();
            })
            .catch(() => serveDashboardIndex());
        }

        // Canvas SPA — serve from same dist/dashboard/ (same SPA, path-based routing)
        if (url.pathname === "/canvas" || url.pathname.startsWith("/canvas/")) {
          return serveDashboardIndex();
        }

        // /who/<name> — public per-entity profile pages. Served from the same
        // SPA bundle; main.tsx routes to the WhoPage component based on the
        // pathname. No auth required (this is the chronicle's public face).
        if (url.pathname === "/who" || url.pathname.startsWith("/who/")) {
          return serveDashboardIndex();
        }

        // The dashboard is the primary human entry point. Keep the compact
        // web chat available at an explicit route for low-bandwidth use.
        if (url.pathname === "/") {
          return new Response(null, { status: 302, headers: { Location: "/dashboard" } });
        }

        if (url.pathname === "/chat") {
          const file = Bun.file(WEBCHAT_PATH);
          return new Response(file, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        if (url.pathname === "/ask") {
          const file = Bun.file(ASK_PATH);
          return new Response(file, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        return new Response("Marina — connect via WebSocket at /ws", {
          status: 200,
        });
      },

      websocket: {
        open(ws) {
          const connId = ws.data.connId;
          const ip = ws.data.ip;

          // Track connections
          self.totalConnections++;
          if (ip) {
            self.ipConnections.set(ip, (self.ipConnections.get(ip) ?? 0) + 1);
          }

          // Dashboard WebSocket
          if (ws.data.isDashboard) {
            if (self.broadcaster) {
              self.broadcaster.addClient(ws as ServerWebSocket<DashboardWSData>, engine);
            }
            return;
          }

          // Canvas WebSocket — scope the subscription against the principal
          // resolved at upgrade time. Private per-entity canvases (scope
          // "entity") are owner/operator-only; a denied subscription closes the
          // socket. Requires the DB for the canvas-scope lookup; without it we
          // cannot authorize, so the socket is closed rather than fail open.
          if (ws.data.isCanvas && ws.data.canvasId) {
            const canvasDb = self.db ?? engine.db;
            if (!canvasDb) {
              ws.close();
              return;
            }
            const principal = self.buildCanvasPrincipal(ws.data.principal, canvasDb);
            const admitted = self.canvasBroadcaster.addClient(ws, ws.data.canvasId, {
              db: canvasDb,
              principal,
            });
            if (!admitted) ws.close();
            return;
          }

          // Game WebSocket
          sockets.set(connId, ws);

          const conn: Connection = {
            id: connId,
            protocol: "websocket",
            entity: null,
            connectedAt: Date.now(),
            ip: ws.data.ip,
            peerIp: ws.data.peerIp,
            send(perception: Perception) {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify(perception));
              }
            },
            close() {
              ws.close();
            },
          };

          engine.addConnection(conn);

          // Send welcome prompt
          ws.send(
            JSON.stringify({
              kind: "system",
              timestamp: Date.now(),
              data: {
                text: "Welcome to Marina. Enter your name to begin.",
                skill: "/api/skill",
                connect: "/api/connect",
              },
            }),
          );
        },

        message(ws, message) {
          // Dashboard WS clients don't send game commands
          if (ws.data.isDashboard) return;

          const connId = ws.data.connId;
          const raw = typeof message === "string" ? message : new TextDecoder().decode(message);

          let parsed: {
            type: string;
            name?: string;
            command?: string;
            token?: string;
            secret?: string;
            internalToken?: string;
          };
          try {
            parsed = JSON.parse(raw);
          } catch {
            // Treat plain text as a command
            parsed = { type: "command", command: raw };
          }

          // Gateway shared-secret authentication
          if (parsed.type === "gateway_auth") {
            const gatewaySecret = process.env.GATEWAY_SECRET;
            if (gatewaySecret && parsed.secret && secretsEqual(parsed.secret, gatewaySecret)) {
              self.gatewayAuthed.add(connId);
            } else if (gatewaySecret) {
              ws.send(
                JSON.stringify({
                  kind: "error",
                  timestamp: Date.now(),
                  data: { text: "Gateway authentication failed." },
                }),
              );
              ws.close();
            }
            // If GATEWAY_SECRET is not set, ignore the message silently (backward compatible)
            return;
          }

          if (parsed.type === "login" && parsed.name) {
            // If GATEWAY_SECRET is set, a connection logging in under a Gateway_
            // name must have completed gateway_auth. NOTE: this authenticates the
            // gateway *handshake* only — it does NOT fence participation in
            // bridged channels or cross-instance tells, which are rank-0 commands
            // available to any logged-in entity. With passwordless name-login
            // (the default unless MARINA_AUTH=better-auth), a remote peer can
            // still act as an ordinary local entity. Treat GATEWAY_SECRET as
            // "who may present as a gateway peer," and rely on MARINA_AUTH +
            // not exposing open login for a hard federation boundary.
            const gatewaySecret = process.env.GATEWAY_SECRET;
            if (
              gatewaySecret &&
              parsed.name.startsWith("Gateway_") &&
              !self.gatewayAuthed.has(connId)
            ) {
              ws.send(
                JSON.stringify({
                  kind: "auth_error",
                  timestamp: Date.now(),
                  data: { text: "Gateway connections require authentication." },
                }),
              );
              ws.close();
              return;
            }

            const result = engine.login(connId, parsed.name, parsed.internalToken);
            if ("error" in result) {
              ws.send(
                JSON.stringify({
                  kind: "auth_error",
                  timestamp: Date.now(),
                  data: { text: result.error },
                }),
              );
              return;
            }
            ws.send(
              JSON.stringify({
                kind: "system",
                timestamp: Date.now(),
                data: {
                  text: `Logged in as ${result.name}.`,
                  entityId: result.entityId,
                  name: result.name,
                  token: result.token,
                  activeEvolutionSessions: engine.getActiveEvolutionSessions(result.name),
                },
              }),
            );
            engine.sendLook(result.entityId);
            engine.sendBrief(result.entityId);
            return;
          }

          if (parsed.type === "auth" && parsed.token) {
            const result = engine.reconnect(connId, parsed.token, parsed.internalToken);
            if ("error" in result) {
              ws.send(
                JSON.stringify({
                  kind: "auth_error",
                  timestamp: Date.now(),
                  data: { text: result.error },
                }),
              );
              return;
            }
            ws.send(
              JSON.stringify({
                kind: "system",
                timestamp: Date.now(),
                data: {
                  text: `Reconnected as ${result.name}.`,
                  entityId: result.entityId,
                  name: result.name,
                  token: result.token,
                  activeEvolutionSessions: engine.getActiveEvolutionSessions(result.name),
                },
              }),
            );
            engine.sendLook(result.entityId);
            engine.sendBrief(result.entityId);
            return;
          }

          if (parsed.type === "command" && parsed.command) {
            const entityId = engine.getConnectionEntity(connId);
            if (entityId) {
              // Rate limit check
              if (rateLimiter && !rateLimiter.consume(entityId)) {
                ws.send(
                  JSON.stringify({
                    kind: "error",
                    timestamp: Date.now(),
                    data: { text: "Rate limited. Please slow down." },
                  }),
                );
                return;
              }
              engine.processCommand(entityId, parsed.command);
            } else {
              ws.send(
                JSON.stringify({
                  kind: "error",
                  timestamp: Date.now(),
                  data: {
                    text: "You're not logged in. Enter your name to begin.",
                  },
                }),
              );
            }
          }
        },

        close(ws) {
          // Decrement connection counters
          self.totalConnections = Math.max(0, self.totalConnections - 1);
          const ip = ws.data.ip;
          if (ip) {
            const count = (self.ipConnections.get(ip) ?? 1) - 1;
            if (count <= 0) {
              self.ipConnections.delete(ip);
            } else {
              self.ipConnections.set(ip, count);
            }
          }

          if (ws.data.isDashboard) {
            if (self.broadcaster) {
              self.broadcaster.removeClient(ws as ServerWebSocket<DashboardWSData>);
            }
            return;
          }

          // Canvas WebSocket
          if (ws.data.isCanvas) {
            self.canvasBroadcaster.removeClient(ws);
            return;
          }

          const connId = ws.data.connId;
          sockets.delete(connId);
          self.gatewayAuthed.delete(connId);
          engine.removeConnection(connId);
        },
      },
    });

    this.port = this.server.port ?? this.port;
    registerConnectEndpoint(this.engine, "websocket", this.port);
    console.log(`WebSocket server listening on ws://localhost:${this.port}/ws`);
    if (existsSync(DASHBOARD_INDEX)) {
      console.log(`Dashboard available at http://localhost:${this.port}/dashboard`);
    } else {
      console.warn(
        `Dashboard not built yet — run \`bun run dashboard:build\` (installs + builds dashboard/), then reload http://localhost:${this.port}/dashboard. No server restart needed.`,
      );
    }
    console.log(`Canvas available at http://localhost:${this.port}/canvas`);
  }

  getPort(): number {
    return this.port;
  }

  /** The hostname the running server is actually bound to (for diagnostics/tests). */
  getBoundHostname(): string | undefined {
    return this.server?.hostname;
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }
}
