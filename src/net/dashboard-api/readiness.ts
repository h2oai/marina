// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Capability readiness, the operational-alert queue and the productivity
// rollup. Two route groups because `/api/productivity` sits after the memory
// observability block in the dispatch order and that precedence is preserved.

import { type Challenge, listAnswerable, listRaisedBy } from "../../engine/challenges";
import { syncOperationalAlerts } from "../../engine/commands/ops";
import { computeReadiness } from "../../engine/readiness";
import { authorizePrivileged, type DashboardRouteContext, json, readSmallJsonBody } from "./shared";

/** Readiness + operational alerts (ack / resolve / snooze). */
export async function handleReadinessRoutes(
  ctx: DashboardRouteContext,
): Promise<Response | undefined> {
  const { callerId, db, engine, method, req, url } = ctx;
  // Capability readiness — same data as the in-world `status` command. Reports
  // config presence (never secret values) + remediation per capability.
  if (url.pathname === "/api/readiness" && method === "GET") {
    return json(computeReadiness(engine));
  }
  if (url.pathname === "/api/operations/alerts" && method === "GET" && db) {
    if (engine.taskManager)
      syncOperationalAlerts({
        db,
        tasks: engine.taskManager,
        runtime: engine.agentRuntime,
        readiness: () => computeReadiness(engine),
      });
    return json(db.listOperationalAlerts(undefined, 100));
  }
  // The caller's own held actions, as the in-world `challenge list` shows
  // them: what waits on the caller's answer and what the caller asked for.
  // Masked summaries only (never the held input); any session may read its own.
  if (url.pathname === "/api/challenges/mine" && method === "GET") {
    const me = engine.entities.get(callerId);
    const view = (c: Challenge) => ({
      token: c.token,
      kind: c.kind,
      requester: c.requesterName,
      summary: c.summary,
      reason: c.reason,
      expiresAt: c.expiresAt,
    });
    return json({
      answerable: me ? listAnswerable(me).map(view) : [],
      raised: me ? listRaisedBy(me.id).map(view) : [],
    });
  }
  const opsAlertMatch = url.pathname.match(/^\/api\/operations\/alerts\/(\d+)\/(ack|resolve)$/);
  if (opsAlertMatch && method === "POST" && db) {
    const denied = authorizePrivileged(engine, db, callerId, "admin.destructive");
    if (denied) return denied;
    const ok = db.setOperationalAlertStatus(
      Number(opsAlertMatch[1]),
      opsAlertMatch[2] === "ack" ? "acknowledged" : "resolved",
    );
    return ok ? json({ ok: true }) : json({ error: "Alert not found" }, 404);
  }
  const opsAlertSnoozeMatch = url.pathname.match(/^\/api\/operations\/alerts\/(\d+)\/snooze$/);
  if (opsAlertSnoozeMatch && method === "POST" && db) {
    const denied = authorizePrivileged(engine, db, callerId, "admin.destructive");
    if (denied) return denied;
    const body = await readSmallJsonBody<{ durationMs?: unknown }>(req, { allowEmpty: true });
    if ("error" in body) return body.error;
    const durationMs = Number(body.durationMs);
    if (!Number.isFinite(durationMs) || durationMs < 60_000 || durationMs > 30 * 86_400_000) {
      return json({ error: "durationMs must be between 1 minute and 30 days" }, 400);
    }
    const ok = db.snoozeOperationalAlert(Number(opsAlertSnoozeMatch[1]), Date.now() + durationMs);
    return ok ? json({ ok: true }) : json({ error: "Alert not found" }, 404);
  }

  return undefined;
}

/** Productivity rollup — dispatched after the memory observability group. */
export async function handleProductivityRoute(
  ctx: DashboardRouteContext,
): Promise<Response | undefined> {
  const { db, method, url } = ctx;
  if (url.pathname === "/api/productivity" && method === "GET" && db) {
    const entityName = url.searchParams.get("entity") ?? undefined;
    return json({
      summary: db.getProductivitySummary(entityName),
      leaderboard: db.getProductivityLeaderboard(),
      trend: db.getProductivityTrend(entityName),
      primitiveUsage: db.getPrimitiveUsageSummary(entityName),
      primitiveLeaderboard: db.getPrimitiveUsageLeaderboard(),
      promptOutcomes: db.getPromptOutcomeSummaries(),
    });
  }

  return undefined;
}
