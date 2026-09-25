// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Civiqs nowcast — structured evidence beats web search where it exists.
 *
 * Civiqs publishes DAILY trackers, but the arena samples them on Fridays: a
 * round's history ends at last Friday, while by its (Wednesday) lock the
 * tracker has already published several newer days. The arena archives every
 * snapshot it fetches (`civiqs/<tracker>[.<filter>]/<YYYY-MM-DD>.json` in its
 * public repo), each holding the daily series up to the day before. Reading
 * only snapshots dated ON OR BEFORE the lock, the freshest daily reading is
 * exactly what any entrant could have known — so this is backtestable with no
 * leakage, and needs no model.
 *
 * Measured on the 7 resolved Civiqs approval rounds (2026-09-25): nowcast mean
 * absolute error 1.14 vs persistence's 1.53; skill +0.153 at sd 1.5.
 */

import type { ArenaData } from "../data";
import type { ArenaRound } from "../types";

type Net = true | { minuend: string[]; subtrahend: string[] };

interface CiviqsSeries {
  name: string;
  filters?: Record<string, string>;
  net?: Net;
  choice?: string;
}

const APPROVAL = "approve_president_trump_2025";
const approval = (filters?: Record<string, string>): CiviqsSeries => ({
  name: APPROVAL,
  net: true,
  ...(filters ? { filters } : {}),
});

/** Mirrors the arena's `ssa/series.py` Civiqs registrations. */
export const CIVIQS_SERIES: Record<string, CiviqsSeries> = {
  civiqs_net_approval: approval(),
  civiqs_net_approval_rep: approval({ party: "Republican" }),
  civiqs_net_approval_dem: approval({ party: "Democrat" }),
  civiqs_net_approval_ind: approval({ party: "Independent" }),
  civiqs_net_approval_age_18_34: approval({ age: "18-34" }),
  civiqs_net_approval_age_35_49: approval({ age: "35-49" }),
  civiqs_net_approval_age_50_64: approval({ age: "50-64" }),
  civiqs_net_approval_age_65_up: approval({ age: "65+" }),
  civiqs_net_approval_race_white: approval({ race: "White" }),
  civiqs_net_approval_race_black: approval({ race: "Black or African-American" }),
  civiqs_net_approval_race_hispanic: approval({ race: "Hispanic/Latino" }),
  civiqs_net_approval_race_other: approval({ race: "Other" }),
  civiqs_net_approval_edu_noncollege: approval({ education: "Non-College Graduate" }),
  civiqs_net_approval_edu_college: approval({ education: "College Graduate" }),
  civiqs_net_approval_edu_postgrad: approval({ education: "Postgraduate" }),
  civiqs_net_approval_male: approval({ gender: "Male" }),
  civiqs_net_approval_female: approval({ gender: "Female" }),
  civiqs_net_econ_now: {
    name: "economy_us_now",
    net: { minuend: ["Very good", "Fairly good"], subtrahend: ["Very bad", "Fairly bad"] },
  },
  civiqs_net_econ_direction: {
    name: "economy_us_direction",
    net: { minuend: ["Getting better"], subtrahend: ["Getting worse"] },
  },
  civiqs_net_family_finances: {
    name: "economy_family_retro",
    net: { minuend: ["Gotten better"], subtrahend: ["Gotten worse"] },
  },
  civiqs_net_inflation_concern: {
    name: "inflation_impact",
    net: {
      minuend: ["Very concerned", "Somewhat concerned"],
      subtrahend: ["Not concerned at all", "A little concerned"],
    },
  },
  civiqs_angry_share: { name: "describe_feeling_us", choice: "Angry" },
};

/** The archive directory for a series (the arena's own naming). */
export function civiqsDir(s: CiviqsSeries): string {
  const suffix = Object.entries(s.filters ?? {})
    .map(([k, v]) => `.${k}-${v.replace(/[^A-Za-z0-9-]/g, "_")}`)
    .join("");
  return `${s.name}${suffix}`;
}

interface Snapshot {
  choices: string[];
  display_net?: { minuend?: string[] | string; subtrahend?: string[] | string };
  end_date?: string;
  points: Array<[string, ...number[]]>;
}

function seriesValue(
  snap: Snapshot,
  point: [string, ...number[]],
  s: CiviqsSeries,
): number | undefined {
  const share = (label: string) => {
    const i = snap.choices.indexOf(label);
    const v = i < 0 ? undefined : point[i + 1];
    return typeof v === "number" ? v : undefined;
  };
  const sum = (labels: string[]) => {
    let total = 0;
    for (const l of labels) {
      const v = share(l);
      if (v === undefined) return undefined;
      total += v;
    }
    return total;
  };
  if (s.choice) return share(s.choice);
  if (!s.net) return undefined;
  const list = (x: string[] | string | undefined) =>
    x === undefined ? [] : Array.isArray(x) ? x : [x];
  const minuend = s.net === true ? list(snap.display_net?.minuend) : s.net.minuend;
  const subtrahend = s.net === true ? list(snap.display_net?.subtrahend) : s.net.subtrahend;
  // Approval declares no display_net: Approve minus Disapprove.
  const plus = sum(minuend.length ? minuend : ["Approve"]);
  const minus = sum(subtrahend.length ? subtrahend : ["Disapprove"]);
  return plus === undefined || minus === undefined
    ? undefined
    : Math.round((plus - minus) * 10) / 10;
}

export interface Nowcast {
  series: string;
  /** Date of the freshest daily reading. */
  date: string;
  value: number;
  /** The snapshot file it came from (dated on or before the lock). */
  snapshot: string;
}

/** The freshest daily reading any entrant could have seen at `asOf` (default: the round's lock). */
export async function civiqsNowcast(
  data: ArenaData,
  round: ArenaRound,
  asOf: string = round.lock_at,
  maxLookbackDays = 6,
): Promise<Nowcast | undefined> {
  const series = round.series ? CIVIQS_SERIES[round.series] : undefined;
  if (!series) return undefined;
  const dir = civiqsDir(series);
  const start = Date.parse(asOf.slice(0, 10));
  for (let back = 0; back <= maxLookbackDays; back++) {
    const day = new Date(start - back * 86_400_000).toISOString().slice(0, 10);
    const snap = await data.civiqsSnapshot(dir, day).catch(() => undefined);
    const point = snap?.points.at(-1);
    if (!snap || !point) continue;
    // A snapshot dated the lock day may have been taken after the lock: only
    // what had been fetched by `asOf` counts.
    const fetchedAt = (snap as { fetched_at?: string }).fetched_at;
    if (fetchedAt && Date.parse(fetchedAt) > Date.parse(asOf)) continue;
    const value = seriesValue(snap as Snapshot, point, series);
    if (value === undefined) return undefined;
    return { series: round.series!, date: point[0], value, snapshot: `civiqs/${dir}/${day}.json` };
  }
  return undefined;
}

/**
 * The baseline, with each Civiqs series' mean moved to its freshest daily
 * reading when that reading is newer than the round's history — for a
 * profile, cell by cell (cells are Civiqs series ids). The spread stays the
 * baseline's. Every other round is the baseline unchanged.
 */
export function nowcastForecaster(
  data: ArenaData,
  base: (
    round: ArenaRound,
    lock: import("../types").ArenaLock,
  ) => import("../forecast").RoundForecast,
) {
  return async (round: ArenaRound, lock: import("../types").ArenaLock) => {
    if (round.target_type === "ranking_list" && round.tracker === "wikipedia") {
      // Fuller, fresher inputs than the lock carries: the archived daily lists
      // fetched before the lock, three weeks back.
      const obs = await wikitopObservations(data, round);
      if (obs.length) return base(round, { ...lock, answer_obs: obs });
    }
    // Trends re-normalises its index per snapshot, so the lock's own frozen
    // history (what the persistence null reads) wins; the archive only fills in
    // for a lock that carries none.
    if (
      round.tracker === "google_trends" &&
      round.target_type === "profile_energy" &&
      !lock.answer_history_by_cell
    ) {
      const byCell = await trendsBasketHistory(data, round, TRENDS_INCLUDE_PARTIAL);
      if (byCell) return base(round, { ...lock, answer_history_by_cell: byCell });
    }
    const f = base(round, lock);
    if (round.tracker !== "civiqs") return f;
    const fresher = async (seriesId: string, lastDate: string | undefined) => {
      const n = await civiqsNowcast(data, { ...round, series: seriesId });
      return n && (!lastDate || n.date > lastDate) ? n : undefined;
    };
    const used: Record<string, { date: string; value: number }> = {};
    if (f.topline && round.series) {
      const history = lock.answer_history ?? lock.history ?? [];
      const n = await fresher(round.series, history.at(-1)?.date);
      if (n) {
        used[round.series] = { date: n.date, value: n.value };
        return {
          ...f,
          topline: { mean: n.value, sd: f.topline.sd },
          note: `${f.note}; Civiqs daily nowcast ${n.date}`,
          nowcast: used,
        };
      }
      return f;
    }
    if (f.profile) {
      const profile = { ...f.profile };
      for (const cell of Object.keys(profile)) {
        const n = await fresher(cell, lock.answer_history_by_cell?.[cell]?.at(-1)?.date);
        if (n) {
          profile[cell] = { mean: n.value, sd: profile[cell]!.sd };
          used[cell] = { date: n.date, value: n.value };
        }
      }
      return Object.keys(used).length
        ? { ...f, profile, note: `${f.note}; Civiqs daily nowcast`, nowcast: used }
        : f;
    }
    return f;
  };
}

/**
 * Daily top lists from the arena's `wikitop/` archive that were PUBLISHED
 * before the lock. Unlike Civiqs (revised nightly, so only snapshots fetched
 * before the lock count), a day's pageview list is final once Wikimedia
 * publishes it about a day later — and the archive was partly backfilled, so
 * its fetch times say when the arena looked, not when the data existed. The
 * rule is therefore publication: days at least `WIKITOP_PUBLICATION_LAG_DAYS`
 * before the lock day, which matches what the arena's own lock files carry.
 */
export const WIKITOP_PUBLICATION_LAG_DAYS = 2;

/** Whether a Trends basket's current partial week counts as its latest reading. */
export const TRENDS_INCLUDE_PARTIAL = process.env.MARINA_ARENA_TRENDS_PARTIAL === "on";

export async function wikitopObservations(
  data: ArenaData,
  round: ArenaRound,
  daysBack = 21,
): Promise<Array<{ date: string; items: string[]; views: Record<string, number> }>> {
  const spec = round.ranking as { project?: string; access?: string } | undefined;
  const dir = `${spec?.project ?? "en.wikipedia"}.${spec?.access ?? "all-access"}`;
  const lockDay = Date.parse(round.lock_at.slice(0, 10));
  const days = Array.from({ length: daysBack }, (_, k) =>
    new Date(lockDay - (k + WIKITOP_PUBLICATION_LAG_DAYS) * 86_400_000).toISOString().slice(0, 10),
  );
  const got = await Promise.all(days.map((d) => data.wikitopDay(dir, d).catch(() => undefined)));
  return got
    .filter((d): d is NonNullable<typeof d> => !!d)
    .map((d) => {
      const items = Object.entries(d.articles)
        .sort((a, b) => b[1] - a[1])
        .map(([t]) => t);
      return { date: d.day, items, views: d.articles };
    });
}

/**
 * Per-brand share history for a Google Trends basket round, from the arena's
 * `trends/basket.<queries>.geo-US/` snapshots: the newest one FETCHED before
 * the lock (Trends rescales its index, so fetch time is the honest rule).
 * Each week's five values become shares of their sum, in percent — the
 * quantity the round resolves on. `includePartial` adds the current,
 * incomplete week as the latest point.
 */
export async function trendsBasketHistory(
  data: ArenaData,
  round: ArenaRound,
  includePartial: boolean,
  maxLookbackDays = 6,
): Promise<Record<string, Array<{ date: string; value: number }>> | undefined> {
  const cells = round.cells ?? [];
  if (round.tracker !== "google_trends" || cells.length < 2) return undefined;
  const lock = Date.parse(round.lock_at);
  for (let back = 0; back <= maxLookbackDays; back++) {
    const day = new Date(lock - back * 86_400_000).toISOString().slice(0, 10);
    for (const dir of await data.trendsBasketDirs()) {
      const snap = await data.trendsSnapshot(dir, day).catch(() => undefined);
      if (!snap || (snap.fetched_at && Date.parse(snap.fetched_at) > lock)) continue;
      const order = snap.queries.map((q) => `trends_share_${q.toLowerCase()}`);
      if (!cells.every((c) => order.includes(c))) continue;
      const out: Record<string, Array<{ date: string; value: number }>> = Object.fromEntries(
        cells.map((c) => [c, []]),
      );
      for (const [, end, values, partial] of snap.points) {
        if (partial && !includePartial) continue;
        const total = values.reduce((a, b) => a + b, 0);
        if (total <= 0) continue;
        order.forEach((cell, i) => {
          out[cell]?.push({ date: end, value: Math.round((10_000 * values[i]!) / total) / 100 });
        });
      }
      return out;
    }
  }
  return undefined;
}
