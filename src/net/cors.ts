// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Shared CORS utility ─────────────────────────────────────────────────────
//
// When ALLOWED_ORIGINS is set (comma-separated), only those origins get an
// Access-Control-Allow-Origin header.  When unset, NO ACAO header is emitted —
// same-origin requests work fine, cross-origin requests are blocked.

import { type HostPolicy, hostHeaderAllowed } from "./host-allowlist";
import { isLoopbackHostname } from "./loopback";

export function getAllowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const raw = env.ALLOWED_ORIGINS;
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

// ─── Browser-origin trust (WebSocket upgrades + pre-auth POSTs) ─────────────
//
// A browser attaches `Origin` to every WebSocket handshake and cross-site POST,
// and it cannot be forged by page script. Non-browser clients (SDKs, curl, the
// CLI) usually send none. The rule below is shared by the `/ws`, `/dashboard-ws`
// and `/canvas-ws` upgrade paths and by the pre-auth `/api/command` / `/api/ask`
// ingress so a web page cannot drive a loopback (sovereign under the `local`
// profile) principal from another site.

export interface BrowserOriginOptions {
  /**
   * True when the server listens on loopback only. A loopback origin on ANY port
   * (the dashboard dev server on 5173, a local tool) is then trusted — only the
   * operator's own machine can reach the listener anyway.
   */
  loopbackBind?: boolean;
  /** Override the `ALLOWED_ORIGINS` set (tests); `undefined` reads the env. */
  allowedOrigins?: Set<string> | null;
  /**
   * The listener's `Host` policy (`mainListenerHostPolicy`). The same-origin
   * branch counts only when the request's `Host` passes it. `undefined` uses a
   * loopback-names-only policy on a loopback bind and none otherwise; `null`
   * means the listener does not validate `Host`.
   */
  hostPolicy?: HostPolicy | null;
}

/**
 * Decide whether a browser-supplied `Origin` may drive a credentialed or
 * state-changing request (a WebSocket upgrade, a pre-auth POST).
 *
 *   - no `Origin` header → allowed (non-browser client; the request carries no
 *     ambient browser credentials to abuse)
 *   - `Origin` host equals the request `Host` header AND that `Host` passes the
 *     listener's Host policy → same-origin, allowed
 *   - `Origin` listed in `ALLOWED_ORIGINS` → allowed
 *   - `Origin` is loopback (`http(s)://localhost|127.x|[::1][:port]`) AND
 *     `loopbackBind` → allowed
 *   - anything else (including the opaque `null` origin) → refused
 */
export function isTrustedBrowserOrigin(
  origin: string | null | undefined,
  hostHeader: string | null | undefined,
  opts: BrowserOriginOptions = {},
): boolean {
  if (origin === null || origin === undefined) return true;
  const trimmed = origin.trim();
  if (!trimmed || trimmed === "null") return false;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  // Same-origin: compare host[:port] (URL.host omits a default port, as does a
  // browser's Host header for default ports).
  // A Host header is whatever name the browser used, so it only vouches for
  // the origin when the listener answers to that name.
  const hostPolicy =
    opts.hostPolicy !== undefined ? opts.hostPolicy : opts.loopbackBind ? { allowed: [] } : null;
  const host = (hostHeader ?? "").trim().toLowerCase();
  if (host && parsed.host.toLowerCase() === host && hostHeaderAllowed(host, hostPolicy)) {
    return true;
  }

  const allowed = opts.allowedOrigins === undefined ? getAllowedOrigins() : opts.allowedOrigins;
  if (allowed?.has(parsed.origin) || allowed?.has(trimmed)) return true;

  if (opts.loopbackBind && isLoopbackHostname(parsed.hostname)) return true;

  return false;
}
