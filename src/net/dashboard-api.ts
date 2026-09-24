// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Dashboard API entry point. The route implementations live in
// `./dashboard-api/*` (one module per concern, strict import DAG rooted at
// `shared.ts`); this file owns the pre-auth ingress hand-off, the session
// gate, the per-principal rate limiter, the ordered dispatch table and the
// stable public re-exports. Importers never need to know about the layout.

import type { Engine } from "../engine/engine";
import type { MarinaDB } from "../persistence/database";
import { authenticateRequest, isSentinelPrincipal } from "./auth-middleware";
import { handleAgentRoutes } from "./dashboard-api/agents";
import { handlePreAuthRoutes } from "./dashboard-api/command";
import { handleKeyRoutes } from "./dashboard-api/keys";
import {
  handleMemoryGraphRoutes,
  handleMemoryNoteRoutes,
  handleMemoryObservabilityRoutes,
} from "./dashboard-api/memory";
import { handleOpsRoutes } from "./dashboard-api/ops";
import { handleProductivityRoute, handleReadinessRoutes } from "./dashboard-api/readiness";
import type { DashboardApiOptions, DashboardRouteContext } from "./dashboard-api/shared";
import { extractIp, json } from "./dashboard-api/shared";
import { handleSystemRoutes } from "./dashboard-api/system";
import {
  handleCoordinationListRoutes,
  handleCoordinationRoutes,
  handleEntityRoutes,
  handleWorldCatalogRoutes,
} from "./dashboard-api/world";
import { consumeHttpRate, rateLimitedResponse } from "./http-utils";
import { memoryObserver } from "./memory-visibility";

// Public surface consumed by other modules, scripts and tests
// (websocket-server.ts, scripts/research/memory-surface-audit.ts, test/*) —
// keep these re-exports stable so importers never need to know about the
// `./dashboard-api/*` layout.
export { projectEnvValueForRead } from "./dashboard-api/keys";
export type { DashboardApiOptions } from "./dashboard-api/shared";

// --- Route handler ---

export async function handleDashboardApi(
  req: Request,
  url: URL,
  method: string,
  engine: Engine,
  db?: MarinaDB,
  peerIp?: string,
  opts: DashboardApiOptions = {},
): Promise<Response | undefined> {
  // Pre-auth endpoints (no session required — used by dashboard before login)
  const preAuth = await handlePreAuthRoutes(req, url, method, engine, db, peerIp, opts);
  if (preAuth) return preAuth;

  // Authenticate — every dashboard API route from this point on requires a
  // valid session token. The pre-auth surface above (`/api/setup-status`,
  // `/api/command`, `/api/ask`) is intentionally open / self-gated and runs
  // before this check.
  const auth = authenticateRequest(req, engine);
  if ("error" in auth) return auth.error;
  const callerId = auth.entityId;
  // Per-principal budget for the authenticated REST surface (DASHBOARD_API
  // limit in http-utils.ts). Sentinels share one id, so they are keyed by
  // client IP instead of letting every dev-open caller pool into one bucket.
  const rateKey = isSentinelPrincipal(callerId)
    ? `${callerId}@${extractIp(req, peerIp)}`
    : callerId;
  if (!consumeHttpRate("dashboard", rateKey)) {
    return rateLimitedResponse(req.headers.get("Origin"));
  }
  const memory = memoryObserver(engine, callerId);
  if (
    (url.pathname === "/api/traces" ||
      url.pathname === "/api/logs" ||
      url.pathname.startsWith("/api/evidence/")) &&
    !memory.privilegedRead
  )
    return json({ error: "Operator read capability required" }, 403);

  const ctx: DashboardRouteContext = { req, url, method, engine, db, peerIp, callerId, memory };

  // Dispatch in exactly the pre-split order — route precedence is load-bearing
  // (greedy `(.+)` detail matchers must stay ahead of the list routes, the
  // parameterized entity routes ahead of the `/api/entities/:name` catch-all).
  return (
    (await handleSystemRoutes(ctx)) ??
    (await handleReadinessRoutes(ctx)) ??
    (await handleOpsRoutes(ctx)) ??
    (await handleMemoryObservabilityRoutes(ctx)) ??
    (await handleProductivityRoute(ctx)) ??
    (await handleCoordinationRoutes(ctx)) ??
    (await handleMemoryGraphRoutes(ctx)) ??
    (await handleEntityRoutes(ctx)) ??
    (await handleMemoryNoteRoutes(ctx)) ??
    (await handleCoordinationListRoutes(ctx)) ??
    (await handleAgentRoutes(ctx)) ??
    (await handleKeyRoutes(ctx)) ??
    (await handleWorldCatalogRoutes(ctx)) ??
    (url.pathname.startsWith("/api/") ? json({ error: "Not found" }, 404) : undefined)
  );
}
