// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ArenaData } from "./data";
import type { ArenaLock, ArenaPoint, ArenaRound } from "./types";

const dateOnly = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

export interface InputAudit {
  ok: boolean;
  issues: string[];
  warnings: string[];
  identity: { tracker: string; series?: string; unit?: string; cells?: string[] };
  histories: Record<string, { count: number; first?: string; last?: string; ageDays?: number }>;
}

/** Audit the exact pollster/series/cell history consumed by the forecaster. */
export function auditForecastInputs(round: ArenaRound, lock: ArenaLock): InputAudit {
  const issues: string[] = [];
  const warnings: string[] = [];
  if (lock.round_id !== round.round_id) issues.push("lock belongs to a different round");
  if (lock.series && round.series && lock.series !== round.series)
    issues.push("lock series disagrees with target");
  if (
    lock.observed_at &&
    (!Number.isFinite(Date.parse(lock.observed_at)) ||
      Date.parse(lock.observed_at) > Date.parse(round.lock_at))
  )
    issues.push("input observation is invalid or after lock");
  if (!Number.isFinite(Date.parse(round.lock_at)) || !Number.isFinite(Date.parse(round.release_at)))
    issues.push("invalid round cutoff or release");
  if (lock.lock_at && Date.parse(lock.lock_at) !== Date.parse(round.lock_at))
    issues.push("lock cutoff disagrees with round");
  if (
    lock.answer_frozen_at &&
    (!Number.isFinite(Date.parse(lock.answer_frozen_at)) ||
      Date.parse(lock.answer_frozen_at) > Date.parse(round.lock_at))
  )
    issues.push("input freeze is invalid or after lock");
  const series: Record<string, ArenaPoint[]> =
    round.target_type === "profile_energy"
      ? Object.fromEntries(
          (round.cells ?? []).map((c) => [c, lock.answer_history_by_cell?.[c] ?? []]),
        )
      : round.target_type === "continuous_normal"
        ? { [round.series ?? "topline"]: lock.answer_history ?? lock.history ?? [] }
        : {};
  const histories: InputAudit["histories"] = {};
  for (const [name, points] of Object.entries(series)) {
    histories[name] = { count: points.length, first: points[0]?.date, last: points.at(-1)?.date };
    const last = points.at(-1);
    if (last && dateOnly(last.date)) {
      const age = Math.floor((Date.parse(round.lock_at) - Date.parse(last.date)) / 86_400_000);
      histories[name]!.ageDays = age;
      const gaps = points
        .slice(1)
        .map((p, i) => (Date.parse(p.date) - Date.parse(points[i]!.date)) / 86_400_000)
        .filter((g) => Number.isFinite(g) && g > 0)
        .sort((a, b) => a - b);
      const cadence = gaps[Math.floor(gaps.length / 2)];
      if (cadence && age > Math.max(7, cadence * 2))
        warnings.push(
          `${name}: latest observation is ${age} days old at lock, beyond two typical releases`,
        );
    }
    if (!points.length) issues.push(`${name}: missing target history`);
    if (points.length > 0 && points.length < 6)
      warnings.push(`${name}: fewer than six observations`);
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (
        !dateOnly(p.date) ||
        !Number.isFinite(p.value) ||
        (i > 0 && p.date <= points[i - 1]!.date)
      ) {
        issues.push(`${name}: non-finite value or invalid/duplicate/unordered date`);
        break;
      }
      if (Date.parse(p.date) > Date.parse(round.lock_at)) {
        // Trends dates label the period end, not publication. An opted-in
        // partial week may end after lock; its snapshot fetch time is the gate.
        if (round.tracker === "google_trends") {
          warnings.push(
            `${name}: future period-end label; verify partial-week policy and snapshot fetch time`,
          );
          continue;
        }
        issues.push(`${name}: observation after cutoff`);
        break;
      }
    }
  }
  if (round.tracker === "google_trends" && round.target_type === "profile_energy") {
    const cells = round.cells ?? [];
    const rows = Object.values(series);
    if (cells.length < 2 || new Set(cells).size !== cells.length)
      issues.push("invalid basket cells");
    const dates = rows[0]?.map((p) => p.date) ?? [];
    if (rows.some((r) => r.length !== dates.length || r.some((p, i) => p.date !== dates[i])))
      issues.push("basket cells have mismatched observation dates");
    for (let i = 0; i < dates.length; i++) {
      const values = rows.map((r) => r[i]?.value ?? Number.NaN);
      if (
        values.some((v) => !Number.isFinite(v) || v < 0 || v > 100) ||
        Math.abs(values.reduce((a, b) => a + b, 0) - 100) > cells.length * 0.005 + 1e-8
      ) {
        issues.push("basket shares do not form one complete 100-percent composition");
        break;
      }
    }
  }
  if (round.tracker.includes("yougov"))
    warnings.push(
      "YouGov target population and wording remain authoritative; other pollsters supply changes, never replacement levels",
    );
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    identity: {
      tracker: round.tracker,
      series: round.series,
      unit: round.unit,
      cells: round.cells,
    },
    histories,
  };
}

/** One comparison request, one denominator, one vintage. Reject malformed snapshots whole. */
export function auditedTrendsHistory(
  round: ArenaRound,
  snapshot: NonNullable<Awaited<ReturnType<ArenaData["trendsSnapshot"]>>>,
  includePartial: boolean,
): Record<string, ArenaPoint[]> | undefined {
  const cells = round.cells ?? [];
  if (
    !snapshot.fetched_at ||
    !Number.isFinite(Date.parse(snapshot.fetched_at)) ||
    Date.parse(snapshot.fetched_at) > Date.parse(round.lock_at) ||
    !Array.isArray(snapshot.queries) ||
    !Array.isArray(snapshot.points)
  )
    return undefined;
  const order = snapshot.queries.map((q) =>
    typeof q === "string" ? `trends_share_${q.toLowerCase()}` : "",
  );
  if (
    cells.length < 2 ||
    cells.length !== order.length ||
    new Set(order).size !== order.length ||
    new Set(cells).size !== cells.length ||
    !cells.every((c) => order.includes(c))
  )
    return undefined;
  const out: Record<string, ArenaPoint[]> = Object.fromEntries(cells.map((c) => [c, []]));
  let previous = "";
  for (const point of snapshot.points) {
    if (!Array.isArray(point) || point.length !== 4) return undefined;
    const [start, end, values, partial] = point;
    if (
      !dateOnly(start) ||
      !dateOnly(end) ||
      start > end ||
      end <= previous ||
      typeof partial !== "boolean" ||
      !Array.isArray(values) ||
      values.length !== cells.length ||
      values.some((v) => !Number.isFinite(v) || v < 0 || v > 100)
    )
      return undefined;
    previous = end;
    if (partial && !includePartial) continue;
    // Partial weeks may end after fetch; complete weeks may not.
    if (
      Date.parse(start) > Date.parse(snapshot.fetched_at) ||
      (!partial && Date.parse(end) > Date.parse(snapshot.fetched_at))
    )
      return undefined;
    const total = values.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    order.forEach((c, i) => {
      out[c]!.push({ date: end, value: Math.round((10_000 * values[i]!) / total) / 100 });
    });
  }
  return out[cells[0]!]!.length ? out : undefined;
}
