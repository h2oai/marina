// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Loopback classification ─────────────────────────────────────────────────
//
// The single definition of "loopback" for hostnames (browser origins, bind
// settings, outbound targets) and socket peer addresses. A hostname is
// loopback only when it IS a loopback address or `localhost` — never because
// it starts with `127.`: `127.attacker.example` is an ordinary DNS name that
// any site can serve a page from.

/** IPv4 dotted quad in 127.0.0.0/8, every octet 0–255. */
function isLoopbackIpv4(value: string): boolean {
  const octets = value.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

/**
 * True for a loopback HOSTNAME as written in a URL or bind setting:
 * `localhost`, `::1` (with or without the brackets `URL.hostname` keeps), or an
 * IPv4 literal in 127.0.0.0/8. DNS names are never loopback here, even when they
 * resolve to it — a name's owner can repoint it.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return h === "localhost" || h === "::1" || isLoopbackIpv4(h);
}

/**
 * True when a REAL socket peer address (from the socket, never a forwarded
 * header) is loopback: IPv4 127.0.0.0/8, `::1`, or IPv4-mapped `::ffff:127.x.y.z`.
 * Undefined fails closed.
 */
export function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const value = ip.trim().toLowerCase();
  if (value === "::1" || isLoopbackIpv4(value)) return true;
  return value.startsWith("::ffff:") && isLoopbackIpv4(value.slice("::ffff:".length));
}
