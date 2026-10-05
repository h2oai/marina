// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What every live forecasting adapter (Metaculus, ForecastBench, Prophet)
 * shares, so each one stays a thin mapping over Marina's general typed
 * forecaster:
 *
 *   - lessons: forecasts recall the one lesson pool through
 *     `forecastLessonsFor` (`src/learning/forecast-bridge.ts`; visible only
 *     once their outcome was known at the forecast's cutoff; `MARINA_LESSONS`
 *     on / observe / off); resolved outcomes go back into it via `noteOutcome`;
 *   - the world's daily spend ledger, so a standalone run counts against the
 *     same `MARINA_DAILY_SPEND_CAP_USD` budget as the server;
 *   - small helpers (bounded concurrency, a reasoning excerpt).
 *
 * Configurations live in `configs.ts`; choosing one in `select.ts`. No
 * benchmark-specific logic lives here.
 */

import { attachDbSpendLedger } from "../../src/engine/spend-ledger";
import type { TypedForecastAnswer } from "../../src/forecast/typed";
import type { MarinaDB } from "../../src/persistence/database";

/** The attribution every adapter files under. */
export const ATTRIBUTION = { organization: "H2O.ai", agent: "Marina" } as const;

/**
 * Count this process's upstream spend in the world's `spend_daily` ledger, so
 * the daily cap holds across runs (a timer starts a fresh process each time).
 * Returns the detach function; call it before closing the database.
 */
export function attachWorldSpend(db: MarinaDB): () => void {
  return attachDbSpendLedger(db);
}

/** Run `fn` over `items` with at most `concurrency` in flight; results in input order. */
export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  return out;
}

/** A short reasoning text from the answer: the runs' and critic's reasons. */
export function reasoningText(
  answer: TypedForecastAnswer,
  opts: { maxChars?: number } = {},
): string {
  const reasons = [
    ...answer.runs.map((r) => r.reason).filter((r): r is string => !!r),
    ...(answer.critique?.applied && answer.critique.reason ? [answer.critique.reason] : []),
  ];
  const text = [...new Set(reasons)].join(" ");
  const max = opts.maxChars ?? 2_000;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
