// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.io.IOException;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Opt-in retry of the SAME memory request and key: conflicts and refusals are never retried or
 * reinterpreted.
 *
 * <pre>{@code
 * Http.MemoryReceipt receipt =
 *     MemoryRetry.run(() -> memory.remember(space, Http.MemoryRecordInput.of("Deploys run from main"), "note-1"));
 * }</pre>
 *
 * <ul>
 *   <li>A named rate limit ({@code 429 rate_limited} with {@code retry_after_ms}) is waited out
 *       exactly (plus 5 ms) and does not use up an attempt, up to 30 s of such waits in all.
 *   <li>408, 429, 502, 503, 504 and network errors back off 250 ms, doubling to 2 s.
 *   <li>A server wait over 5 s is handed back to the caller (the error is rethrown).
 * </ul>
 */
public final class MemoryRetry {
  private MemoryRetry() {}

  /** Longest total time spent waiting out named rate-limit waits before giving up. */
  public static final long RATE_LIMIT_WAIT_CAP_MS = 30_000;
  /** Timers may fire a little early; wait slightly past a named rate-limit wait. */
  public static final long RATE_LIMIT_MARGIN_MS = 5;

  private static final Set<Integer> RETRYABLE = Set.of(408, 429, 502, 503, 504);

  /** How to wait; tests pass their own. */
  @FunctionalInterface
  public interface Sleeper {
    void sleep(long ms) throws InterruptedException;
  }

  /** Retry with 5 attempts, sleeping on this thread. */
  public static <T> T run(Supplier<T> operation) {
    return run(operation, 5, Thread::sleep);
  }

  /**
   * Retry {@code operation} (which must resend the same request and idempotency key).
   *
   * @param attempts 1 to 10: tries that are not named rate-limit waits
   */
  public static <T> T run(Supplier<T> operation, int attempts, Sleeper sleeper) {
    if (attempts < 1 || attempts > 10)
      throw new IllegalArgumentException("Retry attempts must be an integer from 1 to 10");
    long rateLimitWaited = 0;
    int attempt = 0;
    while (true) {
      try {
        return operation.get();
      } catch (MarinaException error) {
        ApiException api = error instanceof ApiException a ? a : null;
        boolean retryable = api != null ? RETRYABLE.contains(api.status()) : error.getCause() instanceof IOException;
        if (!retryable) throw error;
        Long requested = api != null ? api.retryAfterMs() : null;
        // Do not retry sooner than a server's longer delay; hand control back.
        if (requested != null && requested > 5000) throw error;
        boolean named = api != null && api.status() == 429 && "rate_limited".equals(api.code()) && requested != null;
        if (named) {
          long wait = requested + RATE_LIMIT_MARGIN_MS;
          if (rateLimitWaited + wait > RATE_LIMIT_WAIT_CAP_MS) throw error;
          rateLimitWaited += wait;
          sleep(sleeper, wait);
          continue;
        }
        attempt++;
        if (attempt >= attempts) throw error;
        sleep(sleeper, backoffMs(attempt, requested));
      }
    }
  }

  /** The wait before retry number {@code attempt} (1-based): 250 ms doubling to 2 s, or longer if asked. */
  public static long backoffMs(int attempt, Long requested) {
    long backoff = Math.min(2000, 250L << Math.min(attempt - 1, 20));
    return Math.max(requested == null ? 0 : requested, backoff);
  }

  private static void sleep(Sleeper sleeper, long ms) {
    try {
      sleeper.sleep(ms);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new MarinaException("Interrupted", e);
    }
  }
}
