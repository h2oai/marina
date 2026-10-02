// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-world daily spend: every dollar a world pays upstream, recorded ONCE,
 * where it leaves Marina, and a cap on the day's total
 * (`MARINA_DAILY_SPEND_CAP_USD`, UTC days; unset = $50, `0` or `off` = no
 * cap). Child worlds get `MARINA_CHILD_DAILY_SPEND_CAP_USD` (default $50),
 * never more than the parent's own cap.
 *
 *   model_api  — `/v1` passthru, when an upstream call completes (benchmark
 *                runs, agents on `marina/*`, any OpenAI client)
 *   agent      — an agent turn priced by its OWN provider; a turn priced from
 *                the proxy's `x-marina-cost-usd` header is already model_api
 *   decision   — a decision backend call that reported a cost
 *   forecast   — forecast / arena analyst and retrieval calls
 *   media      — image / video generation, at the provider's estimated price
 *
 * Process-level on purpose: each world is its own process (child worlds run
 * `src/main.ts` separately), so the cap is per world by construction. The
 * engine attaches a sink that persists the day's totals (`spend_daily`), and
 * the day's total is reloaded from it on boot, so a restart does not reset
 * the budget. Standalone scripts count in memory only.
 */

export type SpendSource = "model_api" | "agent" | "decision" | "forecast" | "media";

export interface SpendSink {
  add(day: string, source: SpendSource, usd: number): void;
  totalFor(day: string): number;
}

let sink: { target: SpendSink } | undefined;
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
    today = sink?.target.totalFor(day) ?? 0;
  } catch {
    // An unreadable ledger (closed database) must not break the caller; the
    // day restarts from what this process records.
    today = 0;
  }
}

/** Connect persistence; the owner must release it before closing its database.
 * Releasing an older attachment cannot detach a newer world's ledger. */
export function attachSpendLedger(next: SpendSink): () => void {
  const attachment = { target: next };
  sink = attachment;
  currentDay = "";
  roll(Date.now());
  return () => {
    if (sink === attachment) sink = undefined;
  };
}

export function recordSpend(source: SpendSource, usd: number | undefined, now = Date.now()): void {
  if (!usd || !Number.isFinite(usd) || usd <= 0) return;
  roll(now);
  today += usd;
  try {
    sink?.target.add(currentDay, source, usd);
  } catch {
    // Persisting is best effort (the engine's sink already logs failures);
    // the in-memory total still enforces the cap.
  }
}

export function spentTodayUsd(now = Date.now()): number {
  roll(now);
  return today;
}

/** The cap when `MARINA_DAILY_SPEND_CAP_USD` is unset (USD per UTC day, per world). */
export const DEFAULT_DAILY_SPEND_CAP_USD = 50;
/** A child world's cap when `MARINA_CHILD_DAILY_SPEND_CAP_USD` is unset. */
export const DEFAULT_CHILD_DAILY_SPEND_CAP_USD = 50;

/**
 * Parse a cap value: a positive number is the cap, `0` / `off` / `none` /
 * `unlimited` is explicitly uncapped (`null`), and unset, blank or junk is
 * `undefined` so the caller applies its default — a typo never lifts a cap.
 */
function parseCap(raw: string | undefined): number | null | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "off" || value === "none" || value === "unlimited") return null;
  const cap = Number(value);
  if (!Number.isFinite(cap) || cap < 0) return undefined;
  return cap === 0 ? null : cap;
}

/**
 * The world's daily cap in USD, or undefined when the operator explicitly
 * uncapped it (`MARINA_DAILY_SPEND_CAP_USD=0` or `off`). Unset (or an
 * unparseable value) is {@link DEFAULT_DAILY_SPEND_CAP_USD}.
 */
export function dailySpendCapUsd(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const cap = parseCap(env.MARINA_DAILY_SPEND_CAP_USD);
  if (cap === null) return undefined;
  return cap ?? DEFAULT_DAILY_SPEND_CAP_USD;
}

/**
 * The `MARINA_DAILY_SPEND_CAP_USD` a child world is started with:
 * `MARINA_CHILD_DAILY_SPEND_CAP_USD` (default $50, `0`/`off` = uncapped),
 * never above the parent's own cap — a child cannot out-spend its parent.
 */
export function childDailySpendCapEnv(env: NodeJS.ProcessEnv = process.env): string {
  const parent = dailySpendCapUsd(env);
  const own = parseCap(env.MARINA_CHILD_DAILY_SPEND_CAP_USD);
  const child = own === undefined ? DEFAULT_CHILD_DAILY_SPEND_CAP_USD : own;
  if (child === null) return parent === undefined ? "off" : String(parent);
  return String(parent === undefined ? child : Math.min(child, parent));
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
  return `daily spend cap reached (${formatSpendUsd(s.spentUsd)} today ≥ ${formatSpendUsd(s.capUsd!)}); resumes at 00:00 UTC — to raise it set MARINA_DAILY_SPEND_CAP_USD=<usd> (or 0 to remove the cap) and restart`;
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
