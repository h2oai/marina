// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The watcher's cadence for one FutureX batch, as pure functions over the
 * batch, its standing answers and its run schedule (`out/<sha>/schedule.json`):
 *
 *   - `batchDeadline`: the batch's submission deadline, derived from the batch
 *     itself — never from when this machine happened to fetch it;
 *   - `scheduleState`: when the last run started and whether one is still
 *     running (a run is recorded when it STARTS and marked when it ends);
 *   - `dailyRows`: which open rows a daily re-forecast touches.
 *
 * The cadence itself (`dueRun`) and the revision rule are generic
 * (`src/forecast/revision.ts`).
 */

import { nextWeeklyDeadline, type StandingAnswer } from "../../src/forecast/revision";
import type { FuturexBatch, FuturexRow } from "./dataset";
import { endTimeIso } from "./map";

/** FutureX's weekly submission deadline: Wednesday 16:00 UTC. */
export const DEADLINE_WEEKDAY = 3;
export const DEADLINE_HOUR_UTC = 16;

export interface ScheduleEntry {
  /** ISO time the run started. */
  at: string;
  kind: string;
  variants: string[];
  /** `running` from the start until the run ends; absent on entries written before it existed. */
  status?: "running" | "done" | "failed";
  finishedAt?: string;
  /** Rows forecast per variant. */
  rows?: Record<string, number>;
  error?: string;
}

export interface Schedule {
  runs: ScheduleEntry[];
}

const endMs = (r: FuturexRow) => Date.parse(endTimeIso(r.end_time) ?? "") || 0;

/**
 * The batch's deadline: the first weekly deadline (Wednesday 16:00 UTC) strictly
 * after the batch was PUBLISHED — the Hugging Face commit time of its sha — and
 * never later than its last row's end time (a deadline after every question has
 * closed is no deadline). A batch saved before the publication time was recorded
 * falls back to when it was first fetched. A batch first seen after its deadline
 * therefore has a deadline in the past and gets no daily re-forecasts.
 */
export function batchDeadline(
  batch: Pick<FuturexBatch, "fetchedAt" | "publishedAt" | "rows">,
  weekday = DEADLINE_WEEKDAY,
  hourUtc = DEADLINE_HOUR_UTC,
): { deadline: Date; basis: "published" | "fetched"; boundedByEnd: boolean } {
  const basis = batch.publishedAt ? "published" : "fetched";
  const anchor = new Date(batch.publishedAt ?? batch.fetchedAt);
  const weekly = nextWeeklyDeadline(anchor, weekday, hourUtc);
  const lastEnd = Math.max(0, ...batch.rows.map(endMs));
  if (lastEnd > 0 && lastEnd < weekly.getTime()) {
    return { deadline: new Date(lastEnd), basis, boundedByEnd: true };
  }
  return { deadline: weekly, basis, boundedByEnd: false };
}

/**
 * Where the schedule stands at `now`: when the last run started (finished or
 * not — an abandoned run still used its slot) and, when the last run never
 * recorded its end, when it started (`dueRun` treats it as in progress for a
 * few hours).
 */
export function scheduleState(schedule: Schedule): {
  lastRunAt?: string;
  inProgressSince?: string;
} {
  const last = schedule.runs.at(-1);
  if (!last) return {};
  return {
    lastRunAt: last.at,
    ...(last.status === "running" ? { inProgressSince: last.at } : {}),
  };
}

export type DailyRowsMode = "all" | "stale";
export const DAILY_ROWS_MODES: readonly DailyRowsMode[] = ["all", "stale"];

const noAnswer = (a: StandingAnswer | undefined) =>
  !a || a.fallback === true || a.prediction.trim() === "";

/**
 * The rows a daily re-forecast touches. Only open rows (end time after `now`)
 * are ever re-forecast; `all` takes every one of them, `stale` only those whose
 * standing answer is missing or a fallback, or whose end time is within
 * `nearEndMs` of now (the last chance to revise it on fresh news). Revision
 * semantics are unchanged: whatever is re-forecast still replaces a standing
 * answer only on a material change.
 */
export function dailyRows(
  rows: readonly FuturexRow[],
  standing: Readonly<Record<string, StandingAnswer>>,
  now: Date,
  opts: { mode: DailyRowsMode; nearEndMs: number },
): FuturexRow[] {
  const t = now.getTime();
  const open = rows.filter((r) => endMs(r) > t);
  if (opts.mode === "all") return open;
  return open.filter((r) => noAnswer(standing[r.id]) || endMs(r) - t <= opts.nearEndMs);
}

/**
 * When the watcher answers (`--answer`, 2026-10-20):
 *   - `early` (the `watch` default): a new batch is forecast at once, then
 *     re-forecast daily (`--daily`) and once before the deadline;
 *   - `late`: nothing runs when the batch arrives. Each open row is answered
 *     ONCE, inside `--final-lead-hours` of its own cutoff — the batch deadline,
 *     or the row's end time when that comes first — so the answer sees as much
 *     news as possible and costs one forecast per row. A row whose answer is
 *     missing or a fallback is retried on the next check inside its window.
 */
export type AnswerTiming = "early" | "late";
export const ANSWER_TIMINGS: readonly AnswerTiming[] = ["early", "late"];

/** The rows a `late` pass answers at `now` (open, unanswered, inside their lead window). */
export function lateRows(
  rows: readonly FuturexRow[],
  standing: Readonly<Record<string, StandingAnswer>>,
  now: Date,
  opts: { deadline: Date; leadMs: number },
): FuturexRow[] {
  const t = now.getTime();
  const deadline = opts.deadline.getTime();
  if (t >= deadline) return [];
  return rows.filter((r) => {
    const end = endMs(r);
    if (end <= t || !noAnswer(standing[r.id])) return false;
    const cutoff = end > 0 ? Math.min(end, deadline) : deadline;
    return cutoff - t <= opts.leadMs;
  });
}

export interface FuturexUnitOptions {
  /** Repository checkout the unit runs from (absolute). */
  repo: string;
  /** Bun binary (absolute). */
  bun: string;
  /** `.env` passed to bun (absolute), or undefined for none. */
  envFile?: string;
  /** Data directory for batches and outputs (absolute). */
  dir: string;
  /** Comma-separated variant labels (`--run`). */
  run: string;
  /** `--variants <file.json>` (absolute), when the labels are not built-ins. */
  variantsFile?: string;
  answer: AnswerTiming;
  finalLeadHours: number;
  /** MARINA_SPEND_SCOPE_CAP_USD for the unit's own spend scope (must be > 0). */
  scopeCapUsd: number;
  /** World database for the spend ledger and submissions (DB_PATH), absolute. */
  dbPath?: string;
  learn: boolean;
  /** Unit base name (`<name>.service` / `<name>.timer`). */
  name: string;
}

/** systemd escaping for one ExecStart argument (spaces, quotes, `%`). */
function systemdArg(arg: string): string {
  const escaped = arg.replaceAll("%", "%%");
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

/**
 * A systemd user service + hourly timer for the watcher. Text only: nothing
 * is installed or enabled here (`bun run futurex schedule` prints it, or
 * writes it to `--out`); the operator decides whether to activate it. The
 * timer is `Persistent=` so a check missed while the machine slept runs on
 * wake, and the service carries its own capped spend scope.
 */
export function futurexSystemdUnits(o: FuturexUnitOptions): { service: string; timer: string } {
  if (!(o.scopeCapUsd > 0))
    throw new Error("scopeCapUsd must be > 0 (an uncapped timer is refused)");
  const args = [
    o.bun,
    ...(o.envFile ? [`--env-file=${o.envFile}`] : []),
    "scripts/futurex.ts",
    "watch",
    "--once",
    "--answer",
    o.answer,
    ...(o.answer === "early" ? ["--daily"] : []),
    "--final-lead-hours",
    String(o.finalLeadHours),
    "--run",
    o.run,
    "--dir",
    o.dir,
    ...(o.variantsFile ? ["--variants", o.variantsFile] : []),
    ...(o.learn ? ["--learn"] : []),
  ];
  const when =
    o.answer === "late"
      ? `answers each row once, within ${o.finalLeadHours} h of its cutoff`
      : `answers new batches at once, re-forecasts daily and ${o.finalLeadHours} h before the deadline`;
  const service = [
    "[Unit]",
    `Description=Marina FutureX watcher (${when})`,
    `Documentation=file://${o.repo}/docs/guides/futurex.md`,
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${o.repo}`,
    `Environment=MARINA_SPEND_SCOPE=${o.name}`,
    `Environment=MARINA_SPEND_SCOPE_CAP_USD=${o.scopeCapUsd}`,
    ...(o.dbPath ? [`Environment=DB_PATH=${o.dbPath}`] : []),
    `ExecStart=${args.map(systemdArg).join(" ")}`,
    "TimeoutStartSec=6h",
    "Nice=10",
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    `Description=Hourly check for ${o.name}.service`,
    "",
    "[Timer]",
    "OnCalendar=hourly",
    "RandomizedDelaySec=5m",
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return { service, timer };
}
