// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Glue for the `/api/ops/*` surface. The implementation lives in
// `src/net/ops-api.ts`; this module owns only the two route predicates and
// their authorization, keeping the registration point inside
// `handleDashboardApi` as before.

import { getErrorMessage } from "../../engine/errors";
import { buildOpsOverview, opsObserverScope, stopAgentCascade } from "../ops-api";
import { authorizePrivileged, type DashboardRouteContext, json } from "./shared";

/** Ops overview (observer-scoped read) + the privileged agent cascade stop. */
export async function handleOpsRoutes(ctx: DashboardRouteContext): Promise<Response | undefined> {
  const { callerId, db, engine, method, url } = ctx;
  // ─── Ops (src/net/ops-api.ts) ────────────────────────────────────────────
  // Observer-scoped like the memory routes: privileged principals see every
  // agent, the spend ledger, retention, prompt budget, provider probe and
  // security posture; a resident sees only its own agents and no provider
  // probe. Read-only except the cascade stop, which is privileged.
  if (url.pathname === "/api/ops/overview" && method === "GET") {
    return json(buildOpsOverview(engine, opsObserverScope(engine, callerId)));
  }
  const opsAgentStopMatch = url.pathname.match(/^\/api\/ops\/agents\/([^/]+)\/stop$/);
  if (opsAgentStopMatch && method === "POST") {
    const denied = authorizePrivileged(engine, db, callerId, "agent.spawn");
    if (denied) return denied;
    const name = decodeURIComponent(opsAgentStopMatch[1]!);
    try {
      const result = await stopAgentCascade(engine, name);
      return result ? json(result) : json({ error: `Agent "${name}" is not running.` }, 404);
    } catch (error) {
      return json({ error: getErrorMessage(error) }, 500);
    }
  }

  return undefined;
}
