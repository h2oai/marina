// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider auth refusals for the autonomous loop. A 401/403 (or a provider's
 * "invalid key" body) cannot succeed on retry: the loop parks the agent
 * (pause kind `provider-auth`), tells its spawner once per outage, and calls
 * the model again only when the credentials change or on a slow probe. Rate
 * limits, 5xx and network errors are NOT auth refusals and keep the ordinary
 * backoff (`afterUpstreamError`).
 */

import { createHash } from "node:crypto";

const AUTH_STATUS = /^\s*(401|403)\b/;
const AUTH_TEXT =
  /authentication_error|permission_error|invalid[ _-]?x-api-key|invalid[ _-]api[ _-]key|incorrect api key|api key not valid|no api key/i;

/** True when an upstream error message says the provider refused the credentials. */
export function isProviderAuthError(message: string): boolean {
  return AUTH_STATUS.test(message) || AUTH_TEXT.test(message);
}

/** The HTTP status that leads a provider error message (`401: …`, `403 …`), if any. */
export function providerErrorStatus(message: string): number | undefined {
  const m = /^\s*(\d{3})\b/.exec(message);
  return m ? Number(m[1]) : undefined;
}

/** First probe after a refusal; doubles per failed probe up to the cap. */
export const PROVIDER_AUTH_PROBE_BASE_MS = 5 * 60_000;
export const PROVIDER_AUTH_PROBE_CAP_MS = 60 * 60_000;
/** How often a parked loop re-reads the credential fingerprint. */
export const PROVIDER_AUTH_POLL_MS = 5_000;

/** Delay before the `attempt`-th unprompted re-probe (5 min, 10, 20, 40, then 60). */
export function providerAuthProbeMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(PROVIDER_AUTH_PROBE_CAP_MS, PROVIDER_AUTH_PROBE_BASE_MS * 2 ** (n - 1));
}

const CREDENTIAL_ENV = /_API_KEY$|^HF_TOKEN$/;

/**
 * Opaque digest of the provider credentials visible to this process (every
 * `*_API_KEY` / `HF_TOKEN` env value plus caller-supplied extras such as the
 * stored key rows). Only compared for change — never logged or shown.
 */
export function providerCredentialsFingerprint(
  extra: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const h = createHash("sha256");
  for (const key of Object.keys(env).sort()) {
    if (!CREDENTIAL_ENV.test(key)) continue;
    h.update(`${key}=${env[key] ?? ""}\n`);
  }
  for (const item of extra) h.update(`${item}\n`);
  return h.digest("hex");
}
