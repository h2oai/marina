// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { memoryRetryDelay, withMemoryAbort } from "./memory-abort";
import { MemoryClientError } from "./memory-client";

/** Longest total time spent waiting out named rate-limit waits before giving up. */
const RATE_LIMIT_WAIT_CAP_MS = 30_000;
/** Timers may fire a little early; wait slightly past a named rate-limit wait. */
const RATE_LIMIT_MARGIN_MS = 5;

/**
 * Opt-in retry of the SAME request/key. Never reinterpret conflicts or denial.
 * A rate limit that names its wait (the next token) is waited out exactly and
 * does not use up an attempt — it is not a failure — up to a total of
 * `RATE_LIMIT_WAIT_CAP_MS`; other transient errors back off exponentially.
 */
export async function retryMemoryOperation<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10)
    throw new RangeError("Retry attempts must be an integer from 1 to 10");
  const sleep = options.sleep ?? ((ms: number) => memoryRetryDelay(ms, options.signal));
  let rateLimitWaited = 0;
  for (let attempt = 0; ; ) {
    try {
      return await withMemoryAbort(operation, options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      const retryable =
        error instanceof MemoryClientError
          ? [408, 429, 502, 503, 504].includes(error.status)
          : error instanceof TypeError ||
            (error instanceof Error && ["TimeoutError", "NetworkError"].includes(error.name));
      if (!retryable) throw error;
      const requested = error instanceof MemoryClientError ? error.retryAfterMs : undefined;
      // Do not retry sooner than a server's longer delay; hand control back.
      if (requested !== undefined && requested > 5000) throw error;
      const named =
        error instanceof MemoryClientError &&
        error.status === 429 &&
        error.code === "rate_limited" &&
        requested !== undefined;
      if (named) {
        const wait = requested + RATE_LIMIT_MARGIN_MS;
        if (rateLimitWaited + wait > RATE_LIMIT_WAIT_CAP_MS) throw error;
        rateLimitWaited += wait;
        await withMemoryAbort(() => sleep(wait), options.signal);
        continue;
      }
      attempt++;
      if (attempt >= attempts) throw error;
      await withMemoryAbort(
        () => sleep(Math.max(requested ?? 0, Math.min(2000, 250 * 2 ** (attempt - 1)))),
        options.signal,
      );
    }
  }
}
