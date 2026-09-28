// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getInternalModelToken } from "../agent/agent-runtime";
import { RateLimiter } from "../auth/rate-limiter";
import { secretsEqual } from "../auth/secret-compare";
import { WS_IDLE_TIMEOUT_SECONDS } from "../engine/constants";
import type { Engine } from "../engine/engine";
import { Logger } from "../engine/logger";
import type { FlywheelToolBackend } from "../integrations/flywheel-manager";
import type { Connection, Perception } from "../types";
import {
  buildConnectManifest,
  handleSkillRequest,
  negotiateConnectCapabilities,
  registerConnectEndpoint,
} from "./connect-api";
import { isTrustedBrowserOrigin } from "./cors";
import { consumeHttpRate, rateLimitedResponse, securityHeaders } from "./http-utils";
import type { McpSession } from "./mcp-types";
import { createWorldMcpServer } from "./mcp-world-tools";
import { RequestDrain } from "./request-drain";
import { isLoopbackHostname, resolveWsBindHostname } from "./websocket-server";

export { McpArgError, quoteArg, textArg } from "./mcp-arguments";
export { createMemoryMcpServer } from "./mcp-memory-tools";

const logger = new Logger();
let mcpIdCounter = 0;

// ─── Transport hardening ──────────────────────────────────────────────────────

/** Secrets accepted from `MODEL_API_KEYS` (`secret` or `secret:entity` entries). */
function modelApiKeySecrets(): string[] {
  const raw = process.env.MODEL_API_KEYS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      const colon = k.indexOf(":");
      return colon > 0 ? k.slice(0, colon) : k;
    });
}

/**
 * Whether `/mcp` requires a bearer at the transport layer. The `local` posture
 * (loopback-only bind, no keys, no external auth) stays unauthenticated so a
 * plain `{"url": "http://localhost:3301/mcp"}` client config keeps working;
 * anything stronger — API keys configured, sign-in enabled, or a non-loopback
 * bind — turns the requirement on.
 */
export function mcpTransportAuthRequired(loopbackBind: boolean): boolean {
  return (
    modelApiKeySecrets().length > 0 || process.env.MARINA_AUTH === "better-auth" || !loopbackBind
  );
}

/**
 * Transport-layer bearer check for `/mcp`. Accepts (constant-time, every
 * candidate compared): the process-internal token, any `MODEL_API_KEYS` secret,
 * or a valid Marina session token. Returns `null` when the request may proceed.
 */
export function authenticateMcpTransport(
  req: Request,
  engine: Engine,
  loopbackBind: boolean,
): Response | null {
  if (!mcpTransportAuthRequired(loopbackBind)) return null;
  const auth = req.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  let ok = false;
  if (token) {
    const internal = getInternalModelToken();
    if (secretsEqual(token, internal)) ok = true;
    for (const secret of modelApiKeySecrets()) if (secretsEqual(token, secret)) ok = true;
    if (!ok && engine.authenticate(token)) ok = true;
  }
  if (ok) return null;
  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "MCP transport requires authentication: send Authorization: Bearer <MODEL_API_KEYS " +
          "secret | Marina session token>.",
      },
      id: null,
    },
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="marina-mcp"', ...securityHeaders("api") },
    },
  );
}

/**
 * `Host` header values the streamable-HTTP transport accepts (DNS-rebinding
 * protection). On a loopback bind: every loopback spelling on the live port plus
 * `MARINA_MCP_ALLOWED_HOSTS`. On a non-loopback bind: only the env list (bearer
 * auth is mandatory there) — `undefined` disables host validation when the
 * operator has not declared the public hostnames.
 */
export function mcpAllowedHosts(
  bindHost: string,
  port: number,
  loopbackBind: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const extra = (env.MARINA_MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const hosts = new Set<string>();
  const add = (host: string) => {
    hosts.add(host);
    // A bare hostname also matches on the live port; the SDK compares exactly.
    if (!/:\d+$/.test(host) && !/^\[.*\]$/.test(host)) hosts.add(`${host}:${port}`);
    if (/^\[.*\]$/.test(host)) hosts.add(`${host}:${port}`);
  };
  if (loopbackBind) {
    for (const h of ["localhost", "127.0.0.1", "[::1]"]) add(h);
    add(bindHost.toLowerCase());
  } else if (extra.length === 0) {
    return undefined;
  }
  for (const h of extra) add(h);
  return [...hosts];
}

// ─── McpServerAdapter ─────────────────────────────────────────────────────────

export class McpServerAdapter {
  private draining = false;
  private readonly requestDrain = new RequestDrain();
  drainRequests(): Promise<void> {
    return this.requestDrain.wait();
  }
  beginDrain(): void {
    this.draining = true;
  }
  // biome-ignore lint: Bun.serve return type
  private server: any = null;
  private sessions = new Map<string, McpSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private engine: Engine,
    private port: number,
    private rateLimiter: RateLimiter = new RateLimiter(),
    /**
     * Kept for signature compatibility only. The `flywheel` tool now routes
     * through the engine's `code sandbox` / `code run` / `code service`
     * commands (so `minRank`, LAYER 0 and the `code.exec` gate apply) and
     * therefore uses `engine.flywheel`, never a side channel.
     */
    _flywheel: FlywheelToolBackend | undefined = engine.flywheel,
  ) {}

  start(): void {
    const engine = this.engine;
    const sessions = this.sessions;
    const self = this;

    const bindHostname = resolveWsBindHostname();
    const loopbackBind = isLoopbackHostname(bindHostname);
    let warnedNoAllowedHosts = false;

    const serverOptions = {
      port: this.port,
      // Secure-by-default: bind loopback-only unless WS_HOST/MARINA_HOST is set
      // or MARINA_PUBLIC=true. Mirrors the WebSocket server so the MCP surface is
      // never silently exposed on all interfaces on a fresh desktop node.
      hostname: bindHostname,
      idleTimeout: WS_IDLE_TIMEOUT_SECONDS,
      maxRequestBodySize: 8 * 1024 * 1024,
      error(error: unknown) {
        logger.error("mcp", "Unhandled request error", { error });
        return Response.json(
          { error: "Internal server error" },
          { status: 500, headers: securityHeaders("api") },
        );
      },

      async fetch(req, server) {
        const leave = self.requestDrain.enter();
        try {
          if (self.draining)
            return Response.json(
              { error: "Instance is draining" },
              { status: 503, headers: { "Retry-After": "5" } },
            );
          const url = new URL(req.url);

          if (url.pathname === "/health") {
            return Response.json({
              status: "ok",
              protocol: "mcp",
              sessions: sessions.size,
              rooms: engine.rooms.size,
              entities: engine.entities.size,
            });
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

          if (url.pathname === "/mcp") {
            // Browser-origin gate: a page on another site must not drive a
            // loopback MCP endpoint (non-browser clients send no Origin and pass).
            const origin = req.headers.get("Origin");
            if (!isTrustedBrowserOrigin(origin, req.headers.get("Host"), { loopbackBind })) {
              return new Response("Forbidden origin", {
                status: 403,
                headers: securityHeaders("api"),
              });
            }

            // Transport-layer bearer (keys configured / sign-in on / public bind).
            const unauthorized = authenticateMcpTransport(req, engine, loopbackBind);
            if (unauthorized) return unauthorized;

            const sessionId = req.headers.get("mcp-session-id");
            const session = sessionId ? sessions.get(sessionId) : undefined;

            if (session) {
              return await session.transport.handleRequest(req);
            }

            // Real socket peer for this session's client — used to key the
            // login-attempt throttle. Without it, every MCP session falls back to
            // its unique connId and each new session gets a fresh throttle bucket,
            // bypassing checkLoginRate entirely (a flood of new sessions is never
            // limited). Sharing one bucket per peer IP closes that bypass.
            const peerIp = server.requestIP(req)?.address ?? undefined;

            // Session creation is itself throttled per peer (MCP_SESSION limit,
            // `MARINA_MCP_SESSIONS_PER_MIN`): every new transport allocates an
            // engine connection, so an unauthenticated flood must be bounded. The
            // bucket is scoped to this listener's port so two adapters in one
            // process (tests, multi-instance hosts) never share a budget.
            const throttleKey = `${server.port ?? self.port}|${peerIp ?? "unknown"}`;
            if (!consumeHttpRate("mcpSession", throttleKey)) {
              return rateLimitedResponse(origin, 60);
            }

            // DNS-rebinding protection: validate the Host header against the
            // bind + `MARINA_MCP_ALLOWED_HOSTS`.
            const allowedHosts = mcpAllowedHosts(
              bindHostname,
              server.port ?? self.port,
              loopbackBind,
            );
            if (!allowedHosts && !warnedNoAllowedHosts) {
              warnedNoAllowedHosts = true;
              logger.warn(
                "mcp",
                "Non-loopback bind without MARINA_MCP_ALLOWED_HOSTS — Host validation is off; " +
                  "set MARINA_MCP_ALLOWED_HOSTS=mcp.example.com[:port] to enable it.",
              );
            }

            // New session
            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              enableDnsRebindingProtection: allowedHosts !== undefined,
              allowedHosts,
              onsessioninitialized(newSessionId: string) {
                const connId = `mcp_${++mcpIdCounter}`;
                const newSession: McpSession = {
                  connId,
                  entityId: null,
                  peerIp,
                  throttleKey,
                  perceptionBuffer: [],
                  commandTail: Promise.resolve(),
                  transport,
                  mcp,
                };

                const conn: Connection = {
                  id: connId,
                  protocol: "mcp",
                  entity: null,
                  connectedAt: Date.now(),
                  // Header-derived rate-limit/throttle key ONLY — never a trust
                  // anchor (peerIp/loopback trust is left unset for MCP).
                  ip: peerIp,
                  send(perception: Perception) {
                    newSession.perceptionBuffer.push(perception);
                  },
                  close() {
                    sessions.delete(newSessionId);
                    engine.removeConnection(connId);
                  },
                };

                engine.addConnection(conn);
                sessions.set(newSessionId, newSession);
              },
              onsessionclosed(closedSessionId: string) {
                const s = sessions.get(closedSessionId);
                if (s) {
                  engine.removeConnection(s.connId);
                  sessions.delete(closedSessionId);
                }
              },
            });

            const mcp = self.createMcpServer();
            await mcp.connect(transport);

            return await transport.handleRequest(req);
          }

          return new Response("Marina MCP Server — connect via MCP protocol at /mcp", {
            status: 200,
          });
        } finally {
          leave();
        }
      },
    } satisfies Parameters<typeof Bun.serve>[0];

    try {
      this.server = Bun.serve(serverOptions);
    } catch (error) {
      // Some Bun builds intermittently fail to bind port 0 during rapid test and
      // restart cycles. Preserve explicit-port failures, but make ephemeral-port
      // startup resilient by retrying a bounded set of high local ports.
      if (this.port !== 0) throw error;
      let lastError = error;
      for (let attempt = 0; attempt < 8 && !this.server; attempt++) {
        const fallbackPort = 40_000 + Math.floor(Math.random() * 20_000);
        try {
          this.server = Bun.serve({ ...serverOptions, port: fallbackPort });
        } catch (candidateError) {
          lastError = candidateError;
        }
      }
      if (!this.server) throw lastError;
    }

    // Periodic cleanup of stale MCP sessions (every 5 minutes)
    this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), 300_000);

    this.port = this.server.port ?? this.port;
    registerConnectEndpoint(this.engine, "mcp", this.port);
    logger.info("mcp", `MCP server listening on http://localhost:${this.port}/mcp`, {
      port: this.port,
    });
  }

  getPort(): number {
    return this.port;
  }

  /** Remove MCP sessions whose connections are no longer in the engine. */
  private cleanupStaleSessions(): void {
    for (const [sessionId, session] of this.sessions) {
      // Check if the engine still knows about this connection
      const connections = this.engine.getConnections();
      if (!connections.has(session.connId)) {
        this.sessions.delete(sessionId);
        session.mcp.close().catch(() => {});
      }
    }
  }

  async stop(): Promise<void> {
    this.draining = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await Promise.allSettled(
      [...this.sessions.values()].map(async (session) => {
        await session.commandTail;
        this.engine.removeConnection(session.connId);
        await session.mcp.close();
      }),
    );
    this.sessions.clear();
    if (this.server) {
      await this.server.stop(true);
      this.server = null;
    }
  }

  private createMcpServer(): McpServer {
    return createWorldMcpServer(this.engine, this.sessions, this.rateLimiter);
  }
}
