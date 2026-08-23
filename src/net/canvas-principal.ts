// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared canvas-authorization principal resolution.
 *
 * Both the canvas WebSocket subscription gate and the canvas HTTP read path must
 * apply the SAME owner/operator scoping to per-entity private workspaces
 * (`scope === "entity"`). This module is the single source of that rule so the
 * two surfaces cannot drift: a canvas readable over WS is readable over HTTP and
 * vice-versa, and a private one is closed on both.
 */

import type { Engine } from "../engine/engine";
import { getRank } from "../engine/permissions";
import { checkUnattendedGate } from "../engine/safety-gates";
import type { MarinaDB } from "../persistence/database";
import type { EntityId } from "../types";
import {
  authenticateRequest,
  DESKTOP_OPERATOR_ENTITY_ID,
  OPEN_API_ENTITY_ID,
} from "./auth-middleware";
import type { CanvasSubscriptionPrincipal } from "./canvas-ws";

/**
 * Sentinel principal for a genuine loopback peer (zero-config desktop reader on
 * 127.0.0.1). It is NOT a real entity and NOT a provisioned token — it means
 * "unauthenticated but demonstrably local", which we trust as operator-equivalent
 * for the local desktop owner.
 */
export const LOOPBACK_PRINCIPAL = "loopback-anon";

/**
 * True when a REAL socket peer address (from `server.requestIP`, never headers)
 * is loopback. Undefined fails closed (untrusted). Handles IPv4, IPv6 loopback,
 * and IPv4-mapped IPv6 loopback.
 */
export function isLoopbackPeer(peerIp: string | undefined): boolean {
  if (!peerIp) return false;
  const ip = peerIp.trim().toLowerCase();
  return (
    ip === "::1" ||
    ip === "localhost" ||
    ip.startsWith("127.") ||
    ip === "::ffff:127.0.0.1" ||
    ip.startsWith("::ffff:127.")
  );
}

/**
 * Translate a string principal (resolved at WS upgrade OR from an HTTP request)
 * into the structured {@link CanvasSubscriptionPrincipal} the subscription gate
 * understands.
 *
 *   - {@link LOOPBACK_PRINCIPAL}: genuine local desktop owner → operator (zero-
 *     config desktop keeps seeing its own/local canvases).
 *   - {@link DESKTOP_OPERATOR_ENTITY_ID}: provisioned desktop capability token → operator.
 *   - {@link OPEN_API_ENTITY_ID}: dev-open bypass — reads are already wide open,
 *     so it may observe any canvas (read-scope operator).
 *   - A real EntityId: owner of its own private canvas; operator only when it is
 *     a sovereign admin (rank ≥ 9) or holds the operator gate UNSUPERVISED
 *     (checkUnattendedGate — a standing-only holder is NOT an operator).
 *   - undefined: fully anonymous — private per-entity canvases stay closed.
 */
export function buildCanvasPrincipal(
  principal: string | undefined,
  engine: Engine,
  db: MarinaDB | undefined,
): CanvasSubscriptionPrincipal {
  if (principal === undefined) return {};
  if (
    principal === LOOPBACK_PRINCIPAL ||
    principal === DESKTOP_OPERATOR_ENTITY_ID ||
    principal === OPEN_API_ENTITY_ID
  ) {
    return { isOperator: true };
  }
  const entityId = principal as EntityId;
  const entity = engine.entities.get(entityId);
  const isOperator =
    (!!entity && getRank(entity) >= 9) ||
    // Unattended check: a supervised-only admin.destructive holder is NOT an
    // operator for private-canvas access.
    (!!db && checkUnattendedGate(db, entityId, "admin.destructive").ok);
  return { entityId: principal, isOperator };
}

/**
 * Resolve the string principal for a canvas HTTP request. Mirrors the WS
 * upgrade path ({@link resolveUpgradePrincipal}) but does NOT reject anonymous
 * callers — public/shared canvases stay openly readable over HTTP; the
 * per-entity private scoping is enforced downstream via
 * {@link buildCanvasPrincipal} + `authorizeCanvasSubscription`.
 *
 * Order of strength: valid session token → real EntityId; desktop capability
 * token → operator sentinel; dev-open bypass → open-api sentinel; genuine
 * loopback peer → loopback sentinel; otherwise undefined (anonymous).
 *
 * `peerIp` MUST be the real, unspoofable socket address (`server.requestIP`),
 * never a header value.
 */
export function resolveCanvasHttpPrincipal(
  req: Request,
  engine: Engine,
  peerIp: string | undefined,
): string | undefined {
  const auth = authenticateRequest(req, engine);
  if (!("error" in auth)) return auth.entityId as string;
  // authenticateRequest only errors when there is no valid token / desktop token
  // and dev-open is off. Fall back to the loopback trust anchor for the
  // zero-config local desktop reader; otherwise the caller is anonymous.
  if (isLoopbackPeer(peerIp)) return LOOPBACK_PRINCIPAL;
  return undefined;
}
