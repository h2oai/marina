// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-time ingress refusals (called from src/main.ts). A non-loopback
 * EXPOSURE combined with passwordless login, the open-API dev bypass or the
 * `open` posture is a fatal startup error unless the operator enables real
 * auth or explicitly accepts the risk (MARINA_ALLOW_INSECURE_PUBLIC=true).
 *
 * Exposure is the real bind, except that a container's wildcard bind published
 * only on the host's loopback (`MARINA_PUBLISHED_HOST`, see `publishedLoopback`
 * in loopback.ts) counts as loopback here — never for the trust profile.
 */

import { existsSync } from "node:fs";

/** Docker writes /.dockerenv, Podman /run/.containerenv. */
export function detectContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

export interface BindSafetyInput {
  /** The resolved WebSocket/HTTP bind host (WS_HOST / MARINA_HOST / MARINA_PUBLIC). */
  bindHost: string;
  /** The bind is loopback, or a container publish pins it to host loopback. */
  loopbackExposure: boolean;
  authEnabled: boolean;
  insecurePublicAck: boolean;
  openApi: boolean;
  openPosture: boolean;
  /** `MARINA_PUBLISHED_HOST` when set: named in the fix list for containers. */
  publishedHost?: string;
}

/** Returns the fatal message for an unsafe exposure, or undefined when safe. */
export function bindSafetyRefusal(input: BindSafetyInput): string | undefined {
  if (input.loopbackExposure || input.insecurePublicAck) return undefined;
  const where = input.publishedHost?.trim()
    ? `("${input.bindHost}", published on host "${input.publishedHost.trim()}")`
    : `("${input.bindHost}")`;
  const containerFix = input.publishedHost?.trim()
    ? `  • in a container: publish on the host's loopback (unset MARINA_BIND_IP, so MARINA_PUBLISHED_HOST=127.0.0.1), or\n`
    : "";
  if (!input.authEnabled) {
    return (
      `FATAL: Marina is configured to bind a NON-LOOPBACK interface ` +
      `${where} while passwordless name-login is in effect ` +
      `(MARINA_AUTH is not "better-auth"). Anyone who can reach this host could log ` +
      `in as any entity. Fix ONE of:\n` +
      `  • keep it local: unset WS_HOST/MARINA_HOST/MARINA_PUBLIC (binds 127.0.0.1), or\n` +
      containerFix +
      `  • require sign-in: set MARINA_AUTH=better-auth (+ MARINA_AUTH_ADMIN_EMAILS), or\n` +
      `  • accept the risk explicitly: set MARINA_ALLOW_INSECURE_PUBLIC=true.`
    );
  }
  if (input.openApi) {
    return (
      `FATAL: MARINA_OPEN_API=true (unauthenticated API access) combined with a ` +
      `NON-LOOPBACK bind ${where} exposes every API endpoint to the ` +
      `network with no auth. Fix ONE of:\n` +
      `  • unset MARINA_OPEN_API and configure MODEL_API_KEYS/MEM_API_KEYS, or\n` +
      `  • bind loopback-only (unset WS_HOST/MARINA_HOST/MARINA_PUBLIC), or\n` +
      containerFix +
      `  • accept the risk explicitly: set MARINA_ALLOW_INSECURE_PUBLIC=true.`
    );
  }
  // Unreachable while passwordless login is refused above; kept as its own
  // rule so the `open` posture never depends on that ordering.
  if (input.openPosture && !input.authEnabled) {
    return (
      `FATAL: MARINA_AUTONOMY=open combined with a NON-LOOPBACK bind ` +
      `${where} and passwordless login would grant gated capabilities ` +
      `to anyone who can reach this host. Fix ONE of:\n` +
      `  • keep it local: unset WS_HOST/MARINA_HOST/MARINA_PUBLIC, or\n` +
      containerFix +
      `  • require sign-in: set MARINA_AUTH=better-auth, or\n` +
      `  • accept the risk explicitly: set MARINA_ALLOW_INSECURE_PUBLIC=true.`
    );
  }
  return undefined;
}
