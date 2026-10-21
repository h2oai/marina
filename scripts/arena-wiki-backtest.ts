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
 *     [--entrant <id>]   (whose filed skill `--site` compares; default MARINA_ARENA_ENTRANT,
 *                        none: the column is left out)
 *     [--out items.jsonl] [--features <label>=<file>[+<file>…][,…]] [--adjust '{…}']
 *
 * `--out` writes one JSON line per week and variant — `{id, score, at,
 * variant, group: "arena-wikipedia", exclude?}` plus diagnostics (loss,
 * persistence loss, hits, unseen entrants, the ranking) — for the transfer
 * report's `items` adapter; the text output is unchanged. `--features` scores
 * the attention extractors' records (`scripts/arena-wiki-extract.ts`) through
 * the explicit adjustments (src/arena/extraction/adjust.ts) as the variant
 * `specialist+<label>`, fixed parameters (`DEFAULT_ADJUST_PARAMS`, `--adjust`
 * overrides) and, with `--grid`, elasticities re-chosen weekly on earlier
 * weeks only (`specialist+<label>/wf`); a week the extractors did not cover is
 * written with `exclude: "not extracted"`.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  type AdjustParams,
  type AttentionFeature,
  applyAdjustments,
  DEFAULT_ADJUST_PARAMS,
} from "../src/arena/extraction";
import { rankingScores } from "../src/arena/forecast";
import { WIKITOP_PUBLICATION_LAG_DAYS } from "../src/arena/research/civiqs-nowcast";
import { rboLoss } from "../src/arena/score-shapes";
import {
  type DailyTop,
  DEFAULT_SPECIALIST_PARAMS,
  persistenceWeekEnd,
  rankingSkill,
  type SpecialistParams,
  specialistRanking,
  weeklyTop,
} from "../src/arena/wiki-specialist";
import { lcg32, percentileFloor, resampleMeans } from "../src/stats";

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
    out: { type: "string" },
    features: { type: "string" },
    adjust: { type: "string" },
    entrant: { type: "string" },
  },
});
/** Whose filed rounds `--site` compares with: the configured entrant, never a built-in one. */
const entrant = (values.entrant ?? process.env.MARINA_ARENA_ENTRANT ?? "").trim() || undefined;
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

// ─── Extraction variants and per-item output ────────────────────────────────

/** Seeded paired bootstrap 95 % interval of the mean of `d`. */
function bootstrapCi(d: number[], reps = 4000): [number, number] {
  if (d.length < 2) return [Number.NaN, Number.NaN];
  const means = resampleMeans(d, reps, lcg32(20261019));
  return [percentileFloor(means, 0.025), percentileFloor(means, 0.975)];
}

interface ArmRow {
  ranking: string[];
  skill: number;
  exclude?: string;
}
const specRuns = weeks.map((w) =>
  specialistRanking(days, { weekEnd: w.weekEnd, lastDay: w.lastDay, params: chosenParams }),
);
const arms = new Map<string, ArmRow[]>();
if (values.out || values.features) {
  arms.set(
    "persistence",
    weeks.map((w) => ({ ranking: w.persistence, skill: 0 })),
  );
  arms.set(
    "nowcast",
    weeks.map((w, i) => ({ ranking: nowcast(w), skill: now[i]! })),
  );
  arms.set(
    "specialist",
    weeks.map((_, i) => ({ ranking: specRuns[i]!.ranking, skill: spec[i]! })),
  );
  arms.set(
    "oracle-events",
    weeks.map((w, i) => ({ ranking: oracleEvents(w, chosenParams), skill: oracle[i]! })),
  );
}

/** Feature records per week, and the weeks every file of a label covered. */
function loadFeatures(paths: string[]) {
  const byWeek = new Map<string, AttentionFeature[]>();
  let covered: Set<string> | undefined;
  for (const path of paths) {
    const mine = new Set<string>();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as AttentionFeature & { week: string; run?: boolean };
      if (r.run) {
        mine.add(r.week);
        continue;
      }
      const list = byWeek.get(r.week) ?? [];
      list.push(r);
      byWeek.set(r.week, list);
    }
    covered = covered ? new Set([...covered].filter((w) => mine.has(w))) : mine;
  }
  return { byWeek, covered: covered ?? new Set<string>() };
}

/** Elasticity grid over the features a label actually has. */
function adjustGrid(names: Set<string>): Array<Partial<AdjustParams>> {
  const axes: Array<[keyof AdjustParams, number[]]> = [];
  if (names.has("edits.surge")) axes.push(["editElasticity", [0, 0.1, 0.2, 0.35, 0.5]]);
  if (names.has("related.growth")) axes.push(["relatedElasticity", [0, 0.1, 0.2, 0.35, 0.5]]);
  if (names.has("news.trend")) axes.push(["newsElasticity", [0, 0.1, 0.2, 0.35]]);
  if (names.has("news.portal_days")) axes.push(["portalElasticity", [0, 0.1, 0.2, 0.35]]);
  if (names.has("news.direction")) axes.push(["directionStep", [1, 1.2, 1.5]]);
  if (names.has("event.in_window")) axes.push(["eventMultiplier", [1, 1.3, 1.6, 2.2, 3]]);
  if (names.has("event.ended")) axes.push(["endedMultiplier", [1, 0.6, 0.35]]);
  let out: Array<Partial<AdjustParams>> = [{}];
  for (const [k, vs] of axes) out = out.flatMap((g) => vs.map((v) => ({ ...g, [k]: v })));
  return out;
}

if (values.features) {
  const fixed: AdjustParams = {
    ...DEFAULT_ADJUST_PARAMS,
    ...(values.adjust ? (JSON.parse(values.adjust) as Partial<AdjustParams>) : {}),
  };
  console.log("\nattention extraction variants (paired with the specialist on covered weeks):");
  for (const spec0 of values.features.split(",")) {
    const eq = spec0.indexOf("=");
    const label = spec0.slice(0, eq).trim();
    const { byWeek, covered } = loadFeatures(spec0.slice(eq + 1).split("+"));
    const adjusted = (i: number, p: AdjustParams) =>
      applyAdjustments(specRuns[i]!.scored, byWeek.get(weeks[i]!.weekEnd) ?? [], p)
        .scored.slice(0, 10)
        .map((s) => s.title);
    const rows: ArmRow[] = weeks.map((w, i) => {
      const ranking = adjusted(i, fixed);
      return {
        ranking,
        skill: skillOf(w, ranking),
        ...(covered.has(w.weekEnd) ? {} : { exclude: "not extracted" }),
      };
    });
    arms.set(`specialist+${label}`, rows);
    const idx = weeks.map((w, i) => (covered.has(w.weekEnd) ? i : -1)).filter((i) => i >= 0);
    const report = (name: string, r: ArmRow[], over: number[]) => {
      const d = over.map((i) => r[i]!.skill - spec[i]!);
      const [lo, hi] = bootstrapCi(d);
      const changed = over.filter(
        (i) => JSON.stringify(r[i]!.ranking) !== JSON.stringify(specRuns[i]!.ranking),
      ).length;
      console.log(
        `  ${name.padEnd(36)} n=${over.length}  skill ${mean(over.map((i) => r[i]!.skill)).toFixed(4)} vs specialist ${mean(over.map((i) => spec[i]!)).toFixed(4)}  Δ ${mean(d).toFixed(4)} [${lo.toFixed(4)}, ${hi.toFixed(4)}]  better ${d.filter((x) => x > 1e-12).length} worse ${d.filter((x) => x < -1e-12).length}  lists changed ${changed}`,
      );
    };
    report(`specialist+${label}`, rows, idx);
    if (values.grid && idx.length >= 6) {
      const names = new Set([...byWeek.values()].flat().map((f) => f.feature));
      const axes = adjustGrid(names);
      const grid = axes.map((g) => ({ ...fixed, ...g }));
      const skills = grid.map((g) => idx.map((i) => skillOf(weeks[i]!, adjusted(i, g))));
      const warm = Math.min(minTrain, Math.floor(idx.length / 3));
      const wfRows: ArmRow[] = rows.map((r) => ({ ...r }));
      const picks = new Map<string, number>();
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k]!;
        if (k < warm) {
          wfRows[i] = { ...wfRows[i]!, exclude: "training" };
          continue;
        }
        let best = 0;
        let bestSkill = -Infinity;
        grid.forEach((_, g) => {
          const s = mean(skills[g]!.slice(0, k));
          if (s > bestSkill + 1e-12) {
            bestSkill = s;
            best = g;
          }
        });
        const ranking = adjusted(i, grid[best]!);
        wfRows[i] = { ranking, skill: skillOf(weeks[i]!, ranking) };
        const key = JSON.stringify(axes[best]);
        picks.set(key, (picks.get(key) ?? 0) + 1);
      }
      arms.set(`specialist+${label}/wf`, wfRows);
      report(`specialist+${label}/wf`, wfRows, idx.slice(warm));
      const inSample = grid
        .map((g, k) => ({ g, s: mean(skills[k]!) }))
        .sort((a, b) => b.s - a.s)[0]!;
      console.log(
        `    in-sample best ${inSample.s.toFixed(4)} at ${JSON.stringify(axes[grid.indexOf(inSample.g)])}; most-picked walk-forward ${[...picks.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-"}`,
      );
    }
  }
}

if (values.out) {
  const lines: string[] = [];
  for (const [variant, rows] of arms) {
    rows.forEach((r, i) => {
      const w = weeks[i]!;
      const pool = new Set(specRuns[i]!.scored.map((s) => s.title));
      lines.push(
        JSON.stringify({
          id: `wiki-top10-${w.weekEnd}`,
          score: Number(r.skill.toFixed(6)),
          at: w.lockAt,
          variant,
          group: "arena-wikipedia",
          ...(r.exclude ? { exclude: r.exclude } : {}),
          weekEnd: w.weekEnd,
          lastDay: w.lastDay,
          loss: Number(rboLoss(r.ranking, w.truth, 0.9, w.truth.length).toFixed(6)),
          persistenceLoss: Number(rboLoss(w.persistence, w.truth, 0.9, w.truth.length).toFixed(6)),
          hits: r.ranking.filter((t) => w.truth.includes(t)).length,
          unseen: w.truth.filter((t) => !pool.has(t)).length,
          ranking: r.ranking,
          truth: w.truth,
        }),
      );
    });
  }
  writeFileSync(values.out, `${lines.join("\n")}\n`);
  console.log(`\nper-item results: ${lines.length} lines (${arms.size} variants) → ${values.out}`);
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
    const marina = entrant ? r.entries.find((e) => e.entrant === entrant)?.skill : undefined;
    const n = skillOf(w, nowcast(w));
    const s = skillOf(w, specialist(w, chosenParams));
    cols.nowcast!.push(n);
    cols.specialist!.push(s);
    cols.best!.push(best);
    if (marina !== undefined) cols.marina!.push(marina);
    console.log(
      `  ${r.round_id}  reconstruction ${same ? "matches" : "DIFFERS"}  nowcast ${n.toFixed(3)}  specialist ${s.toFixed(3)}  best entrant ${best.toFixed(3)}${marina !== undefined ? `  ${entrant} filed ${marina.toFixed(3)}` : ""}`,
    );
  }
  console.log(
    `  mean: nowcast ${mean(cols.nowcast!).toFixed(4)}  specialist ${mean(cols.specialist!).toFixed(4)}  best entrant per round ${mean(cols.best!).toFixed(4)}`,
  );
}
