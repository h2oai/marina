// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Root of the dashboard-api import DAG: shared types, the JSON/CORS response
// helper, request-body readers, the two authorization gates and the small
// parameter/format utilities every route module needs. Nothing in this file
// imports another `./dashboard-api/*` module.

import { join } from "node:path";
import type { Engine } from "../../engine/engine";
import { Logger } from "../../engine/logger";
import { getRank } from "../../engine/permissions";
import {
  checkGateForExecution,
  checkUnattendedGate,
  recordGateExecution,
} from "../../engine/safety-gates";
import type { MarinaDB } from "../../persistence/database";
import { MARINA_ROOT } from "../../runtime-paths";
import type { EntityId } from "../../types";
import { isOperatorPrincipal, isSentinelPrincipal } from "../auth-middleware";
import { corsHeaders, isTrustedBrowserOrigin } from "../cors";
import {
  readJsonBody as readJsonObject,
  SMALL_JSON_BODY_BYTES,
  withErrorCode,
} from "../http-utils";
import type { memoryObserver } from "../memory-visibility";

/** Module logger: dashboard HTTP routes — rejected-origin and request failures. */
const logger = new Logger();

export const ROOMS_DIR = join(MARINA_ROOT, "rooms");
export const PROJECT_ROOT = MARINA_ROOT;

/**
 * JSON response for every dashboard route. An error status gets a string
 * `code` added to its body when the route did not supply one (`withErrorCode`),
 * so each `json({ error }, 4xx)` site honours the error contract.
 */
export function json(data: unknown, status = 200, origin?: string | null): Response {
  // Dashboard API is same-origin — CORS headers only needed for allowed origins
  return Response.json(withErrorCode(data, status), {
    status,
    headers: corsHeaders(origin ?? null),
  });
}

/**
 * Response-level backstop for the error contract: a route that built its own
 * `Response.json({ error }, { status: 4xx })` (bypassing `json`) still leaves
 * with a string `code`. Only JSON error responses are read; everything else
 * passes through untouched.
 */
export async function ensureErrorCode(resp: Response): Promise<Response> {
  if (resp.status < 400) return resp;
  if (!(resp.headers.get("Content-Type") ?? "").includes("application/json")) return resp;
  const text = await resp.clone().text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return resp;
  }
  const coded = withErrorCode(parsed, resp.status);
  if (coded === parsed) return resp;
  const headers = new Headers(resp.headers);
  headers.delete("Content-Length");
  return new Response(JSON.stringify(coded), {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

export interface CommandApiBody {
  command?: unknown;
  query?: unknown;
  name?: unknown;
  token?: unknown;
  render?: unknown;
}

/** Options threaded from the listener that owns the socket (see `handleDashboardApi`). */
export interface DashboardApiOptions {
  /** True when the server binds loopback only — loopback browser origins are then trusted. */
  loopbackBind?: boolean;
}

/**
 * Body reader for the PRE-AUTH command ingress (`/api/command`, `/api/ask`).
 * Two CSRF fences before any JSON is parsed:
 *   1. `Content-Type` must be `application/json` — a cross-site HTML form can
 *      only send `text/plain` / urlencoded / multipart, never JSON, without a
 *      CORS preflight (which the missing ACAO header then denies).
 *   2. A present `Origin` must pass the same trust rule as the WebSocket
 *      upgrade (same-origin, `ALLOWED_ORIGINS`, or loopback on a loopback bind).
 */
export async function readCommandBody(
  req: Request,
  opts: DashboardApiOptions = {},
): Promise<CommandApiBody | { error: Response }> {
  const origin = req.headers.get("Origin");
  const contentType = (req.headers.get("Content-Type") ?? "").trim().toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return {
      error: json({ error: "Content-Type must be application/json" }, 415, origin),
    };
  }
  if (
    !isTrustedBrowserOrigin(origin, req.headers.get("Host"), { loopbackBind: opts.loopbackBind })
  ) {
    logger.warn(
      "dashboard-api",
      `Rejected ${new URL(req.url).pathname} from untrusted origin ${origin}`,
      { path: new URL(req.url).pathname, origin },
    );
    return { error: json({ error: "Forbidden origin" }, 403, origin) };
  }
  const read = await readJsonObject(req, { origin, maxBytes: SMALL_JSON_BODY_BYTES });
  if (!read.ok) return { error: read.response };
  return read.body as CommandApiBody;
}

/**
 * JSON-object body for an authenticated dashboard route — the shared reader
 * (`http-utils.readJsonBody`) with this surface's error shape. `maxBytes`
 * defaults to `MARINA_MAX_REQUEST_BODY_BYTES`; `allowEmpty` reads an empty
 * body as `{}` for routes whose fields are all optional.
 */
export async function readJsonBody<T extends object>(
  req: Request,
  opts: { maxBytes?: number; allowEmpty?: boolean } = {},
): Promise<T | { error: Response }> {
  const read = await readJsonObject(req, { origin: null, ...opts });
  if (!read.ok) return { error: read.response };
  return read.body as T;
}

/** `readJsonBody` for key, env and agent management: small bodies only. */
export function readSmallJsonBody<T extends object>(
  req: Request,
  opts: { allowEmpty?: boolean } = {},
): Promise<T | { error: Response }> {
  return readJsonBody<T>(req, { ...opts, maxBytes: SMALL_JSON_BODY_BYTES });
}

export function bearerToken(req: Request): string | undefined {
  const auth = req.headers.get("Authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
}

/**
 * Authorization gate for privileged dashboard mutations (spawn / stop /
 * reconfigure agents, delete entities, manage keys). The dashboard
 * authenticates the request but historically discarded the identity, so any
 * signed-in user — or, under MARINA_OPEN_API, anyone — could spawn agents,
 * bypassing the `agent.spawn` safety gate the in-world command enforces.
 *
 * Returns null when allowed, or a 403 Response when not. Allowed if: the
 * caller presents the local desktop operator credential, OR the caller is a
 * sovereign admin (rank 9), OR the caller has earned/been-granted the relevant
 * safety gate. Mirrors "admin, or granted to a user".
 *
 * The `MARINA_OPEN_API=true` dev bypass deliberately does NOT satisfy this
 * gate: dev-open may open reads, but destructive/privileged operations
 * (key/env management, agent spawn, entity deletion) must never be reachable
 * without a real operator credential — otherwise a dev instance left exposed
 * would hand out full control to any anonymous caller.
 */
export function authorizePrivileged(
  engine: Engine,
  db: MarinaDB | undefined,
  callerId: EntityId,
  gateId: string,
): Response | null {
  if (isOperatorPrincipal(callerId)) return null; // desktop operator credential
  const entity = engine.entities.get(callerId);
  if (entity && getRank(entity) >= 9) return null; // sovereign admin
  // Posture-aware execution check: self-certification stays closed (a
  // standing-only holder is refused in guarded posture with no window), but
  // the gate authorizes via unsupervised competence, an operator-declared
  // open posture (non-core gates), a live witness window, or earned-posture
  // optimistic supervision — with the competence consequence recorded.
  if (db) {
    const gate = checkGateForExecution(db, callerId, gateId);
    if (gate.ok) {
      recordGateExecution(db, callerId, gateId, gate, `api:${gateId}`);
      return null;
    }
  }
  return json(
    { error: `Not authorized: this action requires an admin or the "${gateId}" capability.` },
    403,
  );
}

/**
 * Read-authorization for name-scoped memory / entity-detail routes. A caller
 * may read another entity's private memory (core memory, notes, note graph)
 * only when it *is* that entity, or holds an operator capability. Without this,
 * any valid session token — including the ephemeral one minted by the pre-auth
 * ingress endpoints — could read every entity's private memory.
 *
 * The `MARINA_OPEN_API` dev bypass is intentionally allowed here: dev-open is
 * an explicit single-user local opt-in where reads are already wide open.
 */
export function authorizeEntityRead(
  engine: Engine,
  db: MarinaDB | undefined,
  callerId: EntityId,
  requestedName: string,
): Response | null {
  // Sentinels: desktop operator (trusted) and the dev-open bypass (reads only)
  // may both read. A non-operator sentinel never reaches privileged *writes*.
  if (isSentinelPrincipal(callerId)) return null;
  const caller = engine.entities.get(callerId);
  if (caller && getRank(caller) >= 9) return null; // sovereign admin
  if (caller && caller.name.toLowerCase() === requestedName.toLowerCase()) return null; // own memory
  // Operator gate — unattended check so a supervised-only holder isn't treated
  // as an operator for cross-entity private-memory reads.
  if (db && checkUnattendedGate(db, callerId, "admin.destructive").ok) return null; // operator gate
  return json({ error: "Not authorized to read another entity's private memory." }, 403);
}

/** Clamp a `?limit=` query param into a sane range (default `dflt`, max 1000). */
export function clampLimit(raw: string | null, dflt: number): number {
  const n = raw ? Number(raw) : dflt;
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), 1000);
}

export function numberOrNull(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export { maskKey } from "../../engine/commands/key";

/** Per-principal memory visibility predicates, resolved once per request. */
export type MemoryObserver = ReturnType<typeof memoryObserver>;

/**
 * Everything a route module needs from the authenticated request. Built once
 * by `handleDashboardApi` after the auth gate and the per-principal rate
 * limiter, then threaded to each route group in dispatch order.
 */
export interface DashboardRouteContext {
  req: Request;
  url: URL;
  method: string;
  engine: Engine;
  db: MarinaDB | undefined;
  peerIp: string | undefined;
  callerId: EntityId;
  memory: MemoryObserver;
}
