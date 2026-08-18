// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Shared CORS utility ─────────────────────────────────────────────────────
//
// When ALLOWED_ORIGINS is set (comma-separated), only those origins get an
// Access-Control-Allow-Origin header.  When unset, NO ACAO header is emitted —
// same-origin requests work fine, cross-origin requests are blocked.

function getAllowedOrigins(): Set<string> | null {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return null;
  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return origins.length > 0 ? new Set(origins) : null;
}

/**
 * Build CORS headers for a response.
 *
 * @param requestOrigin  The `Origin` header from the incoming request (may be null).
 * @param extra          Additional headers to merge (e.g. Authorization in Allow-Headers).
 */
export function corsHeaders(
  requestOrigin: string | null,
  extra?: { methods?: string; headers?: string; expose?: string },
): Record<string, string> {
  const result: Record<string, string> = {
    "Access-Control-Allow-Methods": extra?.methods ?? "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": extra?.headers ?? "Content-Type, Authorization",
  };

  if (extra?.expose) {
    result["Access-Control-Expose-Headers"] = extra.expose;
  }

  const allowed = getAllowedOrigins();
  if (allowed && requestOrigin && allowed.has(requestOrigin)) {
    result["Access-Control-Allow-Origin"] = requestOrigin;
    result.Vary = "Origin";
  }

  return result;
}
