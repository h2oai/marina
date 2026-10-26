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
 *                runs, agents on `marina/*`, any OpenAI client), and an
 *                in-process library call outside forecasting (`src/model`:
 *                lessons, outcome extraction, the web swarm, benchmarks)
 *   agent      — an agent turn priced by its OWN provider; a turn priced from
 *                the proxy's `x-marina-cost-usd` header is already model_api
 *   decision   — a decision backend call that reported a cost, and a
 *                `src/model` call made as a judge
 *   forecast   — forecast / arena analyst and retrieval calls
 *   media      — image / video generation, at the provider's estimated price
 *   search     — a paid search API call
 *
 * Purposes: a `src/model` call also records WHAT it was for (forecast,
 * arena, research, lessons, outcomes, swarm, judge, benchmark, …) as a
 * reserved scope row `purpose:<name>` in `spend_scope_daily`, written in the
 * same transaction as the global row (no schema change: the source CHECK
 * keeps its six values). Purpose rows are a breakdown, never a cap: they are
 * left out of the budget-scope readouts (`scopeSpendToday`) and read with
 * `purposeSpendToday`; `MARINA_SPEND_SCOPE` may not use the `purpose:` prefix.
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
 *
 * Shared ledger: `MARINA_SPEND_LEDGER=<path>` (src/engine/shared-spend-ledger.ts)
 * points several processes — one per world when a host embeds Marina — at
 * ONE ledger file. Spend is recorded there AND in the world database (which
 * keeps the per-world history and per-session cost readers working), but every
 * cap check and every readout reads the shared file, so the cap is enforced on
 * the total of every process sharing it.
 */

import { getErrorMessage } from "./errors";
import { Logger } from "./logger";
import { openSharedSpendLedger, sharedSpendLedgerPath } from "./shared-spend-ledger";

const logger = new Logger();

/** Where a dollar left Marina. `search` is a paid search API call (Tavily, Exa) — migration 158. */
export type SpendSource = "model_api" | "agent" | "decision" | "forecast" | "media" | "search";

export interface SpendSink {
  /** Record `usd` for the day (and, when given, the scope and purpose rows) atomically. */
  add(day: string, source: SpendSource, usd: number, scope?: string, purpose?: string): void;
  /** The world's persisted total for the day, across every process. */
  totalFor(day: string): number;
  /** The persisted total for one scope; absent = the sink keeps no scopes. */
  scopeTotalFor?(day: string, scope: string): number;
  /** Every scope's rows for the day; present when the sink is the shared ledger. */
  scopeRowsFor?(day: string): { scope: string; cost_usd: number }[];
  /** The shared ledger file this sink records into (`MARINA_SPEND_LEDGER`). */
  sharedPath?: string;
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
  const target = isDurable(next) ? next : durableSpendSink(next, "ledger");
  const attachment = { target };
  sink = attachment;
  currentDay = "";
  roll(Date.now());
  readTotal();
  return () => {
    // Last chance for increments a failed write left pending.
    target.flush();
    if (sink === attachment) sink = undefined;
  };
}

/*
 * Money already spent is never dropped. A write that fails on a busy or
 * locked database is retried a few times (bounded, synchronous); one that
 * still fails is kept as a PENDING increment of this process: it is counted
 * in every total the cap and the readouts see (so the cap still bites), and
 * written on the next successful write (or the attachment's release). An
 * entry leaves the pending list only after its write committed — each write
 * is one transaction, so a failed write changed nothing and a retry or a
 * flush never counts a dollar twice. Scope and purpose rows travel with
 * their entry, so they get the same treatment as the global total.
 */
interface PendingSpend {
  day: string;
  source: SpendSource;
  usd: number;
  scope?: string;
  purpose?: string;
}

/** Back-off between attempts at a busy/locked write (ms; ≈ 75 ms in all). */
const BUSY_RETRY_DELAYS_MS = [5, 20, 50] as const;

const defaultRetrySleep = (ms: number): void => Bun.sleepSync(ms);
let retrySleep: (ms: number) => void = defaultRetrySleep;

/** True for SQLite's transient lock errors (another writer holds the database). */
export function isTransientSpendWriteError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)/.test(code)) return true;
  return /database (?:table )?is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(
    getErrorMessage(error),
  );
}

function writeWithRetry(write: () => void): void {
  for (let attempt = 0; ; attempt++) {
    try {
      write();
      return;
    } catch (error) {
      const delay = BUSY_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientSpendWriteError(error)) throw error;
      retrySleep(delay);
    }
  }
}

interface DurableSpendSink extends SpendSink {
  /** Write pending increments; true when none is left. */
  flush(): boolean;
  /** Increments for `day` not yet written to the ledger the cap reads. */
  pendingFor(day: string): PendingSpend[];
}

const durable = new WeakSet<SpendSink>();

function isDurable(s: SpendSink): s is DurableSpendSink {
  return durable.has(s);
}

function sumPending(entries: PendingSpend[], scope?: string): number {
  let usd = 0;
  for (const e of entries) {
    if (scope === undefined || e.scope === scope || e.purpose === scope) usd += e.usd;
  }
  return usd;
}

/** Pending entries as `spend_scope_daily`-shaped rows (scope and purpose rows). */
function pendingScopeRows(entries: PendingSpend[]): { scope: string; cost_usd: number }[] {
  const rows: { scope: string; cost_usd: number }[] = [];
  for (const e of entries) {
    if (e.scope) rows.push({ scope: e.scope, cost_usd: e.usd });
    if (e.purpose) rows.push({ scope: e.purpose, cost_usd: e.usd });
  }
  return rows;
}

function durableSpendSink(
  inner: SpendSink,
  label: string,
  onError?: (error: unknown) => void,
): DurableSpendSink {
  const pending: PendingSpend[] = [];
  const write = (e: PendingSpend) =>
    writeWithRetry(() => inner.add(e.day, e.source, e.usd, e.scope, e.purpose));
  const report = (error: unknown, what: string) => {
    logger.warn("spend", `Daily spend ${what}; kept pending and counted toward the cap`, {
      ledger: label,
      pendingUsd: sumPending(pending),
      pendingWrites: pending.length,
      error: getErrorMessage(error),
    });
    onError?.(error);
  };
  const flush = (): boolean => {
    let written = 0;
    while (pending.length > 0) {
      try {
        write(pending[0]!);
      } catch (error) {
        report(error, "not flushed");
        return false;
      }
      pending.shift();
      written++;
    }
    if (written > 0)
      logger.info("spend", "Pending daily spend written", { ledger: label, written });
    return true;
  };
  const pendingFor = (day: string) => pending.filter((e) => e.day === day);
  const out: DurableSpendSink = {
    add: (day, source, usd, scope, purpose) => {
      const entry: PendingSpend = { day, source, usd, scope, purpose };
      try {
        write(entry);
      } catch (error) {
        pending.push(entry);
        report(error, "not recorded");
        return;
      }
      if (pending.length > 0) flush();
    },
    totalFor: (day) => inner.totalFor(day) + sumPending(pendingFor(day)),
    flush,
    pendingFor,
    ...(inner.sharedPath ? { sharedPath: inner.sharedPath } : {}),
  };
  const scopeTotalFor = inner.scopeTotalFor?.bind(inner);
  if (scopeTotalFor) {
    out.scopeTotalFor = (day, scope) =>
      scopeTotalFor(day, scope) + sumPending(pendingFor(day), scope);
  }
  const scopeRowsFor = inner.scopeRowsFor?.bind(inner);
  if (scopeRowsFor) {
    out.scopeRowsFor = (day) => [...scopeRowsFor(day), ...pendingScopeRows(pendingFor(day))];
  }
  durable.add(out);
  return out;
}

/** This process's unwritten increments for the day, as scope rows (readouts merge them). */
function attachedPendingScopeRows(day: string): { scope: string; cost_usd: number }[] {
  const target = sink?.target;
  return target && isDurable(target) ? pendingScopeRows(target.pendingFor(day)) : [];
}

/** Dollars this process spent today that are not yet written to the ledger the cap reads. */
export function pendingSpendUsd(now = Date.now()): number {
  const target = sink?.target;
  return target && isDurable(target) ? sumPending(target.pendingFor(utcDay(now))) : 0;
}

/** Test hook: replace the synchronous back-off between busy retries (undefined = default). */
export function setSpendRetrySleepForTests(sleep?: (ms: number) => void): void {
  retrySleep = sleep ?? defaultRetrySleep;
}

/** The persistence a database-backed sink needs (`MarinaDB` fits). */
export interface SpendLedgerStore {
  addDailySpend(day: string, source: string, usd: number, scope?: string, purpose?: string): void;
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
    add: (day, source, usd, scope, purpose) => {
      try {
        db.addDailySpend(day, source, usd, scope, purpose);
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
export function attachDbSpendLedger(
  db: SpendLedgerStore,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  return attachWorldSpendLedger(db, { env });
}

export interface WorldSpendLedgerOptions {
  env?: NodeJS.ProcessEnv;
  /** Where a failed write is reported instead of thrown (as `dbSpendSink`). */
  onError?: (error: unknown) => void;
}

/**
 * Attach this process's spend ledger: the world database's (when given) and,
 * with `MARINA_SPEND_LEDGER` set, the shared ledger file too. With the shared
 * file, spend is written to both and totals are read from the shared file, so
 * the cap holds across every process — every world — that names it. Opening
 * the shared file is fail-closed: an unusable `MARINA_SPEND_LEDGER` throws
 * rather than quietly falling back to a per-world cap. Returns the detach
 * function, which also closes the shared file.
 */
export function attachWorldSpendLedger(
  db: SpendLedgerStore | undefined,
  opts: WorldSpendLedgerOptions = {},
): () => void {
  const path = sharedSpendLedgerPath(opts.env ?? process.env);
  if (!path) {
    if (!db) return () => {};
    return attachSpendLedger(durableSpendSink(dbSpendSink(db), "world", opts.onError));
  }
  const shared = openSharedSpendLedger(path);
  // Each ledger keeps its own pending increments, so a write that reached one
  // and not the other is retried only where it failed (never counted twice).
  const sharedSink = durableSpendSink(shared, "shared", opts.onError);
  const world = db ? durableSpendSink(dbSpendSink(db), "world", opts.onError) : undefined;
  const composite: DurableSpendSink = {
    add: (day, source, usd, scope, purpose) => {
      sharedSink.add(day, source, usd, scope);
      // Purpose rows are a per-world breakdown; the shared file keeps totals and caps.
      world?.add(day, source, usd, scope, purpose);
    },
    totalFor: (day) => sharedSink.totalFor(day),
    scopeTotalFor: (day, scope) => sharedSink.scopeTotalFor?.(day, scope) ?? 0,
    scopeRowsFor: (day) => sharedSink.scopeRowsFor?.(day) ?? [],
    sharedPath: shared.path,
    flush: () => {
      const sharedDone = sharedSink.flush();
      const worldDone = world?.flush() ?? true;
      return sharedDone && worldDone;
    },
    // The cap reads the shared file, so its pending entries are the ones that count.
    pendingFor: (day) => sharedSink.pendingFor(day),
  };
  durable.add(composite);
  const release = attachSpendLedger(composite);
  return () => {
    release();
    shared.close();
  };
}

/** The shared ledger file the attached ledger records into, if any. */
export function activeSharedSpendLedger(): string | undefined {
  return sink?.target.sharedPath;
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
  purpose?: string,
): void {
  if (!usd || !Number.isFinite(usd) || usd <= 0) return;
  roll(now);
  const scope = spendScope(env);
  const name = scope?.valid ? scope.name : undefined;
  today += usd;
  if (name) scopeToday.set(name, (scopeToday.get(name) ?? 0) + usd);
  const label = purpose && PURPOSE_NAME.test(purpose) ? `${PURPOSE_PREFIX}${purpose}` : undefined;
  // The attached sink never throws: a failed write stays pending in it and
  // counts toward every total until a later write lands it.
  sink?.target.add(currentDay, source, usd, name, label);
}

/** The reserved scope prefix of a purpose row (`purpose:lessons`). */
export const PURPOSE_PREFIX = "purpose:";
/** Purpose names: lower-case letters, digits, `.`, `_`, `-` (≤ 32). */
const PURPOSE_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/**
 * Record `usd` under `source` AND the purpose it was spent for: the global
 * row once, plus a `purpose:<name>` breakdown row. An invalid purpose name
 * still records the dollar (never drops spend), just without the breakdown.
 */
export function recordPurposeSpend(
  purpose: string,
  source: SpendSource,
  usd: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): void {
  recordSpend(source, usd, now, env, purpose);
}

/** Today's spend per purpose in this world's database, largest first. */
export function purposeSpendToday(
  db: Pick<SpendLedgerStore, "getScopeDailySpend">,
  now = Date.now(),
): { purpose: string; spentUsd: number }[] {
  const by = new Map<string, number>();
  const day = utcDay(now);
  for (const row of [...db.getScopeDailySpend(day), ...attachedPendingScopeRows(day)]) {
    if (!row.scope.startsWith(PURPOSE_PREFIX)) continue;
    const purpose = row.scope.slice(PURPOSE_PREFIX.length);
    by.set(purpose, (by.get(purpose) ?? 0) + row.cost_usd);
  }
  return [...by]
    .map(([purpose, spentUsd]) => ({ purpose, spentUsd }))
    .sort((a, b) => b.spentUsd - a.spentUsd || a.purpose.localeCompare(b.purpose));
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

/**
 * Every scope's persisted spend today, largest first. With the shared ledger
 * attached (`MARINA_SPEND_LEDGER`) this is the shared file's scopes — the
 * totals the caps are checked against — not just this world's.
 */
export function scopeSpendToday(
  db: Pick<SpendLedgerStore, "getScopeDailySpend">,
  now = Date.now(),
): { scope: string; spentUsd: number }[] {
  const by = new Map<string, number>();
  const day = utcDay(now);
  // A sink's own rows already include its pending entries.
  const rows = sink?.target.scopeRowsFor?.(day) ?? [
    ...db.getScopeDailySpend(day),
    ...attachedPendingScopeRows(day),
  ];
  for (const row of rows) {
    // Purpose rows are a breakdown of the world total, not a budget scope.
    if (row.scope.startsWith(PURPOSE_PREFIX)) continue;
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
  // `purpose:` rows are the per-purpose breakdown; a scope may not alias them.
  return SCOPE_NAME.test(name) && !name.startsWith(PURPOSE_PREFIX)
    ? { valid: true, name }
    : { valid: false, raw };
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

/**
 * The spend settings a World Collective child world is started with.
 *
 * Per-world ledger (default): `MARINA_DAILY_SPEND_CAP_USD` =
 * {@link childDailySpendCapEnv} — the child's own database, its own total,
 * never above the parent's cap.
 *
 * Shared ledger (`MARINA_SPEND_LEDGER`, inherited by the child, made absolute
 * because the child runs in another directory): the child records into the
 * SAME file, so its global cap is the parent's (one total, one cap), and its
 * own budget becomes a scope — `child:<name>` capped at
 * {@link childDailySpendCapEnv} — so it still cannot spend more than
 * min(child cap, parent cap) of its own, and the family together cannot pass
 * the parent's cap. A parent running under a scope passes that scope down
 * with its cap lowered to min(child cap, scope cap); a name that cannot be a
 * scope falls back to applying the child cap to the shared total.
 */
export function childSpendEnv(
  childName: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const childCap = childDailySpendCapEnv(env);
  const path = sharedSpendLedgerPath(env);
  if (!path) return { MARINA_DAILY_SPEND_CAP_USD: childCap };
  const parentCap = dailySpendCapUsd(env);
  const shared = {
    MARINA_SPEND_LEDGER: path,
    MARINA_DAILY_SPEND_CAP_USD: parentCap === undefined ? "off" : String(parentCap),
  };
  const own = parseCap(childCap) ?? undefined;
  const parentScope = spendScope(env);
  if (parentScope?.valid) {
    const scopeCap = spendScopeCapUsd(env);
    const capped = [own, scopeCap].filter((v): v is number => v !== undefined);
    return {
      ...shared,
      MARINA_SPEND_SCOPE: parentScope.name,
      MARINA_SPEND_SCOPE_CAP_USD: capped.length ? String(Math.min(...capped)) : "off",
    };
  }
  if (parentScope) return { ...shared, MARINA_DAILY_SPEND_CAP_USD: childCap };
  const slug = childName
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 58);
  const scope = spendScope({ MARINA_SPEND_SCOPE: `child:${slug}` });
  if (!slug || !scope?.valid) return { ...shared, MARINA_DAILY_SPEND_CAP_USD: childCap };
  return {
    ...shared,
    MARINA_SPEND_SCOPE: scope.name,
    MARINA_SPEND_SCOPE_CAP_USD: childCap,
  };
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

/**
 * True when an upstream error says money ran out — Marina's own cap
 * (`spend_cap_reached`, the `dailyCapRefusal` text), a reservation or budget
 * proxy refusing the call, a provider out of credits/quota, or an account/workspace
 * usage limit ("reached your specified workspace API usage limits"). Retrying such a
 * call cannot succeed until the budget changes, unlike a rate limit.
 */
export function isSpendRefusal(message: string): boolean {
  return /spend_cap_reached|spend cap reached|spend refused|budget (?:exhausted|exceeded|reached)|reservation (?:refused|exceeds)|insufficient[_ ](?:credits|quota|funds|balance)|payment required|\b402\b|reached your (?:specified )?(?:\w+ )*usage limits?|usage limits? (?:reached|exceeded)/i.test(
    message,
  );
}

/** Dollars with enough digits to see sub-cent spend ($0.00007, not $0.00). */
export function formatSpendUsd(usd: number): string {
  return usd >= 1 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toPrecision(2)}`;
}

export function resetSpendLedgerForTests(): void {
  sink = undefined;
  retrySleep = defaultRetrySleep;
  currentDay = "";
  today = 0;
  scopeToday.clear();
  warnedInMemory = false;
}
