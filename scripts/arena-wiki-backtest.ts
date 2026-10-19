// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Walk-forward backtest of the Wikipedia top-10 forecasters on reconstructed
 * weeks (src/arena/wiki-specialist.ts). Offline: reads a directory of daily
 * top lists (`<YYYY-MM-DD>.json` holding `{articles: {title: views}}`, the
 * arena's `wikitop/en.wikipedia.all-access/` format) and, optionally, the
 * arena's `site/data.json` to compare the reconstructed outcomes with the
 * resolved rounds.
 *
 * Each target week ending Sunday E is set up as the arena does it: lock the
 * Friday E − 9 at 14:00 UTC, newest readable list lock day − 2 (E − 11),
 * persistence the week ending E − 14. Scored by mean per-round skill
 * (1 − RBO loss ÷ persistence RBO loss, p = 0.9).
 *
 *   bun run scripts/arena-wiki-backtest.ts --dir <wikitop dir> [--site data.json] [--grid]
 */

import { readdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { rankingScores } from "../src/arena/forecast";
import { WIKITOP_PUBLICATION_LAG_DAYS } from "../src/arena/research/civiqs-nowcast";
import {
  type DailyTop,
  DEFAULT_SPECIALIST_PARAMS,
  persistenceWeekEnd,
  rankingSkill,
  type SpecialistParams,
  specialistRanking,
  weeklyTop,
} from "../src/arena/wiki-specialist";

const DAY_MS = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS);

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    dir: { type: "string" },
    site: { type: "string" },
    grid: { type: "boolean" },
    params: { type: "string" },
    "min-train": { type: "string" },
  },
});
if (!values.dir) throw new Error("usage: --dir <wikitop dir> [--site data.json] [--grid]");
const dir = values.dir;
const days: DailyTop[] = readdirSync(dir)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort()
  .map((f) => {
    const body = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as {
      articles: Record<string, number>;
    };
    return { date: f.slice(0, 10), articles: body.articles };
  });

interface Week {
  weekEnd: string;
  lockAt: string;
  lastDay: string;
  truth: string[];
  persistence: string[];
}
const weeks: Week[] = [];
const first = days[0]!.date;
const last = days.at(-1)!.date;
for (let e = addDays(first, 42); e <= last; e = addDays(e, 1)) {
  if (new Date(`${e}T00:00:00Z`).getUTCDay() !== 0) continue;
  const lockAt = `${addDays(e, -9)}T14:00:00Z`;
  const lastDay = addDays(lockAt.slice(0, 10), -WIKITOP_PUBLICATION_LAG_DAYS);
  if (addDays(lastDay, -27) < first) continue;
  try {
    weeks.push({
      weekEnd: e,
      lockAt,
      lastDay,
      truth: weeklyTop(days, e),
      persistence: weeklyTop(days, persistenceWeekEnd(lockAt)),
    });
  } catch {
    // allow-empty-catch: a week the directory does not hold all seven days of is not scored
  }
}

function nowcast(w: Week): string[] {
  const obs = days
    .filter((d) => d.date <= w.lastDay && d.date > addDays(w.lastDay, -21))
    .map((d) => ({
      date: d.date,
      items: Object.keys(d.articles).sort((a, b) => d.articles[b]! - d.articles[a]!),
      views: d.articles,
    }));
  return rankingScores({ round_id: w.weekEnd, answer_obs: obs })
    .slice(0, 10)
    .map(([t]) => t);
}

function specialist(w: Week, params: Partial<SpecialistParams>): string[] {
  return specialistRanking(days, { weekEnd: w.weekEnd, lastDay: w.lastDay, params }).ranking;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const skillOf = (w: Week, list: string[]) => rankingSkill(list, w.truth, w.persistence);

// Hyper-parameter grid for the walk-forward selection.
const grid: Array<Partial<SpecialistParams>> = [];
for (const halfLifeDays of [3, 5, 8, 12, 20])
  for (const pageWeight of [0.5, 0.75, 1])
    for (const levelDays of [1, 2])
      for (const baseQuantile of [0.1, 0.25, 0.5])
        for (const risk of [0, 0.15, 0.3])
          for (const dayOfWeek of [false, true])
            grid.push({ halfLifeDays, pageWeight, levelDays, baseQuantile, risk, dayOfWeek });

const cache = new Map<string, number[]>();
function gridSkills(params: Partial<SpecialistParams>): number[] {
  const key = JSON.stringify(params);
  let got = cache.get(key);
  if (!got) {
    got = weeks.map((w) => skillOf(w, specialist(w, params)));
    cache.set(key, got);
  }
  return got;
}

/** Oracle ceiling of a scheduled-event channel: up to 3 true entrants absent from the candidates' top 30 replace the lowest slots. */
function oracleEvents(w: Week, params: Partial<SpecialistParams>): string[] {
  const r = specialistRanking(days, { weekEnd: w.weekEnd, lastDay: w.lastDay, params });
  const top30 = new Set(r.scored.slice(0, 30).map((s) => s.title));
  const unseen = w.truth.filter((t) => !top30.has(t)).slice(0, 3);
  const list = r.ranking.slice(0, 10 - unseen.length);
  return [...list, ...unseen];
}

const rows: Array<Record<string, string | number>> = [];
const minTrain = Number(values["min-train"] ?? 12);
const wf: number[] = [];
const chosen: string[] = [];
if (values.grid) {
  for (let k = 0; k < weeks.length; k++) {
    if (k < minTrain) continue;
    let best = grid[0]!;
    let bestSkill = -Infinity;
    for (const g of grid) {
      const s = mean(gridSkills(g).slice(0, k));
      if (s > bestSkill) {
        bestSkill = s;
        best = g;
      }
    }
    wf.push(gridSkills(best)[k]!);
    chosen.push(JSON.stringify(best));
  }
  const ranked = grid
    .map((g) => ({ g, s: mean(gridSkills(g)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 8);
  console.log("best in-sample settings:");
  for (const r of ranked) console.log(`  ${r.s.toFixed(4)}  ${JSON.stringify(r.g)}`);
  const counts = new Map<string, number>();
  for (const c of chosen) counts.set(c, (counts.get(c) ?? 0) + 1);
  console.log("walk-forward picks:", [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4));
}

const pers = weeks.map(() => 0);
const now = weeks.map((w) => skillOf(w, nowcast(w)));
/** `--params '{"halfLifeDays":8}'` evaluates a setting other than the defaults. */
const chosenParams: SpecialistParams = {
  ...DEFAULT_SPECIALIST_PARAMS,
  ...(values.params ? (JSON.parse(values.params) as Partial<SpecialistParams>) : {}),
};
const spec = weeks.map((w) => skillOf(w, specialist(w, chosenParams)));
const oracle = weeks.map((w) => skillOf(w, oracleEvents(w, chosenParams)));
for (let i = 0; i < weeks.length; i++) {
  rows.push({
    week: weeks[i]!.weekEnd,
    nowcast: now[i]!.toFixed(3),
    specialist: spec[i]!.toFixed(3),
    oracleEvents: oracle[i]!.toFixed(3),
  });
}
if (process.env.WIKI_BT_VERBOSE) console.table(rows);
const tail = (xs: number[], n: number) => xs.slice(-n);
const summary = (label: string, xs: number[]) =>
  `${label.padEnd(34)} all ${mean(xs).toFixed(4)} (n=${xs.length})  last 26 ${mean(tail(xs, 26)).toFixed(4)}  last 6 ${mean(tail(xs, 6)).toFixed(4)}  wins vs nowcast ${xs.filter((x, i) => x > now[i]!).length}/${xs.length}`;
console.log(`weeks ${weeks[0]?.weekEnd} … ${weeks.at(-1)?.weekEnd}`);
console.log(summary("persistence (arena null)", pers));
console.log(summary("nowcast (recency, half-life 3 d)", now));
console.log(summary("specialist (defaults)", spec));
console.log(summary("specialist + oracle events (ceiling)", oracle));
if (wf.length) {
  const nowWf = now.slice(minTrain);
  console.log(
    `walk-forward specialist (grid re-chosen weekly) ${mean(wf).toFixed(4)} vs nowcast ${mean(nowWf).toFixed(4)} on the same ${wf.length} weeks`,
  );
}

if (values.site) {
  const site = JSON.parse(readFileSync(values.site, "utf8")) as {
    ranking?: {
      rounds?: Array<{
        round_id: string;
        kind: string;
        outcome: string[];
        persistence_items: string[];
        entries: Array<{ entrant: string; skill: number }>;
      }>;
    };
  };
  const arena = (site.ranking?.rounds ?? []).filter((r) => r.kind === "wiki_top10");
  console.log("\narena resolved rounds:");
  const cols: Record<string, number[]> = { nowcast: [], specialist: [], best: [], marina: [] };
  for (const r of arena) {
    const weekEnd = r.round_id.slice("wiki-top10-".length);
    const w = weeks.find((x) => x.weekEnd === weekEnd);
    if (!w) continue;
    const same =
      JSON.stringify(w.truth) === JSON.stringify(r.outcome) &&
      JSON.stringify(w.persistence) === JSON.stringify(r.persistence_items);
    const best = Math.max(...r.entries.map((e) => e.skill));
    const marina = r.entries.find((e) => e.entrant === "h2oai-marina")?.skill;
    const n = skillOf(w, nowcast(w));
    const s = skillOf(w, specialist(w, chosenParams));
    cols.nowcast!.push(n);
    cols.specialist!.push(s);
    cols.best!.push(best);
    if (marina !== undefined) cols.marina!.push(marina);
    console.log(
      `  ${r.round_id}  reconstruction ${same ? "matches" : "DIFFERS"}  nowcast ${n.toFixed(3)}  specialist ${s.toFixed(3)}  best entrant ${best.toFixed(3)}${marina !== undefined ? `  marina filed ${marina.toFixed(3)}` : ""}`,
    );
  }
  console.log(
    `  mean: nowcast ${mean(cols.nowcast!).toFixed(4)}  specialist ${mean(cols.specialist!).toFixed(4)}  best entrant per round ${mean(cols.best!).toFixed(4)}`,
  );
}
