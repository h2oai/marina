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
 * DNS resolver seam. Resolves a hostname to the list of A/AAAA addresses. Split
 * out so the connection-pinning path can (a) reuse a single resolution across
 * validate→connect (closing the DNS-rebinding TOCTOU) and (b) be stubbed in
 * tests without real DNS. Overridable via {@link __setDnsResolverForTest}.
 */
export type DnsResolver = (hostname: string) => Promise<string[]>;

const defaultDnsResolver: DnsResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true });
  return addresses.map((a) => a.address);
};

let dnsResolver: DnsResolver = defaultDnsResolver;

/**
 * Test-only seam to stub DNS resolution. Pass `null` to restore the real
 * resolver. Lets a test simulate DNS rebinding (a second resolve returning a
 * private IP) to prove the connection uses the first-validated pinned address.
 */
export function __setDnsResolverForTest(resolver: DnsResolver | null): void {
  dnsResolver = resolver ?? defaultDnsResolver;
}

/**
 * Check if an IP address belongs to a private, loopback, or link-local range.
 *
 * Covers: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *         192.0.0.0/24 (IANA special — Oracle Cloud metadata 192.0.0.192),
 *         169.254.0.0/16 (link-local — AWS/GCP/Azure metadata 169.254.169.254),
 *         100.64.0.0/10 (CGNAT/shared — Alibaba Cloud metadata 100.100.100.200),
 *         0.0.0.0, ::1, ::, fe80::/10, fc00::/7, and IPv4-mapped IPv6
 *         (::ffff:x.x.x.x). Because IPv4-mapped and tunnel-wrapped (NAT64 / 6to4 /
 *         Teredo) forms decode their embedded v4 and re-check it here, every range
 *         above is also caught in its IPv6-wrapped form.
 */
function isPrivateIp(hostname: string): boolean {
  // IPv4
  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b, c] = v4.map(Number);
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (Oracle Cloud metadata 192.0.0.192)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local + AWS/GCP/Azure metadata)
    if (a === 100 && b! >= 64 && b! <= 127) return true; // 100.64.0.0/10 CGNAT (Alibaba metadata 100.100.100.200)
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

  // Transition/tunnel wrappers that embed an IPv4 address (NAT64, 6to4, Teredo).
  // A public-looking IPv6 literal can carry a private/loopback/metadata v4 inside
  // it; decode the embedded address and re-check it against the v4 ranges.
  const groups = parseIpv6Groups(lower);
  if (groups) {
    for (const embedded of embeddedV4Candidates(groups)) {
      if (isPrivateIp(embedded)) return true;
    }
  }

  return false;
}

/**
 * Expand an IPv6 literal (possibly `::`-compressed, possibly with a trailing
 * dotted-quad) into its 8 16-bit groups. Returns `null` if the string is not a
 * well-formed IPv6 address. Used to decode IPv4 addresses embedded in tunnel
 * wrappers (NAT64/6to4/Teredo).
 */
function parseIpv6Groups(addr: string): number[] | null {
  let s = addr.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone); // strip scope id
  if (!s.includes(":")) return null;

  // Fold a trailing dotted-quad (e.g. 64:ff9b::1.2.3.4) into two hex groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  const v4 = tail.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const b = v4.slice(1).map(Number);
    if (b.some((n) => n > 255)) return null;
    const hi = ((b[0]! << 8) | b[1]!).toString(16);
    const lo = ((b[2]! << 8) | b[3]!).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  const head = toGroups(halves[0]!);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const back = toGroups(halves[1]!);
  if (!back) return null;
  const missing = 8 - head.length - back.length;
  if (missing < 1) return null; // "::" must stand for at least one zero group
  return [...head, ...Array<number>(missing).fill(0), ...back];
}

/**
 * Given the 8 groups of an IPv6 address, return any IPv4 addresses embedded via
 * a transition/tunnel wrapper, so they can be re-checked against the v4 ranges:
 *   - NAT64  `64:ff9b::/96` and `64:ff9b:1::/48` — v4 in the low 32 bits.
 *   - 6to4   `2002::/16`                          — v4 in bits 16–48.
 *   - Teredo `2001:0000::/32` — server v4 (bits 32–64) and the obfuscated client
 *            v4 (low 32 bits, XOR 0xffffffff).
 */
function embeddedV4Candidates(g: number[]): string[] {
  const dotted = (hi: number, lo: number) =>
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  const out: string[] = [];

  // NAT64 well-known prefix 64:ff9b::/96 (global) and 64:ff9b:1::/48 (local).
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    out.push(dotted(g[6]!, g[7]!));
  }

  // 6to4: 2002:AABB:CCDD::/48 embeds the v4 AA.BB.CC.DD in groups 1 and 2.
  if (g[0] === 0x2002) {
    out.push(dotted(g[1]!, g[2]!));
  }

  // Teredo: 2001:0000:<server>:<flags>:<port>:<obfuscated client>.
  if (g[0] === 0x2001 && g[1] === 0x0000) {
    out.push(dotted(g[2]!, g[3]!)); // Teredo server v4
    out.push(dotted((~g[6]! & 0xffff) >>> 0, (~g[7]! & 0xffff) >>> 0)); // client v4 (XOR ffff)
  }

  return out;
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
  const result = await checkAndResolve(urlStr);
  return "error" in result ? result.error : null;
}

/**
 * Shared validate-and-resolve step. Runs the sync checks, then for named hosts
 * resolves DNS (via the {@link dnsResolver} seam) and rejects if *any* resolved
 * address is private. On success it returns the validated address set so the
 * caller can pin the connection to one of them — the resolution is done exactly
 * once, closing the TOCTOU window where `fetch()` would otherwise re-resolve and
 * a rebinding host could serve a private IP after passing the check.
 *
 * `addresses` is empty for IP-literal hosts (nothing to pin) and for the
 * fail-open resolution-failure case.
 */
async function checkAndResolve(
  urlStr: string,
): Promise<{ error: string } | { addresses: string[] }> {
  const syncError = validateFetchUrlSync(urlStr);
  if (syncError) return { error: syncError };

  // Re-parse (already validated as parseable by the sync pass).
  const hostname = new URL(urlStr).hostname.toLowerCase();

  // IP literals were already range-checked by the sync pass; nothing to pin.
  if (isIpLiteral(hostname)) return { addresses: [] };

  let addresses: string[];
  try {
    addresses = await dnsResolver(hostname);
  } catch {
    // Fail OPEN on resolution failure: a host we can't resolve can't reach a
    // private resource (the fetch itself will fail), and failing closed would
    // break legitimate fetches in restricted-DNS environments.
    return { addresses: [] };
  }
  for (const address of addresses) {
    if (isPrivateIp(address.toLowerCase())) {
      return { error: `Blocked host ${hostname} — resolves to private/internal IP: ${address}` };
    }
  }
  return { addresses };
}

type FetchInitWithTls = RequestInit & { tls?: { serverName?: string } };

/**
 * Fetch pinned to a pre-validated IP. Rewrites the URL host to the literal IP so
 * the connection targets exactly the address we validated (a rebinding second
 * resolve can't swap in a private one), while preserving routing/TLS identity:
 * the original hostname is carried in the `Host` header and, for https, in the
 * TLS `serverName` (SNI) so certificate validation still matches the hostname
 * rather than the IP literal. IP-literal / fail-open hosts (empty address list)
 * fetch unchanged.
 */
async function pinnedFetch(
  urlStr: string,
  validatedAddresses: string[],
  init: RequestInit,
): Promise<Response> {
  if (validatedAddresses.length === 0) return fetch(urlStr, init);

  const url = new URL(urlStr);
  const originalHost = url.host; // hostname[:port] — preserved for virtual-host routing
  const originalHostname = url.hostname;
  const pinned = validatedAddresses[0]!; // every address was validated non-private

  url.hostname = pinned.includes(":") ? `[${pinned}]` : pinned;

  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", originalHost);

  const fetchInit: FetchInitWithTls = { ...init, headers };
  if (url.protocol === "https:") {
    fetchInit.tls = { serverName: originalHostname };
  }
  return fetch(url.toString(), fetchInit);
}

/**
 * SSRF-safe `fetch`. For every hop it resolves the host once, rejects if any
 * resolved address is private, then *pins the connection to that validated IP*
 * (rewriting the URL host to the IP literal while preserving the `Host` header
 * and TLS SNI) — closing the DNS-rebinding TOCTOU where a bare `fetch()` would
 * re-resolve at connect time and a rebinding host could serve a private IP after
 * passing the check. It also fetches with `redirect: "manual"` and re-validates
 * (and re-pins) every redirect hop before following — closing the bypass where a
 * public host returns `302 Location: http://169.254.169.254/...` and the default
 * `redirect: "follow"` would walk straight to a private/metadata target.
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
    // Resolve + validate once per hop, then pin the connection to the validated
    // IP so a DNS rebind can't swap in a private address between check and
    // connect. Every redirect target is re-resolved and re-pinned the same way.
    const check = await checkAndResolve(currentUrl);
    if ("error" in check) throw new Error(`SSRF blocked: ${check.error}`);

    const resp = await pinnedFetch(currentUrl, check.addresses, {
      ...init,
      method,
      body,
      redirect: "manual",
    });

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
