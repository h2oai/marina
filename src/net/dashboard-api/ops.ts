// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Glue for the `/api/ops/*` surface. The implementation lives in
// `src/net/ops-api.ts`; this module owns only the two route predicates and
// their authorization, keeping the registration point inside
// `handleDashboardApi` as before.

import {
  authorizeSettingsWrite,
  changeDecisionSetting,
  DECISIONS_CONFIGURE_GATE,
  DecisionSettingError,
  decisionSettingsHistory,
  describeDecisionSettings,
  isAgentDriven,
} from "../../decisions/settings";
import { getErrorMessage } from "../../engine/errors";
import { checkGateForExecution, recordGateExecution } from "../../engine/safety-gates";
import { buildOpsOverview, opsObserverScope, stopAgentCascade } from "../ops-api";
import { authorizePrivileged, type DashboardRouteContext, json, readSmallJsonBody } from "./shared";

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

  // ─── Runtime decision settings (src/decisions/settings.ts) ───────────────
  // Read: privileged observers. Write: `admin.destructive`, never an agent;
  // a variable the environment sets is locked (409).
  if (url.pathname === "/api/ops/decisions/settings" && method === "GET") {
    if (!opsObserverScope(engine, callerId).privileged) {
      return json({ error: "Decision settings are visible to operators only." }, 403);
    }
    return json({
      settings: describeDecisionSettings(db),
      history: db ? decisionSettingsHistory(db).slice(0, 20) : [],
      runtime: !!db,
    });
  }
  if (url.pathname === "/api/ops/decisions/settings" && method === "PUT") {
    if (!db) return json({ error: "Runtime settings need a database." }, 503);
    const caller = engine.entities.get(callerId);
    const agent = isAgentDriven({
      internalConnection: !!engine.getConnectionForEntity(callerId)?.internal,
      hasAgentConfig: !!(caller && db.getAgentConfig(caller.name)),
    });
    if (agent) {
      // An agent needs the earned decisions.configure gate — never admin.destructive alone.
      const auth = authorizeSettingsWrite(
        {
          check: (id, gate) => checkGateForExecution(db, id, gate),
          record: (id, gate, result, evidence) =>
            recordGateExecution(db, id, gate, result, evidence),
        },
        callerId,
        true,
      );
      if (!auth.ok) return json({ error: auth.reason }, 403);
    } else {
      // A person: admin.destructive, or the decisions.configure gate on its own.
      const denied = authorizePrivileged(engine, db, callerId, "admin.destructive");
      if (denied && authorizePrivileged(engine, db, callerId, DECISIONS_CONFIGURE_GATE)) {
        return denied;
      }
    }
    const body = await readSmallJsonBody<{ setting?: unknown; value?: unknown }>(ctx.req);
    if ("error" in body) return body.error;
    if (
      typeof body.setting !== "string" ||
      (body.value !== null && typeof body.value !== "string")
    ) {
      return json({ error: "Body must be { setting: string, value: string | null }." }, 400);
    }
    try {
      const setting = changeDecisionSetting(
        db,
        body.setting,
        body.value,
        caller?.name ?? "operator",
        { agent },
      );
      return json({ setting });
    } catch (error) {
      if (error instanceof DecisionSettingError)
        return json({ error: error.message }, error.status);
      return json({ error: getErrorMessage(error) }, 500);
    }
  }

  return undefined;
}
