// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-world daily spend: every dollar a world pays upstream, recorded ONCE,
 * where it leaves Marina, and a cap on the day's total
 * (`MARINA_DAILY_SPEND_CAP_USD`, UTC days; unset = no cap). Child worlds get
 * `MARINA_CHILD_DAILY_SPEND_CAP_USD` (default $50) from the parent.
 *
 *   model_api  — `/v1` passthru, when an upstream call completes (benchmark
 *                runs, agents on `marina/*`, any OpenAI client)
 *   agent      — an agent turn priced by its OWN provider; a turn priced from
 *                the proxy's `x-marina-cost-usd` header is already model_api
 *   decision   — a decision backend call that reported a cost
 *   forecast   — forecast / arena analyst and retrieval calls
 *
 * Process-level on purpose: each world is its own process (child worlds run
 * `src/main.ts` separately), so the cap is per world by construction. The
 * engine attaches a sink that persists the day's totals (`spend_daily`), and
 * the day's total is reloaded from it on boot, so a restart does not reset
 * the budget. Standalone scripts count in memory only.
 */

export type SpendSource = "model_api" | "agent" | "decision" | "forecast";

export interface SpendSink {
  add(day: string, source: SpendSource, usd: number): void;
  totalFor(day: string): number;
}

let sink: SpendSink | undefined;
let currentDay = "";
let today = 0;

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function roll(now: number): void {
  const day = utcDay(now);
  if (day === currentDay) return;
  currentDay = day;
  try {
    today = sink?.totalFor(day) ?? 0;
  } catch {
    // An unreadable ledger (closed database) must not break the caller; the
    // day restarts from what this process records.
    today = 0;
  }
}

/** Connect persistence (the engine does this once its database is open). */
export function attachSpendLedger(next: SpendSink): void {
  sink = next;
  currentDay = "";
  roll(Date.now());
}

export function recordSpend(source: SpendSource, usd: number | undefined, now = Date.now()): void {
  if (!usd || !Number.isFinite(usd) || usd <= 0) return;
  roll(now);
  today += usd;
  try {
    sink?.add(currentDay, source, usd);
  } catch {
    // Persisting is best effort (the engine's sink already logs failures);
    // the in-memory total still enforces the cap.
  }
}

export function spentTodayUsd(now = Date.now()): number {
  roll(now);
  return today;
}

export function dailySpendCapUsd(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const cap = Number(env.MARINA_DAILY_SPEND_CAP_USD);
  return Number.isFinite(cap) && cap > 0 ? cap : undefined;
}

export interface DailySpendState {
  spentUsd: number;
  capUsd?: number;
  reached: boolean;
}

export function dailySpend(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): DailySpendState {
  const capUsd = dailySpendCapUsd(env);
  const spentUsd = spentTodayUsd(now);
  return {
    spentUsd,
    ...(capUsd ? { capUsd } : {}),
    reached: capUsd !== undefined && spentUsd >= capUsd,
  };
}

/** The refusal every capped surface uses, or undefined when there is budget left. */
export function dailyCapRefusal(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): string | undefined {
  const s = dailySpend(env, now);
  if (!s.reached) return undefined;
  return `daily spend cap reached (${formatSpendUsd(s.spentUsd)} today ≥ ${formatSpendUsd(s.capUsd!)}, MARINA_DAILY_SPEND_CAP_USD); resumes at 00:00 UTC`;
}

/** Dollars with enough digits to see sub-cent spend ($0.00007, not $0.00). */
export function formatSpendUsd(usd: number): string {
  return usd >= 1 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toPrecision(2)}`;
}

export function resetSpendLedgerForTests(): void {
  sink = undefined;
  currentDay = "";
  today = 0;
}
