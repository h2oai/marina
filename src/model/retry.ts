// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded retry for transient model-call failures: HTTP 429 throttling,
 * 5xx, and network errors. Never a usage/quota limit (route health owns
 * that), an auth refusal, another 4xx, Marina's own spend cap, a caller
 * abort or the call's own timeout.
 *
 * `MARINA_MODEL_RETRIES` (default 1, `0` = off, at most 5) extra attempts per
 * call; `MARINA_MODEL_RETRY_BASE_MS` (default 1000) is the first backoff,
 * doubled per attempt with up to 25 % jitter, capped at 30 s.
 */

import { classifyUpstreamRefusal } from "../net/model/route-health";

export const DEFAULT_MODEL_RETRIES = 1;
export const MAX_MODEL_RETRIES = 5;
export const DEFAULT_MODEL_RETRY_BASE_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export function modelRetries(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MARINA_MODEL_RETRIES?.trim().toLowerCase();
  if (!raw) return DEFAULT_MODEL_RETRIES;
  if (raw === "off") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_MODEL_RETRIES;
  return Math.min(n, MAX_MODEL_RETRIES);
}

export function modelRetryBaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MARINA_MODEL_RETRY_BASE_MS?.trim());
  return env.MARINA_MODEL_RETRY_BASE_MS?.trim() && Number.isFinite(n) && n >= 0
    ? n
    : DEFAULT_MODEL_RETRY_BASE_MS;
}

/** Delay before retry `attempt` (0-based): base · 2^attempt, + ≤ 25 % jitter, ≤ 30 s. */
export function retryDelayMs(attempt: number, baseMs: number, random = Math.random): number {
  const plain = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** attempt);
  return Math.round(plain + plain * 0.25 * random());
}

const NETWORK =
  /fetch failed|network|socket hang up|other side closed|\bterminated\b|connection (?:error|reset|refused|closed)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR/i;
const SERVER = /\b(?:internal server error|bad gateway|service unavailable|gateway time-?out)\b/i;

export type FailureKind =
  | "rate_limit"
  | "provider"
  | "network"
  | "quota"
  | "auth"
  | "cancelled"
  | "timeout"
  | "unknown";

/** What a failed call's message says, in the trace's `errorKind` terms. */
export function failureKind(message: string, aborted = false): FailureKind {
  if (aborted) return "cancelled";
  const refusal = classifyUpstreamRefusal(message);
  if (refusal.kind === "usage-limit") return "quota";
  if (refusal.kind === "auth") return "auth";
  if (refusal.kind === "rate-limit") return "rate_limit";
  if (refusal.kind === "other" && /spend[_ ]cap|spend refused/i.test(message)) return "quota";
  if (/\btimed? ?out\b|TimeoutError|aborted due to timeout/i.test(message)) return "timeout";
  if (/\babort/i.test(message)) return "cancelled";
  const status = refusal.status;
  if ((status !== undefined && status >= 500 && status <= 599) || SERVER.test(message))
    return "provider";
  if (NETWORK.test(message)) return "network";
  return "unknown";
}

/** True when another attempt of the same call may succeed. */
export function isTransientFailure(kind: FailureKind): boolean {
  return kind === "rate_limit" || kind === "provider" || kind === "network";
}

/** Sleep that a caller's abort ends early (with the abort's reason). */
export function backoff(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
