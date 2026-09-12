// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { memoryRetryDelay, withMemoryAbort } from "./memory-abort";
import { MemoryClientError } from "./memory-client";

/** Opt-in retry of the SAME request/key. Never reinterpret conflicts or denial. */
export async function retryMemoryOperation<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10)
    throw new RangeError("Retry attempts must be an integer from 1 to 10");
  const sleep = options.sleep ?? ((ms: number) => memoryRetryDelay(ms, options.signal));
  for (let attempt = 0; ; attempt++) {
    try {
      return await withMemoryAbort(operation, options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      const retryable =
        error instanceof MemoryClientError
          ? [408, 429, 502, 503, 504].includes(error.status)
          : error instanceof TypeError ||
            (error instanceof Error && ["TimeoutError", "NetworkError"].includes(error.name));
      if (!retryable || attempt + 1 >= attempts) throw error;
      const requested = error instanceof MemoryClientError ? error.retryAfterMs : undefined;
      // Do not retry sooner than a server's longer delay; hand control back.
      if (requested !== undefined && requested > 5000) throw error;
      await withMemoryAbort(
        () => sleep(Math.max(requested ?? 0, Math.min(2000, 250 * 2 ** attempt))),
        options.signal,
      );
    }
  }
}
