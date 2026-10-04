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
 * One ledger per world database. The engine attaches a sink that persists the
 * day's totals (`spend_daily`), and every command-line process that opens the
 * same database (`DB_PATH`) attaches it too (`attachDbSpendLedger`), so the
 * server, an hourly timer and a backtest share ONE daily total: the cap is
 * checked against the persisted UTC-day total, re-read on every check, never
 * against a counter that starts at $0 with each process. A process without a
 * database counts in memory only and says so once (`warnInMemorySpend`).
 * Child worlds run `src/main.ts` on their own database, so the cap stays per
 * world by construction.
 *
 * Budget scopes: `MARINA_SPEND_SCOPE=<name>` additionally records this
 * process's dollars under that scope (`spend_scope_daily`, migration 156, in
 * the same transaction as the global row) and caps them at
 * `MARINA_SPEND_SCOPE_CAP_USD` (unset or junk = $50, `0`/`off` = uncapped). A
 * scoped process is refused when EITHER its scope cap OR the world's global
 * cap is reached — a scope only ever narrows the budget. An invalid scope name
 * refuses all spend rather than silently dropping the scope cap.
 */

export type SpendSource = "model_api" | "agent" | "decision" | "forecast" | "media";

export interface SpendSink {
  /** Record `usd` for the day (and, when given, the scope) atomically. */
  add(day: string, source: SpendSource, usd: number, scope?: string): void;
  /** The world's persisted total for the day, across every process. */
  totalFor(day: string): number;
  /** The persisted total for one scope; absent = the sink keeps no scopes. */
  scopeTotalFor?(day: string, scope: string): number;
}

let sink: { target: SpendSink } | undefined;
let currentDay = "";
/** Best known day total: the last persisted read plus this process's spend
 * since. A persisted total only grows within a day, so the larger of the two
 * is never above the truth — a failed write or a closed database cannot lower
 * it, and another process's spend raises it on the next read. */
let today = 0;
const scopeToday = new Map<string, number>();

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function roll(now: number): void {
  const day = utcDay(now);
  if (day === currentDay) return;
  currentDay = day;
  today = 0;
  scopeToday.clear();
}

function readTotal(): number {
  try {
    const persisted = sink?.target.totalFor(currentDay);
    if (persisted !== undefined && Number.isFinite(persisted) && persisted > today) {
      today = persisted;
    }
  } catch {
    // An unreadable ledger (closed database) must not break the caller; the
    // best known total still enforces the cap.
  }
  return today;
}

function readScopeTotal(scope: string): number {
  let known = scopeToday.get(scope) ?? 0;
  try {
    const persisted = sink?.target.scopeTotalFor?.(currentDay, scope);
    if (persisted !== undefined && Number.isFinite(persisted) && persisted > known) {
      known = persisted;
      scopeToday.set(scope, known);
    }
  } catch {
    // As readTotal: fall back to the best known scope total.
  }
  return known;
}

/** Connect persistence; the owner must release it before closing its database.
 * Releasing an older attachment cannot detach a newer world's ledger. */
export function attachSpendLedger(next: SpendSink): () => void {
  const attachment = { target: next };
  sink = attachment;
  currentDay = "";
  roll(Date.now());
  readTotal();
  return () => {
    if (sink === attachment) sink = undefined;
  };
}

/** The persistence a database-backed sink needs (`MarinaDB` fits). */
export interface SpendLedgerStore {
  addDailySpend(day: string, source: string, usd: number, scope?: string): void;
  getDailySpend(day: string): { cost_usd: number }[];
  getScopeDailySpend(day: string, scope?: string): { scope: string; cost_usd: number }[];
}

/**
 * A sink over a world database: the global and the scope rows are written in
 * one transaction, and totals are read back from the database on each check.
 * With `onError`, a failed write is reported there instead of thrown.
 */
export function dbSpendSink(db: SpendLedgerStore, onError?: (error: unknown) => void): SpendSink {
  return {
    add: (day, source, usd, scope) => {
      try {
        db.addDailySpend(day, source, usd, scope);
      } catch (error) {
        if (!onError) throw error;
        onError(error);
      }
    },
    totalFor: (day) => db.getDailySpend(day).reduce((sum, row) => sum + row.cost_usd, 0),
    scopeTotalFor: (day, scope) =>
      db.getScopeDailySpend(day, scope).reduce((sum, row) => sum + row.cost_usd, 0),
  };
}

/**
 * Count this process's upstream spend in the world database's ledger, so the
 * daily cap (and any `MARINA_SPEND_SCOPE` cap) holds across processes — a
 * timer starts a fresh process each run. Returns the detach function; call it
 * before closing the database.
 */
export function attachDbSpendLedger(db: SpendLedgerStore): () => void {
  return attachSpendLedger(dbSpendSink(db));
}

let warnedInMemory = false;

/**
 * For a command-line process that spends without a world database: the cap is
 * then per process (every run starts at $0). Writes one line to stderr, once
 * per process, and nothing while a ledger is attached.
 */
export function warnInMemorySpend(
  label: string,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): void {
  if (warnedInMemory || sink) return;
  warnedInMemory = true;
  write(
    `warning: ${label} has no world database (DB_PATH) — the daily spend cap is counted per process, not per day`,
  );
}

export function recordSpend(
  source: SpendSource,
  usd: number | undefined,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!usd || !Number.isFinite(usd) || usd <= 0) return;
  roll(now);
  const scope = spendScope(env);
  const name = scope?.valid ? scope.name : undefined;
  today += usd;
  if (name) scopeToday.set(name, (scopeToday.get(name) ?? 0) + usd);
  try {
    sink?.target.add(currentDay, source, usd, name);
  } catch {
    // Persisting is best effort (the engine's sink already logs failures);
    // the best known total still enforces the cap.
  }
}

export function spentTodayUsd(now = Date.now()): number {
  roll(now);
  return readTotal();
}

/** This day's spend under one budget scope (persisted when a ledger is attached). */
export function spentTodayInScopeUsd(scope: string, now = Date.now()): number {
  roll(now);
  return readScopeTotal(scope);
}

/** Every scope's persisted spend today, largest first. */
export function scopeSpendToday(
  db: Pick<SpendLedgerStore, "getScopeDailySpend">,
  now = Date.now(),
): { scope: string; spentUsd: number }[] {
  const by = new Map<string, number>();
  for (const row of db.getScopeDailySpend(utcDay(now))) {
    by.set(row.scope, (by.get(row.scope) ?? 0) + row.cost_usd);
  }
  return [...by]
    .map(([scope, spentUsd]) => ({ scope, spentUsd }))
    .sort((a, b) => b.spentUsd - a.spentUsd || a.scope.localeCompare(b.scope));
}

/** The cap when `MARINA_DAILY_SPEND_CAP_USD` is unset (USD per UTC day, per world). */
export const DEFAULT_DAILY_SPEND_CAP_USD = 50;
/** A child world's cap when `MARINA_CHILD_DAILY_SPEND_CAP_USD` is unset. */
export const DEFAULT_CHILD_DAILY_SPEND_CAP_USD = 50;
/** A budget scope's cap when `MARINA_SPEND_SCOPE_CAP_USD` is unset or junk. */
export const DEFAULT_SPEND_SCOPE_CAP_USD = 50;

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

/** Scope names: a letter or digit, then letters, digits, `.`, `_`, `-`, `:` (≤ 64). */
const SCOPE_NAME = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export type SpendScope = { valid: true; name: string } | { valid: false; raw: string };

/** `MARINA_SPEND_SCOPE`, lower-cased; undefined when unset or blank. */
export function spendScope(env: NodeJS.ProcessEnv = process.env): SpendScope | undefined {
  const raw = env.MARINA_SPEND_SCOPE?.trim();
  if (!raw) return undefined;
  const name = raw.toLowerCase();
  return SCOPE_NAME.test(name) ? { valid: true, name } : { valid: false, raw };
}

/**
 * The scope's daily cap in USD, or undefined when explicitly uncapped
 * (`MARINA_SPEND_SCOPE_CAP_USD=0` or `off`). Unset or junk is
 * {@link DEFAULT_SPEND_SCOPE_CAP_USD}.
 */
export function spendScopeCapUsd(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const cap = parseCap(env.MARINA_SPEND_SCOPE_CAP_USD);
  if (cap === null) return undefined;
  return cap ?? DEFAULT_SPEND_SCOPE_CAP_USD;
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

export interface ScopeSpendState {
  name: string;
  spentUsd: number;
  capUsd?: number;
  reached: boolean;
}

export interface DailySpendState {
  /** The world's total today (every process sharing the database). */
  spentUsd: number;
  capUsd?: number;
  /** The GLOBAL cap is reached. */
  reached: boolean;
  /** This process's budget scope (`MARINA_SPEND_SCOPE`), when one is set and valid. */
  scope?: ScopeSpendState;
  /** `MARINA_SPEND_SCOPE` is set but not a valid name: all spend is refused. */
  invalidScope?: string;
}

export function dailySpend(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): DailySpendState {
  const capUsd = dailySpendCapUsd(env);
  const spentUsd = spentTodayUsd(now);
  const scope = spendScope(env);
  let scopeState: ScopeSpendState | undefined;
  if (scope?.valid) {
    const scopeCap = spendScopeCapUsd(env);
    const scopeSpent = spentTodayInScopeUsd(scope.name, now);
    scopeState = {
      name: scope.name,
      spentUsd: scopeSpent,
      ...(scopeCap ? { capUsd: scopeCap } : {}),
      reached: scopeCap !== undefined && scopeSpent >= scopeCap,
    };
  }
  return {
    spentUsd,
    ...(capUsd ? { capUsd } : {}),
    reached: capUsd !== undefined && spentUsd >= capUsd,
    ...(scopeState ? { scope: scopeState } : {}),
    ...(scope && !scope.valid ? { invalidScope: scope.raw } : {}),
  };
}

/**
 * The tightest budget left today — the global cap or this process's scope cap,
 * whichever has less headroom — for callers that reserve ahead of spending.
 * Undefined when neither is capped.
 */
export function dailyBudget(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): { spentUsd: number; capUsd: number; label: string } | undefined {
  const s = dailySpend(env, now);
  const options: { spentUsd: number; capUsd: number; label: string }[] = [];
  if (s.invalidScope !== undefined) return { spentUsd: 0, capUsd: 0, label: "invalid scope" };
  if (s.capUsd !== undefined)
    options.push({ spentUsd: s.spentUsd, capUsd: s.capUsd, label: "daily" });
  if (s.scope?.capUsd !== undefined) {
    options.push({
      spentUsd: s.scope.spentUsd,
      capUsd: s.scope.capUsd,
      label: `scope ${s.scope.name}`,
    });
  }
  return options.sort((a, b) => a.capUsd - a.spentUsd - (b.capUsd - b.spentUsd))[0];
}

/** The refusal every capped surface uses, or undefined when there is budget left. */
export function dailyCapRefusal(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): string | undefined {
  const s = dailySpend(env, now);
  if (s.invalidScope !== undefined) {
    return `spend refused: MARINA_SPEND_SCOPE=${JSON.stringify(s.invalidScope)} is not a valid scope name (letters, digits, . _ - :, at most 64) — fix it or unset it`;
  }
  if (s.reached) {
    return `daily spend cap reached (${formatSpendUsd(s.spentUsd)} today ≥ ${formatSpendUsd(s.capUsd!)}); resumes at 00:00 UTC — to raise it set MARINA_DAILY_SPEND_CAP_USD=<usd> (or 0 to remove the cap) and restart`;
  }
  if (s.scope?.reached) {
    return `daily spend cap reached for scope ${s.scope.name} (${formatSpendUsd(s.scope.spentUsd)} today ≥ ${formatSpendUsd(s.scope.capUsd!)}); resumes at 00:00 UTC — to raise it set MARINA_SPEND_SCOPE_CAP_USD=<usd> (or 0 to remove the scope cap)`;
  }
  return undefined;
}

/** Dollars with enough digits to see sub-cent spend ($0.00007, not $0.00). */
export function formatSpendUsd(usd: number): string {
  return usd >= 1 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toPrecision(2)}`;
}

export function resetSpendLedgerForTests(): void {
  sink = undefined;
  currentDay = "";
  today = 0;
  scopeToday.clear();
  warnedInMemory = false;
}
