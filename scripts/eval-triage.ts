#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline intake-triage evaluation — deterministic, no model call, no network:
 *
 *   bun run eval:triage --futurex <rows.json> [--horizons 7,3,1]
 *                       [--ledger <db> [--benchmark futurex-past*]]
 *                       [--results <run dir>]… [--forecastbench <results.jsonl>]…
 *                       [--out <prefix>]
 *
 * `--futurex`: FutureX rows (a JSON array with id, prompt, end_time, level,
 * title). Reports the class mix at each horizon (NOW = end time − horizon).
 * `--ledger`: a benchmark ledger DB read read-only; every completed, valid run
 * of a matching benchmark is joined to the rows by item id and triaged at its
 * own cutoff (the run's `horizonDays`). `--results`: FutureX run directories
 * (`score.json` + `answers.json`, triaged at each row's recorded cutoff).
 * `--forecastbench`: result JSONL lines `{id, score, answer: {question,
 * answer, cutoff: {at}}}`. Writes `<prefix>.md` and `<prefix>.json`
 * (default `triage-eval`). Library: benchmarks/triage/eval.ts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { FuturexRow } from "../benchmarks/futurex/dataset";
import {
  ledgerItems,
  listLedgerRuns,
  openReadOnly,
  runVariant,
} from "../benchmarks/transfer/ledger";
import {
  type ClassScore,
  type Distribution,
  distribution,
  distributionTable,
  factModelCostPerItem,
  futurexItem,
  type ScoredItem,
  scoresByClass,
  scoreTable,
  type TriageItem,
  triageItem,
} from "../benchmarks/triage/eval";
import { TRIAGE_CLASSES, type TriageClass } from "../src/forecast/triage";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    futurex: { type: "string" },
    horizons: { type: "string", default: "7,3,1" },
    ledger: { type: "string" },
    benchmark: { type: "string", default: "futurex-past" },
    results: { type: "string", multiple: true },
    forecastbench: { type: "string", multiple: true },
    out: { type: "string", default: "triage-eval" },
  },
});

type Scores = Record<TriageClass, ClassScore> & { all: ClassScore };
const md: string[] = ["# Intake triage — offline evaluation", ""];
const json: Record<string, unknown> = {};

const rows = new Map<string, FuturexRow>();
if (values.futurex) {
  const raw = JSON.parse(readFileSync(values.futurex, "utf8")) as Array<
    FuturexRow & { title?: string }
  >;
  for (const r of raw) rows.set(r.id, { ...r, ...(r.title ? { en_title: r.title } : {}) });
  const horizons = values.horizons!.split(",").map(Number).filter(Number.isFinite);
  const dists: Array<{ label: string; d: Distribution }> = [];
  for (const h of horizons) {
    const items = [...rows.values()].flatMap((r) => futurexItem(r, h) ?? []);
    dists.push({ label: `FutureX rows, now = end − ${h}d`, d: distribution(items) });
  }
  md.push("## Class distribution", "", distributionTable(dists), "");
  json.futurex = dists;
}

/** Classes are memoised per (item, now). */
const memo = new Map<string, TriageClass>();
const classAt = (item: TriageItem): TriageClass => {
  const key = `${item.id}@${item.now}`;
  let c = memo.get(key);
  if (!c) {
    c = triageItem(item).class;
    memo.set(key, c);
  }
  return c;
};

const scoreRows: Array<{ label: string; s: Scores }> = [];
const pooled: Array<ScoredItem & { cls: TriageClass }> = [];

if (values.ledger) {
  const h = openReadOnly(values.ledger);
  try {
    const runs = listLedgerRuns(h.db).filter(
      (r) => r.benchmark.startsWith(values.benchmark!) && r.status === "completed" && !r.invalid,
    );
    const byVariant = new Map<string, Array<ScoredItem & { cls: TriageClass }>>();
    for (const run of runs) {
      const cfg = h.db
        .query<{ config_json: string }, [string]>(
          "SELECT config_json FROM benchmark_runs WHERE id = ?",
        )
        .get(run.id);
      let horizon = 7;
      try {
        const c = JSON.parse(cfg?.config_json ?? "{}") as { horizonDays?: number };
        if (typeof c.horizonDays === "number") horizon = c.horizonDays;
      } catch {
        // allow-empty-catch: a malformed config keeps the default horizon
      }
      const variant = `${run.benchmark} · ${runVariant(run)}`;
      for (const it of ledgerItems(h.db, run.id)) {
        const row = rows.get(it.id);
        const item = row ? futurexItem(row, horizon) : undefined;
        if (!item) continue;
        const scored = { id: `${run.id}:${it.id}`, score: it.score, variant, cls: classAt(item) };
        const list = byVariant.get(variant) ?? [];
        list.push(scored);
        byVariant.set(variant, list);
        pooled.push(scored);
      }
    }
    for (const [variant, list] of [...byVariant].sort()) {
      const cls = new Map(list.map((x) => [x.id, x.cls]));
      scoreRows.push({ label: variant, s: scoresByClass(list, (id) => cls.get(id)) });
    }
  } finally {
    h.close();
  }
}

for (const dir of values.results ?? []) {
  const scoreFile = join(dir, "score.json");
  const answerFile = join(dir, "answers.json");
  if (!existsSync(scoreFile) || !existsSync(answerFile)) continue;
  const score = JSON.parse(readFileSync(scoreFile, "utf8")) as {
    items?: Array<{ id: string; score: number }>;
  };
  const answers = JSON.parse(readFileSync(answerFile, "utf8")) as {
    results?: Array<{ id: string; cutoff?: string }>;
  };
  const cutoff = new Map((answers.results ?? []).map((r) => [r.id, r.cutoff]));
  const list: Array<ScoredItem & { cls: TriageClass }> = [];
  for (const it of score.items ?? []) {
    const row = rows.get(it.id);
    const at = cutoff.get(it.id);
    const base = row ? futurexItem(row, 0) : undefined;
    if (!base || !at) continue;
    const scored = {
      id: `${dir}:${it.id}`,
      score: it.score,
      variant: dir,
      cls: classAt({ ...base, now: at }),
    };
    list.push(scored);
    pooled.push(scored);
  }
  const cls = new Map(list.map((x) => [x.id, x.cls]));
  scoreRows.push({
    label: dir.split("/").slice(-3).join("/"),
    s: scoresByClass(list, (id) => cls.get(id)),
  });
}

if (pooled.length) {
  const cls = new Map(pooled.map((x) => [x.id, x.cls]));
  scoreRows.unshift({
    label: "**FutureX, all runs pooled**",
    s: scoresByClass(pooled, (id) => cls.get(id)),
  });
  md.push(
    "## FutureX scores by class (each item triaged at its run's cutoff)",
    "",
    scoreTable(scoreRows),
    "",
  );
  json.futurexScores = scoreRows;
}

const fbRows: Array<{ label: string; d: Distribution; s: Scores }> = [];
for (const file of values.forecastbench ?? []) {
  const items: TriageItem[] = [];
  const scored: ScoredItem[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: {
      id?: string;
      score?: number;
      answer?: { question?: string; answer?: TriageItem["answer"]; cutoff?: { at?: string } };
    };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const q = rec.answer?.question;
    const at = rec.answer?.cutoff?.at;
    if (!rec.id || !q || !at) continue;
    items.push({
      id: rec.id,
      question: q,
      ...(rec.answer?.answer ? { answer: rec.answer.answer } : {}),
      now: at,
    });
    if (typeof rec.score === "number") scored.push({ id: rec.id, score: rec.score, variant: file });
  }
  const cls = new Map(items.map((i) => [i.id, classAt(i)]));
  fbRows.push({
    label: file.split("/").slice(-2).join("/"),
    d: distribution(items),
    s: scoresByClass(scored, (id) => cls.get(id)),
  });
}
if (fbRows.length) {
  md.push(
    "## ForecastBench",
    "",
    distributionTable(fbRows.map(({ label, d }) => ({ label, d }))),
    "",
    scoreTable(fbRows.map(({ label, s }) => ({ label, s }))),
    "",
  );
  json.forecastbench = fbRows;
}

const perItem = factModelCostPerItem({ inputPerM: 0.3, outputPerM: 1.2 });
md.push(
  "## The optional fact model",
  "",
  `Not run (no paid calls). Estimated cost with the default deepseek-v4.1-flash ($0.30/M in, $1.20/M out; ~700 in + ~220 out tokens): $${perItem.toFixed(5)} per item, $${(perItem * 1000).toFixed(2)} per 1,000 items.`,
  "",
  `Classes: ${TRIAGE_CLASSES.join(", ")}. Deterministic mode at each item's own cutoff.`,
);
json.factModelUsdPerItem = perItem;

writeFileSync(`${values.out}.md`, `${md.join("\n")}\n`);
writeFileSync(`${values.out}.json`, `${JSON.stringify(json, null, 2)}\n`);
process.stdout.write(`${md.join("\n")}\n`);
