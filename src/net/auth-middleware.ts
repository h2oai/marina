import type { Engine } from "../engine/engine";
import type { EntityId } from "../types";
import { corsHeaders } from "./cors";

/**
 * Validate a Bearer session token from the Authorization header.
 *
 * Returns `{ entityId }` on success, or `{ error: Response }` on failure.
 */
export function authenticateRequest(
  req: Request,
  engine: Engine,
): { entityId: EntityId } | { error: Response } {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    const origin = req.headers.get("Origin");
    return {
      error: Response.json(
        { error: "Missing or invalid Authorization header" },
        { status: 401, headers: corsHeaders(origin) },
      ),
    };
  }

  const token = auth.slice(7);
  const entityId = engine.authenticate(token);
  if (!entityId) {
    const origin = req.headers.get("Origin");
    return {
      error: Response.json(
        { error: "Invalid or expired session token" },
        { status: 401, headers: corsHeaders(origin) },
      ),
    };
  }

  return { entityId };
}
