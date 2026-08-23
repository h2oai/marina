// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { secretsEqual } from "../auth/secret-compare";
import type { Engine } from "../engine/engine";
import type { EntityId } from "../types";
import { corsHeaders } from "./cors";

/**
 * Sentinel identity returned when the dev-mode open-API bypass is active and
 * no valid session token was presented. It authorizes *reads* only: callers
 * must treat it as an anonymous dev principal, never as an operator (see
 * {@link isOperatorPrincipal}) and never as a specific in-world entity.
 */
export const OPEN_API_ENTITY_ID = "open-api" as EntityId;

/**
 * Sentinel identity returned when a request presents the process-scoped desktop
 * capability token ({@link https} `MARINA_DESKTOP_API_TOKEN`). Unlike the
 * open-API bypass, this is a *deliberately-provisioned* local operator secret
 * (the desktop app mints a random ≥32-char token at boot and only its own
 * requests carry it), so it is treated as a trusted operator — see
 * {@link isOperatorPrincipal}. It is still a sentinel (no in-world entity), so
 * name-scoped reads treat it as "any entity" rather than a specific one.
 */
export const DESKTOP_OPERATOR_ENTITY_ID = "desktop-operator" as EntityId;

/**
 * Whether the principal is a trusted local *operator* credential permitted to
 * perform privileged / destructive operations (key management, env edits,
 * agent spawn, entity deletion).
 *
 * Only the desktop capability token qualifies. Crucially the
 * {@link OPEN_API_ENTITY_ID} dev bypass does NOT: `MARINA_OPEN_API=true` opens
 * *reads* for local development, but must never silently auto-authorize
 * destructive operations — those require a real operator credential, a
 * sovereign-admin rank, or an explicitly-granted safety gate.
 */
export function isOperatorPrincipal(entityId: EntityId): boolean {
  return entityId === DESKTOP_OPERATOR_ENTITY_ID;
}

/** Whether the principal is a sentinel (no backing in-world entity). */
export function isSentinelPrincipal(entityId: EntityId): boolean {
  return entityId === OPEN_API_ENTITY_ID || entityId === DESKTOP_OPERATOR_ENTITY_ID;
}

/** Whether unauthenticated API access is allowed (development mode). */
function openApiEnabled(): boolean {
  return process.env.MARINA_OPEN_API === "true";
}

/**
 * Validate a Bearer session token from the Authorization header.
 *
 * Returns `{ entityId }` on success, or `{ error: Response }` on failure.
 *
 * When `MARINA_OPEN_API=true` (development mode), a missing or invalid token
 * is allowed through with {@link OPEN_API_ENTITY_ID} instead of a 401 — the
 * same relaxation already applied to the model and memory APIs. A *valid*
 * token is always honored and yields its real entity id regardless of the flag.
 */
export function authenticateRequest(
  req: Request,
  engine: Engine,
): { entityId: EntityId } | { error: Response } {
  const auth = req.headers.get("Authorization");
  const desktopToken = req.headers.get("X-Marina-Desktop-Token");
  const expectedDesktopToken = process.env.MARINA_DESKTOP_API_TOKEN;

  if (
    desktopToken &&
    expectedDesktopToken &&
    expectedDesktopToken.length >= 32 &&
    secretsEqual(desktopToken, expectedDesktopToken)
  ) {
    return { entityId: DESKTOP_OPERATOR_ENTITY_ID };
  }

  if (auth?.startsWith("Bearer ")) {
    const entityId = engine.authenticate(auth.slice(7));
    if (entityId) return { entityId };
    // Token present but invalid/expired — fall through to the open-API
    // bypass when enabled, otherwise reject below.
  }

  if (openApiEnabled()) {
    return { entityId: OPEN_API_ENTITY_ID };
  }

  const origin = req.headers.get("Origin");
  return {
    error: Response.json(
      {
        error: auth?.startsWith("Bearer ")
          ? "Invalid or expired session token"
          : "Missing or invalid Authorization header",
      },
      { status: 401, headers: corsHeaders(origin) },
    ),
  };
}
