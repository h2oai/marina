// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /v1/outcomes` — an agent reports how a request it made turned out:
 * `{ requestId, succeeded, quality?, detail? }`, where `requestId` is the
 * `x-request-id` Marina returned. The result is one outcome on the outcome
 * path (`request:<requestId>`) carrying the model that served the request, so
 * what connected agents actually get done feeds live evidence and model
 * selection (`outcome evidence`, `MARINA_ROUTE_EVIDENCE_LIVE`).
 *
 * Only the caller that made the request may report it: the key must be bound
 * to an entity and the request's lifecycle must name that caller. Reported
 * once (settle once). A report carrying `x-marina-eval: …; mode=measure` is
 * recorded as measurement and never counts. Request outcomes carry no text,
 * so they feed evidence, not lessons.
 */

import type { Engine } from "../engine/engine";
import { evalOption } from "../learning/eval-context";
import { recordResolved } from "../outcomes/record";
import type { EngineEvent } from "../types";
import { errorJson, json, type PassthruAuthResult } from "./model-api/shared";

type Lifecycle = Extract<EngineEvent, { type: "model_request_lifecycle" }>;

export async function handleOutcomeReport(
  req: Request,
  engine: Pick<Engine, "db" | "entities">,
  auth: Pick<PassthruAuthResult, "boundEntityName"> | undefined,
): Promise<Response> {
  const owner = auth?.boundEntityName;
  if (!owner) {
    return errorJson(403, "reporting an outcome needs an API key bound to an entity", {
      code: "outcome_unbound",
    });
  }
  const db = engine.db;
  if (!db) return errorJson(503, "no world database", { code: "outcome_unavailable" });
  let body: { requestId?: unknown; succeeded?: unknown; quality?: unknown; detail?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorJson(400, "body must be JSON", { code: "invalid_request_error" });
  }
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) {
    return errorJson(400, "requestId must be the x-request-id Marina returned", {
      code: "invalid_request_error",
    });
  }
  if (typeof body.succeeded !== "boolean") {
    return errorJson(400, "succeeded must be a boolean", { code: "invalid_request_error" });
  }
  const quality = body.quality === undefined ? undefined : Number(body.quality);
  if (quality !== undefined && !(Number.isFinite(quality) && quality >= 0 && quality <= 1)) {
    return errorJson(400, "quality must be a number from 0 to 1", {
      code: "invalid_request_error",
    });
  }
  if (body.detail !== undefined && (typeof body.detail !== "string" || body.detail.length > 200)) {
    return errorJson(400, "detail must be a string of at most 200 characters", {
      code: "invalid_request_error",
    });
  }
  const events = db
    .getTraceEventsByTraceIds([requestId])
    .filter(
      (e): e is Lifecycle => e.type === "model_request_lifecycle" && e.requestId === requestId,
    );
  const ownerId = engine.entities.all().find((e) => e.name === owner)?.id;
  const caller = events.find((e) => e.entityId)?.entityId;
  if (!events.length || !caller || (caller !== owner && caller !== ownerId)) {
    // The same answer whether the request is unknown or someone else's.
    return errorJson(404, "no request with that id was made with this key", {
      code: "outcome_unknown_request",
    });
  }
  const served = [...events].reverse().find((e) => e.target)?.target ?? events[0]!.model;
  const at = Date.now();
  const recorded = recordResolved(db, {
    subject: `request:${requestId}`,
    kind: "request",
    source: "request:reported",
    domain: "tools",
    owner,
    succeeded: body.succeeded,
    quality: quality ?? (body.succeeded ? 1 : 0),
    metric: "caller-report",
    ...(typeof body.detail === "string" && body.detail.trim()
      ? { detail: body.detail.trim() }
      : {}),
    basis: "mechanical",
    ...(evalOption(req).eval?.mode === "measure" ? { evalMode: "measure" as const } : {}),
    participants: [{ model: served }],
    refs: [`trace:${requestId}`],
    resolvedAt: at,
  });
  if (!recorded.created) {
    return errorJson(409, "an outcome was already reported for this request", {
      code: "outcome_already_reported",
    });
  }
  return json({ outcomeId: recorded.id, subject: `request:${requestId}`, model: served });
}
