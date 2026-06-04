// ─── Error Utilities ─────────────────────────────────────────────────────────

import type { Logger } from "./logger";

/** Extract a human-readable message from an unknown thrown value. */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
