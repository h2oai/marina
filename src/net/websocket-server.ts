import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
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
import { type CanvasNodeCreatedEvent, handleCanvasApi } from "./canvas-api";
import { CanvasBroadcaster } from "./canvas-ws";
import { buildConnectManifest, handleSkillRequest } from "./connect-api";
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

interface WSData {
  connId: string;
  isDashboard?: boolean;
  isCanvas?: boolean;
  canvasId?: string;
  ip?: string;
  [key: string]: unknown;
}

let wsIdCounter = 0;

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

  start(): void {
    const engine = this.engine;
    const sockets = this.sockets;
    const rateLimiter = this.rateLimiter;
    const self = this;

    this.server = Bun.serve<WSData>({
      port: this.port,
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
          // Extract client IP (once for limit check + pass to WSData)
          const fwd = req.headers.get("x-forwarded-for");
          const ip =
            (fwd ? fwd.split(",")[0]!.trim() : null) ??
            req.headers.get("x-real-ip") ??
            server.requestIP(req)?.address ??
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

          // Dashboard WebSocket upgrade
          if (url.pathname === "/dashboard-ws") {
            const connId = `dash_${++wsIdCounter}`;
            const upgraded = server.upgrade(req, {
              data: { connId, isDashboard: true, ip },
            });
            if (!upgraded) {
              return new Response("WebSocket upgrade failed", { status: 400 });
            }
            return undefined;
          }

          // Game WebSocket upgrade
          if (url.pathname === "/ws") {
            const connId = `ws_${++wsIdCounter}`;
            const upgraded = server.upgrade(req, { data: { connId, ip } });
            if (!upgraded) {
              return new Response("WebSocket upgrade failed", { status: 400 });
            }
            return undefined;
          }

          // Canvas WebSocket upgrade
          if (url.pathname === "/canvas-ws") {
            const canvasId = url.searchParams.get("canvas");
            if (!canvasId) {
              return new Response("Missing canvas query param", { status: 400 });
            }
            const connId = `canvas_${++wsIdCounter}`;
            const upgraded = server.upgrade(req, {
              data: { connId, isCanvas: true, canvasId, ip },
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
          return handleCanvasApi(
            url,
            req.method,
            req,
            self.db,
            self.storage,
            self.canvasBroadcaster,
            engine,
            self.onNodeCreated,
          );
        }

        // Connect manifest
        if (url.pathname === "/api/connect") {
          return buildConnectManifest(req, engine);
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
          );
          if (modelResp) return modelResp;
        }

        // API routes
        if (url.pathname.startsWith("/api/")) {
          return handleDashboardApi(req, url, req.method, engine, self.db);
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
              return new Response(Bun.file(join(DASHBOARD_DIST, "index.html")));
            })
            .catch(() => new Response(Bun.file(join(DASHBOARD_DIST, "index.html"))));
        }

        // Canvas SPA — serve from same dist/dashboard/ (same SPA, path-based routing)
        if (url.pathname === "/canvas" || url.pathname.startsWith("/canvas/")) {
          return new Response(Bun.file(join(DASHBOARD_DIST, "index.html")), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        // /who/<name> — public per-entity profile pages. Served from the same
        // SPA bundle; main.tsx routes to the WhoPage component based on the
        // pathname. No auth required (this is the chronicle's public face).
        if (url.pathname === "/who" || url.pathname.startsWith("/who/")) {
          return new Response(Bun.file(join(DASHBOARD_DIST, "index.html")), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        // Serve web chat widget
        if (url.pathname === "/" || url.pathname === "/chat") {
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

          // Canvas WebSocket
          if (ws.data.isCanvas && ws.data.canvasId) {
            self.canvasBroadcaster.addClient(ws, ws.data.canvasId);
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
                text: 'Welcome to Marina. Send {"type":"login","name":"YourName"} to begin.',
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
            // If GATEWAY_SECRET is set and the login looks like a gateway, require auth
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
                    text: 'Not logged in. Send {"type":"login","name":"YourName"} first.',
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

    console.log(`WebSocket server listening on ws://localhost:${this.port}/ws`);
    console.log(`Dashboard available at http://localhost:${this.port}/dashboard`);
    console.log(`Canvas available at http://localhost:${this.port}/canvas`);
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }
}
