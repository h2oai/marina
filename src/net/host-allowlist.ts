// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Listener bind + Host header allowlist ──────────────────────────────────
//
// One leaf module (no engine / listener imports) for what every listener needs
// to know about where it binds and which `Host` names it answers to:
//
//   - `resolveBindHostname` / `loopbackBindFromEnv` — the bind address from
//     WS_HOST / MARINA_HOST / MARINA_PUBLIC (loopback by default).
//   - `transportAuthRequired` — whether `/mcp` requires a bearer.
//   - `allowedHostList` — the exact `Host` list the MCP transport hands to the
//     SDK's DNS-rebinding protection (`MARINA_MCP_ALLOWED_HOSTS`).
//   - `mainListenerHostPolicy` / `hostHeaderAllowed` — the same validation for
//     the main listener's HTTP routes and WebSocket upgrades
//     (`MARINA_ALLOWED_HOSTS`).
//
// A DNS name is never loopback here even when it resolves to 127.0.0.1: its
// owner can repoint it, so only literal loopback names and names the operator
// lists are accepted on a loopback bind.

import { hostname } from "node:os";
import { isLoopbackHostname } from "./loopback";
import { modelApiKeySecrets } from "./model-api/api-keys";

export { modelApiKeySecrets };

/**
 * Resolve the bind hostname from the environment. SECURE-BY-DEFAULT: an unset
 * WS_HOST/MARINA_HOST binds LOOPBACK-ONLY (127.0.0.1) so a fresh desktop node
 * is never silently exposed on all interfaces. Public exposure is a deliberate
 * opt-in:
 *   - WS_HOST=0.0.0.0 (or any explicit non-loopback host), or
 *   - MARINA_PUBLIC=true (binds 0.0.0.0 without naming an interface).
 * An explicit WS_HOST/MARINA_HOST always wins over MARINA_PUBLIC. The value is
 * threaded into `Bun.serve({ hostname })` so the bind is real, and it is the
 * trust anchor behind loopback isolation (the headless-exec identity decision
 * stays per-connection and does not read it).
 */
export function resolveBindHostname(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.WS_HOST ?? env.MARINA_HOST ?? "").trim();
  if (explicit) return explicit;
  if ((env.MARINA_PUBLIC ?? "").trim().toLowerCase() === "true") return "0.0.0.0";
  return "127.0.0.1";
}

/** True when the listeners bind loopback only (see `resolveBindHostname`). */
export function loopbackBindFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return isLoopbackHostname(resolveBindHostname(env));
}

/**
 * Whether `/mcp` requires a bearer at the transport layer. The `local` posture
 * (loopback-only bind, no keys, no external auth) stays unauthenticated so a
 * plain `{"url": "http://localhost:3301/mcp"}` client config keeps working;
 * anything stronger — API keys configured, sign-in enabled, or a non-loopback
 * bind — turns the requirement on.
 */
export function transportAuthRequired(
  loopbackBind: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return modelApiKeySecrets(env).length > 0 || env.MARINA_AUTH === "better-auth" || !loopbackBind;
}

/** Comma-separated host list from an env value, trimmed and lower-cased. */
export function parseHostList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Hostnames Marina can vouch for on a non-loopback bind: the loopback
 * spellings, a specific (non-wildcard) bind address, this machine's hostname,
 * and the hosts of the configured public URLs (`BETTER_AUTH_URL`,
 * `ALLOWED_ORIGINS`).
 */
export function derivedPublicHosts(bindHost: string, env: NodeJS.ProcessEnv): string[] {
  const out = [...LOOPBACK_NAMES];
  const bind = bindHost.trim().toLowerCase();
  if (bind && bind !== "0.0.0.0" && bind !== "::" && bind !== "[::]") {
    out.push(bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind);
  }
  try {
    const name = hostname().trim().toLowerCase();
    if (name) out.push(name);
  } catch {
    // allow-empty-catch: no hostname is simply one fewer allowed name.
  }
  const urls = [env.BETTER_AUTH_URL, ...(env.ALLOWED_ORIGINS ?? "").split(",")];
  for (const raw of urls) {
    const value = raw?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.hostname) out.push(url.hostname.toLowerCase());
    } catch {
      // allow-empty-catch: a malformed origin contributes no host.
    }
  }
  return out;
}

/**
 * Exact `Host` header values a listener accepts. On a loopback bind: every
 * loopback spelling on the live port plus `extra`. On a non-loopback bind: the
 * `extra` list when the operator declared one; otherwise it FAILS CLOSED to
 * `derivedPublicHosts`. A bare name is also listed with the live port because
 * the MCP SDK compares exact strings.
 */
export function allowedHostList(
  bindHost: string,
  port: number,
  loopbackBind: boolean,
  extra: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const hosts = new Set<string>();
  const add = (host: string) => {
    hosts.add(host);
    if (!/:\d+$/.test(host) || /^\[.*\]$/.test(host)) hosts.add(`${host}:${port}`);
  };
  if (loopbackBind) {
    for (const h of LOOPBACK_NAMES) add(h);
    add(bindHost.toLowerCase());
  } else if (extra.length === 0) {
    for (const h of derivedPublicHosts(bindHost, env)) add(h);
  }
  for (const h of extra) add(h);
  return [...hosts];
}

/** A listener's accepted `Host` names (`hostHeaderAllowed`). */
export interface HostPolicy {
  /** Allowed names: `name` matches on any port, `name:port` matches exactly. */
  allowed: string[];
}

/** Hostname of the operator-declared public URL (`BETTER_AUTH_URL`), if any. */
function publicUrlHost(env: NodeJS.ProcessEnv): string | null {
  const raw = env.BETTER_AUTH_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Main-listener Host policy: `null` means no validation. Validation applies on
 * a loopback bind, under the `local` trust profile, or whenever
 * `MARINA_ALLOWED_HOSTS` is set; a public bind with none of those keeps
 * accepting any Host (a deployment behind a proxy names its public host in
 * `MARINA_ALLOWED_HOSTS` to opt in). Loopback names, a specific bind address,
 * the `BETTER_AUTH_URL` host and the listed names are allowed; a public bind
 * under the `local` profile with no list uses `derivedPublicHosts`.
 */
export function mainListenerHostPolicy(
  bindHost: string,
  loopbackBind: boolean,
  localProfile: boolean,
  env: NodeJS.ProcessEnv = process.env,
): HostPolicy | null {
  const extra = parseHostList(env.MARINA_ALLOWED_HOSTS);
  if (!loopbackBind && !localProfile && extra.length === 0) return null;
  const allowed = new Set<string>([...LOOPBACK_NAMES, ...extra]);
  const bind = bindHost.trim().toLowerCase();
  if (loopbackBind || extra.length > 0) {
    if (bind && bind !== "0.0.0.0" && bind !== "::" && bind !== "[::]") {
      allowed.add(bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind);
    }
    const declared = publicUrlHost(env);
    if (declared) allowed.add(declared);
  } else {
    for (const h of derivedPublicHosts(bindHost, env)) allowed.add(h);
  }
  return { allowed: [...allowed] };
}

/** Split a `Host` header into lower-cased hostname (brackets kept) and port. */
function splitHost(value: string): { name: string; port: string | null } | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const bracket = v.match(/^(\[[^\]]+\])(?::(\d+))?$/);
  if (bracket) return { name: bracket[1] ?? "", port: bracket[2] ?? null };
  const plain = v.match(/^([^:\s/@]+)(?::(\d+))?$/);
  if (plain) return { name: plain[1] ?? "", port: plain[2] ?? null };
  return null;
}

/**
 * True when `hostHeader` passes `policy`. `null` policy ⇒ always true. A
 * literal loopback name passes on any port (the dashboard dev server proxies
 * from 5173); an allowlisted `name` passes on any port, `name:port` exactly.
 */
export function hostHeaderAllowed(
  hostHeader: string | null | undefined,
  policy: HostPolicy | null,
): boolean {
  if (!policy) return true;
  const parsed = splitHost(hostHeader ?? "");
  if (!parsed) return false;
  if (isLoopbackHostname(parsed.name)) return true;
  for (const entry of policy.allowed) {
    const e = splitHost(entry);
    if (!e || e.name !== parsed.name) continue;
    if (e.port === null || e.port === parsed.port) return true;
  }
  return false;
}

/** Plain-text 421 for a request whose Host the main listener does not answer to. */
export function misdirectedHostResponse(hostHeader: string | null): Response {
  return new Response(
    `Host ${JSON.stringify((hostHeader ?? "").slice(0, 200))} is not served here. On a loopback bind only ` +
      "loopback names are accepted; add the name clients use to MARINA_ALLOWED_HOSTS.\n",
    {
      status: 421,
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
    },
  );
}

/**
 * Host gate for a listener bound to `bindHost`: `null` when the request may
 * proceed, else the 421 from `misdirectedHostResponse`. Same rule as the main
 * listener (`mainListenerHostPolicy`) — used by the standalone listeners
 * (memory service, log viewer) that have no route table of their own.
 */
export function refuseDisallowedHost(
  req: Request,
  bindHost: string,
  localProfile: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Response | null {
  const policy = mainListenerHostPolicy(bindHost, isLoopbackHostname(bindHost), localProfile, env);
  const host = req.headers.get("Host");
  return hostHeaderAllowed(host, policy) ? null : misdirectedHostResponse(host);
}
