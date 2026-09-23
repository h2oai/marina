// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Shared HTTP hardening helpers ───────────────────────────────────────────
//
// One place for the cross-cutting pieces every HTTP surface in src/net needs:
// the real client IP (socket peer unless a trusted proxy is declared), a safe
// JSON-body reader, response security headers, and the named per-surface rate
// limiters. Keeping them here means the asset, canvas, dashboard, entity and
// MCP handlers apply ONE rule each instead of five slightly different ones.

import { createHash } from "node:crypto";
import { RateLimiter, type RateLimiterConfig } from "../auth/rate-limiter";
import { corsHeaders } from "./cors";

// ─── Client IP ───────────────────────────────────────────────────────────────

/** Anything with Bun's `server.requestIP` shape (kept structural for tests). */
export type PeerAddressSource = { requestIP?: (req: Request) => { address: string } | null };

/** Result when no peer address is resolvable (direct handler calls in tests). */
export const UNKNOWN_CLIENT_IP = "unknown";

/**
 * Resolve the client IP for rate-limiting and audit keys.
 *
 * Forwarding headers (`X-Forwarded-For`, `X-Real-IP`) are honored ONLY when
 * `MARINA_TRUST_PROXY=true` — otherwise a direct caller could spoof them to land
 * in a fresh rate-limit bucket. Without a trusted proxy the real TCP peer is
 * used. `peer` may be the Bun server (uses `requestIP`) or an already-resolved
 * socket address string.
 *
 * Never use this value as a TRUST anchor (loopback checks); those must read the
 * socket peer directly (`server.requestIP`) — see `canvas-principal.ts`.
 */
export function clientIp(req: Request, peer?: PeerAddressSource | string | null): string {
  if (process.env.MARINA_TRUST_PROXY === "true") {
    const fwd = req.headers.get("x-forwarded-for");
    const hdr = (fwd ? fwd.split(",")[0]!.trim() : null) ?? req.headers.get("x-real-ip");
    if (hdr) return hdr;
  }
  if (typeof peer === "string") return peer || UNKNOWN_CLIENT_IP;
  return peer?.requestIP?.(req)?.address ?? UNKNOWN_CLIENT_IP;
}

// ─── JSON body ───────────────────────────────────────────────────────────────

export type JsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

/**
 * Read a JSON object body without letting a malformed payload propagate as an
 * unhandled rejection into `Bun.serve`. Returns a 400 response on parse failure
 * or a non-object body. Size is bounded by `Bun.serve({ maxRequestBodySize })`.
 */
export async function readJsonBody(
  req: Request,
  origin: string | null = req.headers.get("Origin"),
): Promise<JsonBodyResult> {
  const fail = (message: string): JsonBodyResult => ({
    ok: false,
    response: Response.json({ error: message }, { status: 400, headers: corsHeaders(origin) }),
  });
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail("Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("Expected JSON object body");
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

// ─── Request body limits ─────────────────────────────────────────────────────

/** Default `Bun.serve({ maxRequestBodySize })` — Bun's own default is 128 MiB. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
/** Default cap for a single asset upload (multipart or raw). */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** `MARINA_MAX_REQUEST_BODY_BYTES` (default 8 MiB). */
export function maxRequestBodyBytes(): number {
  return positiveIntEnv("MARINA_MAX_REQUEST_BODY_BYTES", DEFAULT_MAX_REQUEST_BODY_BYTES);
}

/** `MARINA_MAX_UPLOAD_BYTES` (default 50 MiB) — the asset upload cap. */
export function maxUploadBytes(): number {
  return positiveIntEnv("MARINA_MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES);
}

/**
 * The effective `Bun.serve` body ceiling: the server-wide limit is a single
 * number, so it must admit the (larger) asset upload cap; JSON routes are
 * further bounded by their own handlers and the upload route enforces
 * `maxUploadBytes()` itself.
 */
export function serverMaxRequestBodyBytes(): number {
  return Math.max(maxRequestBodyBytes(), maxUploadBytes());
}

// ─── Security headers ────────────────────────────────────────────────────────

/**
 * CSP for HTML documents (dashboard SPA, /who pages, web chat, ask page, the
 * "not built" placeholder). The built dashboard (`dist/dashboard/index.html`)
 * loads exactly one external module script and no inline scripts, so
 * `script-src 'self'` is enforceable. Every source outside `'self'` below is a
 * grant the dashboard code genuinely needs:
 *
 * - `style-src 'unsafe-inline'`      — inline `style=` attributes from motion /
 *   react-flow / react-grid-layout and the `<style>` block in the placeholder,
 *   webchat and ask pages. (Style hashes cannot cover attributes.)
 * - `https://fonts.googleapis.com`   — `dashboard/index.html` `<link rel=stylesheet>`
 *   (Orbitron, Share Tech Mono) and `dashboard/src/unified/unified-canvas.css`
 *   `@import` (VT323, Orbitron, Press Start 2P); the fonts themselves come from
 *   `https://fonts.gstatic.com` (`font-src`).
 * - `script-src https://cdnjs.cloudflare.com/ajax/libs/pdf.js/` — path-scoped:
 *   `dashboard/src/canvas/nodes/PdfNode.tsx` points `GlobalWorkerOptions.workerSrc`
 *   at the pdf.js CDN; pdf.js wraps a cross-origin worker in a `blob:` worker
 *   that `import()`s that URL (hence `worker-src blob:`), and its main-thread
 *   "fake worker" fallback `import()`s it too. Self-hosting the worker would
 *   remove this grant.
 * - `frame-src https:`               — the `embed` canvas node / asset kind
 *   (`CanvasNodeEmbed.tsx`, `AssetLightbox.tsx`) embeds an operator-supplied
 *   URL in a sandboxed iframe; `'self'` covers the in-app PDF viewer iframes.
 * - `img-src` / `media-src` `blob: data:` — object URLs for previews and the
 *   inline SVG data URI in `index.css`; stored assets are same-origin
 *   (`/assets/*`). A storage provider that serves assets from another origin
 *   must extend `img-src`/`media-src` via `MARINA_DASHBOARD_CSP`.
 * - `connect-src ws: wss:`           — the `/ws`, `/dashboard-ws` and
 *   `/canvas-ws` sockets (spelled out for engines that don't treat `'self'`
 *   as covering WebSocket schemes).
 *
 * `/chat` and `/ask` carry inline scripts; those routes append their
 * `'sha256-…'` hashes to `script-src` (see `inlineScriptHashes`) instead of
 * loosening the policy for every page.
 *
 * Override / disable with `MARINA_DASHBOARD_CSP`: `off` drops the header,
 * any other non-empty value is sent verbatim on every HTML route (inline-script
 * hashes are NOT appended to a custom policy — include them, or
 * `'unsafe-inline'`, yourself if you keep `/chat` and `/ask` reachable).
 */
export const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/pdf.js/",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self' https:",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** `MARINA_DASHBOARD_CSP` — `off` disables the HTML CSP; any other value replaces it. */
export const DASHBOARD_CSP_ENV = "MARINA_DASHBOARD_CSP";

/**
 * The effective HTML CSP, or `null` when disabled. `inlineScriptHashes` are
 * appended to the default policy's `script-src` (for the two static pages that
 * carry inline scripts); a custom operator policy is returned verbatim.
 */
export function htmlCsp(opts: { inlineScriptHashes?: readonly string[] } = {}): string | null {
  const override = process.env[DASHBOARD_CSP_ENV]?.trim();
  if (override) {
    if (override.toLowerCase() === "off") return null;
    return override;
  }
  const hashes = opts.inlineScriptHashes ?? [];
  if (hashes.length === 0) return HTML_CSP;
  const sources = hashes.map((h) => `'sha256-${h}'`).join(" ");
  return HTML_CSP.replace(/(^|; )script-src ([^;]*)/, (_m, lead, rest) => {
    return `${lead}script-src ${rest} ${sources}`;
  });
}

const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * Base64 SHA-256 digests of every inline `<script>` body in `html`, in
 * document order, for `'sha256-…'` CSP source expressions. Scripts with a `src`
 * attribute are external and skipped. The digest covers the exact bytes between
 * the tags (whitespace included) — that is what the browser hashes too.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const m of html.matchAll(INLINE_SCRIPT_RE)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (body.length === 0) continue;
    hashes.push(createHash("sha256").update(body, "utf8").digest("base64"));
  }
  return hashes;
}

/** CSP for user-uploaded assets: no script, no loads, opaque origin when navigated to. */
export const ASSET_CSP = "default-src 'none'; sandbox";

/**
 * CSP for PDFs: the dashboard renders them inline in an iframe and some browser
 * PDF viewers refuse to render inside a `sandbox`ed document, so the sandbox
 * directive is dropped; `default-src 'none'` still forbids any fetch.
 */
export const PDF_CSP = "default-src 'none'";

export type SecurityHeaderKind = "html" | "static" | "asset" | "api";

export interface SecurityHeaderOptions {
  /** `html` only: `'sha256-…'` grants for inline scripts on this document. */
  inlineScriptHashes?: readonly string[];
}

/**
 * Standard hardening headers per response kind. Merge into your own headers.
 * The `html` CSP honors `MARINA_DASHBOARD_CSP` (`off` omits the header).
 */
export function securityHeaders(
  kind: SecurityHeaderKind,
  opts: SecurityHeaderOptions = {},
): Record<string, string> {
  const base: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
  switch (kind) {
    case "html": {
      const headers: Record<string, string> = {
        ...base,
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Frame-Options": "SAMEORIGIN",
      };
      const csp = htmlCsp({ inlineScriptHashes: opts.inlineScriptHashes });
      if (csp) headers["Content-Security-Policy"] = csp;
      return headers;
    }
    case "static":
      return { ...base, "Referrer-Policy": "strict-origin-when-cross-origin" };
    case "asset":
      return {
        ...base,
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": ASSET_CSP,
      };
    case "api":
      return base;
  }
}

/** Set the hardening headers for `kind` on an existing (mutable) response. */
export function withSecurityHeaders(
  resp: Response,
  kind: SecurityHeaderKind,
  opts: SecurityHeaderOptions = {},
): Response {
  for (const [k, v] of Object.entries(securityHeaders(kind, opts))) resp.headers.set(k, v);
  return resp;
}

// ─── Named rate limiters ─────────────────────────────────────────────────────

/**
 * Per-surface limits. Each is a token bucket that fully refills every
 * `refillInterval`, so `maxTokens` per interval is the sustained rate.
 */
export const HTTP_RATE_LIMITS = {
  /** Authenticated dashboard REST, per principal: 60 requests / 10 s. */
  dashboard: { maxTokens: 60, refillRate: 60, refillInterval: 10_000 },
  /** Canvas + asset mutations, per principal: 30 / 10 s. */
  mutation: { maxTokens: 30, refillRate: 30, refillInterval: 10_000 },
  /** Public unauthenticated reads (`/api/entity/*`), per IP: 30 / 10 s. */
  publicRead: { maxTokens: 30, refillRate: 30, refillInterval: 10_000 },
  /** MCP session creation + login/auth tool calls, per IP: 10 / min. */
  mcpSession: { maxTokens: 10, refillRate: 10, refillInterval: 60_000 },
} as const satisfies Record<string, RateLimiterConfig>;

export type HttpRateLimitName = keyof typeof HTTP_RATE_LIMITS;

/**
 * `MARINA_MCP_SESSIONS_PER_MIN` — sibling of `MARINA_LOGIN_ATTEMPTS_PER_MIN`;
 * `0` disables the MCP session/login throttle. Other limits are fixed constants.
 */
export function mcpSessionsPerMinute(): number {
  const raw = process.env.MARINA_MCP_SESSIONS_PER_MIN;
  if (raw === undefined || raw === "") return HTTP_RATE_LIMITS.mcpSession.maxTokens;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : HTTP_RATE_LIMITS.mcpSession.maxTokens;
}

const limiters = new Map<HttpRateLimitName, RateLimiter>();

/** Lazily constructed process-wide limiter for a named surface. */
export function httpRateLimiter(name: HttpRateLimitName): RateLimiter {
  let limiter = limiters.get(name);
  if (!limiter) {
    let config: RateLimiterConfig = HTTP_RATE_LIMITS[name];
    if (name === "mcpSession") {
      const perMin = mcpSessionsPerMinute();
      config = { ...config, maxTokens: perMin, refillRate: perMin };
    }
    limiter = new RateLimiter(config);
    limiters.set(name, limiter);
  }
  return limiter;
}

/**
 * Consume one token for `key` on the named surface. Returns `true` when the
 * request may proceed. A `0`-token MCP throttle (`MARINA_MCP_SESSIONS_PER_MIN=0`)
 * is treated as disabled.
 */
export function consumeHttpRate(name: HttpRateLimitName, key: string): boolean {
  if (name === "mcpSession" && mcpSessionsPerMinute() === 0) return true;
  return httpRateLimiter(name).consume(`${name}:${key}`);
}

/** Drop every bucket (tests). */
export function resetHttpRateLimitersForTests(): void {
  limiters.clear();
}

/** Standard 429 body shared by every HTTP surface. */
export function rateLimitedResponse(
  origin: string | null,
  retryAfterSeconds = 10,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(
    { error: "Rate limited. Please slow down." },
    {
      status: 429,
      headers: {
        ...corsHeaders(origin),
        "Retry-After": String(retryAfterSeconds),
        ...extraHeaders,
      },
    },
  );
}
