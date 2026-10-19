// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Error Utilities ─────────────────────────────────────────────────────────

import { getErrorMessage } from "../sdk/errors";
import type { Logger, LogLevel } from "./logger";

export { getErrorMessage } from "../sdk/errors";

/**
 * Execute a function, catching and logging any error.
 * Used for non-critical operations that should not crash the caller.
 */
export function tryLog(logger: Logger, category: string, message: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.warn(category, message, { error: getErrorMessage(err) });
  }
}

/**
 * Async variant of tryLog for async operations.
 */
export async function tryLogAsync(
  logger: Logger,
  category: string,
  message: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn(category, message, { error: getErrorMessage(err) });
  }
}

/**
 * A promise `.catch` handler that logs the rejection and resolves to
 * `fallback` (default `undefined`) — the logged replacement for a handler
 * that silently returns a constant (see `test/lint-no-empty-catch.test.ts`).
 * Default level `warn`; pass `debug` for failures that are expected noise but
 * still worth seeing when diagnosing.
 */
export function logRejection<T = undefined>(
  logger: Logger,
  category: string,
  message: string,
  opts: { level?: LogLevel; fallback?: T } = {},
): (err: unknown) => T {
  return (err) => {
    logger.log(opts.level ?? "warn", category, message, { error: getErrorMessage(err) });
    return opts.fallback as T;
  };
}

// ─── Result Type ─────────────────────────────────────────────────────────────

/** Discriminated union for operations that can succeed or fail. */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

/** Create a success result. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Create a failure result. */
export function fail<E = string>(error: E): Result<never, E> {
  return { ok: false, error };
}
