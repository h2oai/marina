// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Engine } from "../engine/engine";
import type { EntityId } from "../types";
import { corsHeaders } from "./cors";

/**
 * Sentinel identity returned when the dev-mode open-API bypass is active and
 * no valid session token was presented. The dashboard/asset/canvas API gates
 * only use the result as a yes/no gate (they never read `entityId`), so a
 * sentinel is sufficient and avoids inventing a real session.
 */
export const OPEN_API_ENTITY_ID = "open-api" as EntityId;

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
