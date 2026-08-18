// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── SSRF Protection ─────────────────────────────────────────────────────────
//
// Blocks fetch() requests to private/internal networks and cloud metadata endpoints.

import { lookup } from "node:dns/promises";

/** Hostnames that must never be accessed from user-initiated requests. */
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata.goog"]);

/** True if `hostname` is already a literal IP (v4 or v6) — no DNS needed. */
function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.includes(":");
}

/**
 * Check if an IP address belongs to a private, loopback, or link-local range.
 *
 * Covers: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *         169.254.0.0/16 (link-local / cloud metadata), 0.0.0.0,
 *         ::1, ::, fe80::/10, fc00::/7, and IPv4-mapped IPv6 (::ffff:x.x.x.x).
 */
function isPrivateIp(hostname: string): boolean {
  // IPv4
  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b] = v4.map(Number);
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local + cloud metadata)
    if (a === 0) return true; // 0.0.0.0/8
    return false;
  }

  // IPv6
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local (fc00::/7)

  // IPv4-mapped IPv6 — dotted form: ::ffff:10.0.0.1
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIp(mapped[1]!);

  // IPv4-mapped IPv6 — hex form (URL parser normalizes to this): ::ffff:a00:1
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1]!, 16);
    const lo = Number.parseInt(hexMapped[2]!, 16);
    // Each hex group is bounded by the regex to 0–0xffff, and the bit-masks
    // below clamp each reconstructed byte to 0–255. Belt-and-braces: if the
    // regex is ever loosened in the future without updating the math here,
    // fail closed (treat as private) rather than silently letting through.
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi > 0xffff || lo > 0xffff) {
      return true;
    }
    const ip = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIp(ip);
  }

  return false;
}

/**
 * Synchronous SSRF check: protocol allowlist, blocked hostnames, and literal
 * private-IP ranges. Returns an error string if blocked, or `null`.
 *
 * Use this at *registration* time (e.g. storing a connector URL) where a cheap
 * literal check is enough. Use the async {@link validateFetchUrl} at *fetch*
 * time, which additionally resolves DNS to defend against rebinding.
 */
export function validateFetchUrlSync(urlStr: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return "Invalid URL";
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Blocked protocol: ${parsed.protocol}`;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known internal hostnames
  if (BLOCKED_HOSTS.has(hostname)) {
    return `Blocked host: ${hostname}`;
  }

  // Literal IPs: check directly.
  if (isPrivateIp(hostname)) {
    return `Blocked private/internal IP: ${hostname}`;
  }

  return null;
}

/**
 * Validate a URL for SSRF safety at fetch time. Returns an error string if the
 * URL is blocked, or `null` if it's safe to fetch.
 *
 * Runs the synchronous checks, then for non-literal hostnames resolves DNS and
 * re-checks every resolved address against the private-range list — otherwise a
 * public-looking hostname that resolves to 127.0.0.1 / 169.254.169.254
 * (DNS-rebinding SSRF) would slip past a string-only check.
 */
export async function validateFetchUrl(urlStr: string): Promise<string | null> {
  const syncError = validateFetchUrlSync(urlStr);
  if (syncError) return syncError;

  // Re-parse (already validated as parseable by the sync pass).
  const hostname = new URL(urlStr).hostname.toLowerCase();

  // Named hosts: resolve and re-check every resolved address (anti-rebinding).
  if (!isIpLiteral(hostname)) {
    let addresses: { address: string }[];
    try {
      addresses = await lookup(hostname, { all: true });
    } catch {
      // Fail OPEN on resolution failure: a host we can't resolve can't reach a
      // private resource (the fetch itself will fail), and failing closed would
      // break legitimate fetches in restricted-DNS environments. The real
      // protection is the resolve→private→block path below. (Residual limit:
      // this does not defend against TOCTOU re-binding between check and the
      // actual fetch — that needs connect-time IP pinning, a larger change.)
      return null;
    }
    for (const { address } of addresses) {
      if (isPrivateIp(address.toLowerCase())) {
        return `Blocked host ${hostname} — resolves to private/internal IP: ${address}`;
      }
    }
  }

  return null;
}

/**
 * SSRF-safe `fetch`. Validates the initial URL, then fetches with
 * `redirect: "manual"` and re-validates every redirect hop before following —
 * closing the bypass where a public host returns `302 Location:
 * http://169.254.169.254/...` and the default `redirect: "follow"` would walk
 * straight to a private/metadata target with no re-check.
 *
 * Throws on a blocked URL (initial or any hop), an uninspectable redirect, or
 * exceeding `maxHops` (default 5). Otherwise returns the final `Response`.
 * Callers that already pre-validate keep their clean initial-URL error; the
 * thrown SSRF error surfaces through their existing fetch try/catch.
 */
export async function guardedFetch(
  urlStr: string,
  init?: RequestInit,
  opts?: { maxHops?: number },
): Promise<Response> {
  const maxHops = opts?.maxHops ?? 5;
  let currentUrl = urlStr;
  let method = (init?.method ?? "GET").toString().toUpperCase();
  let body = init?.body;

  for (let hop = 0; ; hop++) {
    const err = await validateFetchUrl(currentUrl);
    if (err) throw new Error(`SSRF blocked: ${err}`);

    const resp = await fetch(currentUrl, { ...init, method, body, redirect: "manual" });

    // A real (non-3xx) response — including the opaque case we can't inspect —
    // is handled here. Server-side Bun returns readable 3xx under
    // redirect:"manual"; if it ever yields an opaque redirect we cannot
    // re-validate the target, so fail closed.
    if (resp.type === "opaqueredirect") {
      throw new Error("SSRF blocked: redirect target not inspectable");
    }
    if (resp.status < 300 || resp.status >= 400) return resp;

    if (hop >= maxHops) throw new Error(`SSRF blocked: too many redirects (>${maxHops})`);
    const location = resp.headers.get("location");
    if (!location) return resp; // 3xx without Location — nothing to follow

    try {
      currentUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new Error(`SSRF blocked: invalid redirect target: ${location}`);
    }
    // Match fetch redirect semantics: 301/302/303 drop to GET with no body;
    // 307/308 preserve method and body.
    if (resp.status === 301 || resp.status === 302 || resp.status === 303) {
      method = "GET";
      body = undefined;
    }
  }
}
