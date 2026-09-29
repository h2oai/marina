// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Per-buffer cap on events held between flushes. A background tab never
 *  runs requestAnimationFrame, so without a cap a busy world grows these
 *  arrays without limit. */
export const MAX_PENDING_EVENTS = 2000;

/** Fallback flush delay. rAF normally wins; this timer is what flushes a
 *  hidden tab, where rAF is paused. */
export const HIDDEN_FLUSH_MS = 250;

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;

/** Append `item`, dropping the oldest entries past `max`. Returns how many
 *  entries were dropped (0 or more). */
export function pushBounded<T>(buffer: T[], item: T, max = MAX_PENDING_EVENTS): number {
  buffer.push(item);
  const overflow = buffer.length - max;
  if (overflow <= 0) return 0;
  buffer.splice(0, overflow);
  return overflow;
}

/** Exponential backoff with jitter: the window doubles per failed attempt up
 *  to `max`, and the delay is drawn from the upper half of that window so
 *  reconnecting tabs spread out instead of stampeding a restarted server. */
export function reconnectDelay(
  attempt: number,
  random: () => number = Math.random,
  base = RECONNECT_BASE_MS,
  max = RECONNECT_MAX_MS,
): number {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + random() * (exp / 2));
}
