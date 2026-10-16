// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "../../engine/errors";
import { Logger } from "../../engine/logger";
import { investigationActor, investigationRecipient } from "../../investigations/identity";
import { resolveInvestigation } from "../../investigations/resolve";
import { type InvestigationService, investigationService } from "../../investigations/service";
import {
  InvestigationError,
  investigationKey,
  parseInvestigationRequest,
} from "../../investigations/validation";
import { isSentinelPrincipal } from "../auth-middleware";
import { type DashboardRouteContext, json, readJsonBody } from "./shared";

const logger = new Logger();

export async function handleInvestigationRoutes(
  ctx: DashboardRouteContext,
  executor?: InvestigationService,
): Promise<Response | undefined> {
  const { req, url, method, db, engine, callerId } = ctx;
  if (url.pathname !== "/api/investigations" && !url.pathname.startsWith("/api/investigations/"))
    return undefined;
  const reply = (value: unknown, status = 200) => {
    const response = json(value, status, req.headers.get("Origin"));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
  try {
    if (!db)
      throw new InvestigationError(
        "storage_required",
        "Investigations need persistent storage",
        503,
      );
    if (isSentinelPrincipal(callerId))
      throw new InvestigationError(
        "account_required",
        "Sign in to use private investigations",
        403,
      );
    const actor = investigationActor(db, engine.entities.get(callerId)?.name);
    const service = executor ?? investigationService(db);
    const parts = url.pathname
      .slice("/api/investigations".length)
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    if (!parts.length && method === "GET")
      return reply({
        cases: db.listInvestigations(
          actor.key,
          url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined,
        ),
      });
    if (!parts.length && method === "POST") {
      const body = await readJsonBody<Record<string, unknown>>(req, { maxBytes: 32_768 });
      if ("error" in body)
        return body.error instanceof Response
          ? body.error
          : reply({ error: "Unexpected error field", code: "invalid_request" }, 400);
      const key = investigationKey(req.headers.get("Idempotency-Key") ?? body.idempotencyKey);
      const admitted = service.start(actor, parseInvestigationRequest(body), key);
      return reply(admitted, admitted.created ? 202 : 200);
    }
    if (parts[0] === "content" && parts.length === 2 && method === "GET")
      return reply(db.getInvestigationContent(actor.key, parts[1]!));
    if (parts[0] === "attempts" && parts[1]) {
      const id = parts[1];
      if (
        parts.length === 3 &&
        method === "POST" &&
        (parts[2] === "review" || parts[2] === "resolve")
      ) {
        const body = await readJsonBody<{ text?: string; value?: unknown }>(req, {
          maxBytes: 8192,
        });
        if ("error" in body) return body.error;
        return reply(
          parts[2] === "review"
            ? db.reviewInvestigation(actor, id, body.text ?? "")
            : resolveInvestigation(db, actor, id, body.value),
        );
      }
      if (parts.length === 2 && method === "GET")
        return reply(db.getInvestigationAttempt(actor.key, id));
      if (parts.length === 3 && parts[2] === "events" && method === "GET")
        return reply(
          db.readInvestigationEvents(
            actor.key,
            id,
            Number(url.searchParams.get("after") ?? 0),
            Number(url.searchParams.get("limit") ?? 100),
          ),
        );
      if (parts.length === 3 && parts[2] === "cancel" && method === "POST")
        return reply({ cancelled: service.cancel(actor.key, id) });
      if (parts.length === 3 && parts[2] === "select" && method === "POST")
        return reply(db.selectInvestigationAttempt(actor.key, id));
    }
    if (parts.length === 1 && method === "GET")
      return reply(
        db.getInvestigation(actor.key, parts[0]!, url.searchParams.get("attempt") ?? undefined),
      );
    if (parts.length === 1 && method === "DELETE") {
      // Erasure fences late writes through the removed case; it never stops an agent.
      db.eraseInvestigation(actor.key, parts[0]!);
      return reply({ erased: true });
    }
    if (parts.length === 2 && parts[1] === "grants" && method === "POST") {
      const body = await readJsonBody<Record<string, unknown>>(req, { maxBytes: 4096 });
      if ("error" in body)
        return body.error instanceof Response
          ? body.error
          : reply({ error: "Unexpected error field", code: "invalid_request" }, 400);
      if (body.access !== null && body.access !== "read" && body.access !== "work")
        throw new InvestigationError(
          "invalid_request",
          "Access must be read, work or null (revoke)",
        );
      const recipient = investigationRecipient(db, body.name);
      db.grantInvestigation(actor.key, parts[0]!, recipient.key, body.access);
      return reply({ name: recipient.name, access: body.access });
    }
    return reply({ code: "not_found", error: "Investigation route not found" }, 404);
  } catch (error) {
    if (error instanceof InvestigationError)
      return reply({ code: error.code, error: error.message }, error.status);
    logger.error("dashboard-api", "Investigation request failed", {
      error: getErrorMessage(error),
    });
    return reply(
      { code: "investigation_failed", error: "Could not complete the investigation request" },
      500,
    );
  }
}
