// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import {
  backoff,
  failureKind,
  isTransientFailure,
  modelRetries,
  modelRetryBaseMs,
  retryDelayMs,
} from "../model/retry";

/** Statuses a fresh review may retry: throttled, unavailable, overloaded. */
const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504, 529]);
const MAX_SERVER_DELAY_MS = 30_000;

/** `Retry-After` in ms when the response names a wait (seconds or a date), bounded. */
function serverDelayMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number.parseFloat(header);
  const ms = Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
  return Number.isFinite(ms) ? Math.min(MAX_SERVER_DELAY_MS, Math.max(0, ms)) : undefined;
}

/**
 * The fresh reviewers' HTTP leg with the same bounded retry a model call gets:
 * a transient failure (a closed connection, a reset, a 429/5xx) is tried again
 * up to `MARINA_MODEL_RETRIES` times, honouring `Retry-After` when the reply
 * names a wait, never on an abort or the call's own timeout. They post to the
 * local `/v1` with their own `fetch`, so `src/model/call.ts`'s retry never saw
 * their failures — one closed connection failed an otherwise finished review.
 */
export async function postFreshReview(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  opts: { env: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<Response> {
  const retries = modelRetries(opts.env);
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: opts.signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = failureKind(message, opts.signal.aborted);
      if (!isTransientFailure(kind) || attempt >= retries) throw error;
      await backoff(retryDelayMs(attempt, modelRetryBaseMs(opts.env)), opts.signal);
      continue;
    }
    if (!RETRYABLE_STATUS.has(response.status) || attempt >= retries) return response;
    const wait = serverDelayMs(response) ?? retryDelayMs(attempt, modelRetryBaseMs(opts.env));
    try {
      await response.body?.cancel();
    } catch {
      // allow-empty-catch: the throttled reply's body is being discarded; nothing to recover
    }
    await backoff(wait, opts.signal);
  }
}
