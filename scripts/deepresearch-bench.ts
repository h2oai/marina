#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * DeepResearch Bench I and II — a thin adapter over Marina's general
 * research-report pipeline (`src/research/`). Nothing runs unless invoked;
 * NOTHING IS SENT: `export` writes the files a submission would contain, the
 * operator decides whether to email them.
 *
 *   bun run deepresearch select [--seed S] [--dev 1] [--heldout 3]   pre-registered dev / held-out ids
 *   bun run deepresearch run --board drb1|drb2 --label L --lead <provider/model>
 *        [--split dev|heldout|all|ids:<a,b>] [--max-usd N] [--concurrency 2]
 *        [--search tavily,exa,searxng,duckduckgo,openrouter] [--lessons on|off]
 *   bun run deepresearch check --board B --from L --label L2 --checker <provider/model> [--max-usd N]
 *   bun run deepresearch score --board B --label L --max-usd N [--workers 4]   official evaluator, our key, capped
 *   bun run deepresearch summary --board B --label L
 *   bun run deepresearch compare --board B --a L1[,L1r2] --b L2[,L2r2]
 *   bun run deepresearch file --board B --label L [--group G]   ledger + judged lessons (DB_PATH)
 *   bun run deepresearch export --board B --label L             submission layout under <out>/<label>/export
 *
 * Common flags: --out benchmarks/results/deepresearch (ignored by git), --cache
 * ~/.cache/marina/deepresearch (official evaluator checkouts + venv). Keys come
 * from the environment (OPENROUTER_API_KEY for OpenRouter models, search and the
 * judge). Every dollar lands in the DB_PATH spend ledger; `--max-usd` is the
 * run's own hard stop on top of the daily caps.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { bootstrapMean, pairedDifference } from "../benchmarks/deepresearch/compare";
import {
  type BenchTask,
  BOARDS,
  type Board,
  loadTasks,
  type Selection,
  selectSplit,
} from "../benchmarks/deepresearch/dataset";
import { meanScore, recordScoredRun, reportOutcome } from "../benchmarks/deepresearch/ledger";
import { JUDGE_LABEL, type OfficialRun, scoreOfficial } from "../benchmarks/deepresearch/official";
import { factCheckRun, generateReports, loadRecords } from "../benchmarks/deepresearch/run";
import { searchBackendsFromEnv, webSearchRetriever } from "../src/arena/research/web-search";
import { attachCliSpendLedger } from "../src/engine/cli-spend-ledger";
import { SpendGuard } from "../src/engine/spend-guard";
import { formatLesson } from "../src/learning/outcomes";
import {
  enableOutcomeLearning,
  noteOutcome,
  recallLessons,
  settleOutcomes,
} from "../src/learning/service";
import { MarinaDB } from "../src/persistence/database";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    board: { type: "string" },
    label: { type: "string" },
    from: { type: "string" },
    lead: { type: "string" },
    checker: { type: "string" },
    split: { type: "string", default: "heldout" },
    seed: { type: "string", default: "drb-pilot-2026-10-05" },
    dev: { type: "string", default: "1" },
    heldout: { type: "string", default: "3" },
    "include-nc": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "max-usd": { type: "string" },
    concurrency: { type: "string", default: "2" },
    workers: { type: "string", default: "4" },
    search: { type: "string" },
    lessons: { type: "string", default: "off" },
    group: { type: "string" },
    a: { type: "string" },
    b: { type: "string" },
    out: { type: "string", default: "benchmarks/results/deepresearch" },
    cache: { type: "string", default: join(homedir(), ".cache", "marina", "deepresearch") },
  },
});
const cmd = positionals[0];
const out = values.out!;
const dataDir = join(out, "data");
const log = (line: string) => console.log(line);

function board(): Board {
  const b = values.board;
  if (b !== "drb1" && b !== "drb2") throw new Error("--board drb1|drb2 is required");
  return b;
}

function need(name: "label" | "lead" | "checker" | "from"): string {
  const v = values[name];
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

function maxUsd(): number | undefined {
  const raw = values["max-usd"];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error("--max-usd must be a positive number");
  return n;
}

function selectionPath(): string {
  return join(out, "selection.json");
}

function readSelection(b: Board): Selection {
  const p = selectionPath();
  if (!existsSync(p)) throw new Error(`no ${p}: run \`select\` first`);
  const all = JSON.parse(readFileSync(p, "utf8")) as Record<Board, Selection>;
  return all[b];
}

async function tasksFor(b: Board): Promise<BenchTask[]> {
  const all = await loadTasks(b, dataDir);
  const split = values.split!;
  if (split === "all") return all;
  if (split.startsWith("ids:")) {
    const ids = new Set(split.slice(4).split(","));
    return all.filter((t) => ids.has(t.id));
  }
  const sel = readSelection(b);
  const ids = new Set(split === "dev" ? sel.dev : sel.heldout);
  return all.filter((t) => ids.has(t.id));
}

function openDb(): MarinaDB {
  return new MarinaDB(process.env.DB_PATH || "marina.db");
}

async function selectCmd(): Promise<number> {
  const p = selectionPath();
  if (existsSync(p) && !values.force) {
    console.log(`${p} exists (pre-registered); --force to overwrite`);
    console.log(readFileSync(p, "utf8"));
    return 0;
  }
  const sizes = { dev: Number(values.dev), heldout: Number(values.heldout) };
  const result: Record<string, Selection> = {};
  for (const b of ["drb1", "drb2"] as const) {
    result[b] = selectSplit(await loadTasks(b, dataDir), values.seed!, sizes, {
      includeNonCommercial: values["include-nc"],
    });
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(
    p,
    `${JSON.stringify({ ...result, createdAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(readFileSync(p, "utf8"));
  return 0;
}

function retrieverFactory() {
  const env = values.search
    ? { ...process.env, MARINA_RESEARCH_SEARCH_BACKENDS: values.search }
    : process.env;
  const { backends, skipped } = searchBackendsFromEnv(env);
  if (skipped.length) log(`search: skipped ${skipped.join(", ")}`);
  log(`search: ${backends.map((b) => b.name).join(" → ")}`);
  return () =>
    webSearchRetriever({ backends, maxQueries: 8, perQuery: 8, maxPages: 16, maxPassages: 24 });
}

function guard(label: string): SpendGuard {
  const budget = maxUsd();
  return new SpendGuard({
    label,
    ...(budget !== undefined ? { budgetUsd: budget } : {}),
    concurrency: Number(values.concurrency),
    minReserveUsd: 1,
  });
}

async function runCmd(): Promise<number> {
  const b = board();
  const label = need("label");
  const lead = need("lead");
  const tasks = await tasksFor(b);
  if (tasks.length === 0) throw new Error("no tasks selected");
  let db: MarinaDB | undefined;
  const lessons =
    values.lessons === "on"
      ? async (t: BenchTask) => {
          db ??= openDb();
          const got = await recallLessons(db, "research", t.prompt.slice(0, 600));
          return got.inject.length ? got.inject.map(formatLesson).join("\n") : undefined;
        }
      : undefined;
  log(
    `${BOARDS[b].name}: ${tasks.length} tasks · label ${label} · lead ${lead} · lessons ${values.lessons}`,
  );
  const r = await generateReports({
    tasks,
    config: { label, lead, ...(lessons ? { lessons } : {}) },
    retriever: retrieverFactory(),
    outDir: out,
    concurrency: Number(values.concurrency),
    guard: guard(`deepresearch ${label}`),
    log,
  });
  db?.close();
  log(
    `done ${r.done} · failed ${r.failed} · skipped ${r.skipped}${r.stopped ? ` · STOPPED: ${r.stopped}` : ""}`,
  );
  return r.failed > 0 || r.stopped ? 1 : 0;
}

async function checkCmd(): Promise<number> {
  const b = board();
  const tasks = await tasksFor(b);
  const r = await factCheckRun({
    from: need("from"),
    label: need("label"),
    checker: need("checker"),
    outDir: out,
    concurrency: Number(values.concurrency),
    guard: guard(`deepresearch ${values.label}`),
    ids: new Set(tasks.map((t) => t.id)),
    log,
  });
  log(
    `checked ${r.done} · failed ${r.failed} · skipped ${r.skipped}${r.stopped ? ` · STOPPED: ${r.stopped}` : ""}`,
  );
  return r.failed > 0 || r.stopped ? 1 : 0;
}

function scoresPath(label: string, b: Board): string {
  return join(out, label, `scores-${b}.json`);
}

async function scoreCmd(): Promise<number> {
  const b = board();
  const label = need("label");
  const cap = maxUsd();
  if (cap === undefined)
    throw new Error("--max-usd is required for scoring (the judge runs on our key)");
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error("OPENROUTER_API_KEY is required for the judge");
  const records = loadRecords(out, label).filter((r) => r.report && r.board === b);
  const tasks = new Map((await loadTasks(b, dataDir)).map((t) => [t.id, t]));
  const articles = records.map((r) => ({
    id: r.id,
    prompt: tasks.get(r.id)?.prompt ?? "",
    markdown: r.report!.markdown,
  }));
  if (articles.length === 0) throw new Error(`no finished reports under ${label} for ${b}`);
  const result = await scoreOfficial({
    board: b,
    model: `marina-${label}`.replace(/[^\w.-]/g, "_"),
    articles,
    cacheDir: values.cache!,
    apiKey: key,
    maxUsd: cap,
    workers: Number(values.workers),
    log: (line) => {
      if (/No target article|No (reference|criteria)/.test(line)) return;
      if (/judge |error|warn|Overall|exited|failed|Traceback/i.test(line)) log(`  ${line}`);
    },
  });
  writeFileSync(scoresPath(label, b), `${JSON.stringify(result, null, 2)}\n`);
  printSummary(b, label, result);
  return result.missing.length ? 1 : 0;
}

function printSummary(b: Board, label: string, s: OfficialRun): void {
  const m = bootstrapMean(s.scores.map((x) => x.score * 100));
  const records = loadRecords(out, label).filter((r) => r.board === b && r.report);
  const gen = records.reduce((t, r) => t + r.cost.totalUsd, 0);
  log(
    `${BOARDS[b].name} ${label}: ${m.mean.toFixed(2)} [${m.low.toFixed(2)}, ${m.high.toFixed(2)}] over ${m.n} tasks${s.missing.length ? ` (missing ${s.missing.join(",")})` : ""} · judge $${s.judgeUsd.toFixed(2)} · generation $${gen.toFixed(2)} ($${(gen / Math.max(1, records.length)).toFixed(2)}/report)`,
  );
  const dims = new Map<string, number[]>();
  for (const x of s.scores)
    for (const [k, v] of Object.entries(x.dims))
      if (typeof v === "number") dims.set(k, [...(dims.get(k) ?? []), v]);
  log(
    `  dims: ${[...dims].map(([k, v]) => `${k} ${((v.reduce((a, c) => a + c, 0) / v.length) * 100).toFixed(1)}`).join(" · ")}`,
  );
  for (const x of [...s.scores].sort((p, q) =>
    p.id.localeCompare(q.id, undefined, { numeric: true }),
  ))
    log(`  ${x.id}: ${(x.score * 100).toFixed(2)}`);
}

function readScores(label: string, b: Board): OfficialRun {
  const p = scoresPath(label, b);
  if (!existsSync(p)) throw new Error(`no scores for ${label} (${b}): run \`score\``);
  return JSON.parse(readFileSync(p, "utf8")) as OfficialRun;
}

function summaryCmd(): number {
  const b = board();
  const label = need("label");
  printSummary(b, label, readScores(label, b));
  const recs = loadRecords(out, label).filter((r) => r.board === b && r.report);
  const prec = recs
    .map((r) => r.report!.citations.figurePrecision)
    .filter((x): x is number => x !== undefined);
  log(
    `  citations: figure precision ${prec.length ? ((prec.reduce((s, x) => s + x, 0) / prec.length) * 100).toFixed(1) : "-"}% · sources/report ${(recs.reduce((s, r) => s + r.report!.sources.length, 0) / Math.max(1, recs.length)).toFixed(1)} · chars/report ${Math.round(recs.reduce((s, r) => s + r.report!.markdown.length, 0) / Math.max(1, recs.length))}`,
  );
  return 0;
}

function compareCmd(): number {
  const b = board();
  const arm = (labels: string) => {
    const m = new Map<string, number[]>();
    for (const l of labels.split(","))
      for (const s of readScores(l, b).scores) m.set(s.id, [...(m.get(s.id) ?? []), s.score * 100]);
    return m;
  };
  const a = arm(values.a ?? "");
  const bb = arm(values.b ?? "");
  const d = pairedDifference(a, bb);
  log(
    `${BOARDS[b].name}: B − A = ${d.mean.toFixed(2)} [${d.low.toFixed(2)}, ${d.high.toFixed(2)}] over ${d.n} paired tasks · B wins ${d.wins}, losses ${d.losses}, ties ${d.ties}`,
  );
  return 0;
}

async function fileCmd(): Promise<number> {
  const b = board();
  const label = need("label");
  const s = readScores(label, b);
  const records = loadRecords(out, label).filter((r) => r.board === b && r.report);
  const tasks = new Map((await loadTasks(b, dataDir)).map((t) => [t.id, t]));
  const db = openDb();
  try {
    const run = recordScoredRun(db, {
      board: b,
      label,
      records: records.filter((r) => s.scores.some((x) => x.id === r.id)),
      scores: s.scores,
      judge: JUDGE_LABEL[b],
      judgeUsd: s.judgeUsd,
      ...(values.group ? { replicateGroup: values.group } : {}),
    });
    log(
      `ledger: ${run.created ? "filed" : "already filed"} ${run.id} (${BOARDS[b].ledger}, mean ${((meanScore(s.scores) ?? 0) * 100).toFixed(2)})`,
    );
    enableOutcomeLearning(db);
    const now = new Date().toISOString();
    let queued = 0;
    for (const score of s.scores) {
      const record = records.find((r) => r.id === score.id);
      const task = tasks.get(score.id);
      if (!record || !task) continue;
      noteOutcome(
        db,
        reportOutcome({
          board: b,
          record,
          score,
          ...(task.topic ? { topic: task.topic } : {}),
          prompt: task.prompt,
          resolvedAt: now,
          refs: [`bench:${run.id}`],
        }),
      );
      queued++;
    }
    await settleOutcomes(db);
    log(`lessons: ${queued} outcomes judged into the research pool`);
  } finally {
    db.close();
  }
  return 0;
}

async function exportCmd(): Promise<number> {
  const b = board();
  const label = need("label");
  const records = loadRecords(out, label).filter((r) => r.board === b && r.report);
  const dir = join(out, label, "export", b);
  mkdirSync(dir, { recursive: true });
  if (b === "drb1") {
    const tasks = new Map((await loadTasks(b, dataDir)).map((t) => [t.id, t]));
    const lines = records
      .sort((p, q) => Number(p.id) - Number(q.id))
      .map((r) =>
        JSON.stringify({
          id: Number(r.id),
          prompt: tasks.get(r.id)?.prompt ?? "",
          article: r.report!.markdown,
        }),
      );
    const file = join(dir, `marina-${label}.jsonl`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    log(`${lines.length} articles → ${file} (of ${tasks.size} tasks)`);
    return 0;
  }
  const model = join(dir, "report", `marina-${label}`);
  mkdirSync(model, { recursive: true });
  for (const r of records) writeFileSync(join(model, `${r.id}.md`), r.report!.markdown);
  log(`${records.length} reports → ${model}`);
  return 0;
}

async function main(): Promise<number> {
  if (cmd !== "select" && cmd !== "summary" && cmd !== "compare" && cmd !== "export") {
    attachCliSpendLedger(`bun run deepresearch ${cmd}`, {
      dbPath: process.env.DB_PATH || "marina.db",
    });
  }
  switch (cmd) {
    case "select":
      return selectCmd();
    case "run":
      return runCmd();
    case "check":
      return checkCmd();
    case "score":
      return scoreCmd();
    case "summary":
      return summaryCmd();
    case "compare":
      return compareCmd();
    case "file":
      return fileCmd();
    case "export":
      return exportCmd();
    default:
      console.error(
        "usage: bun run deepresearch select|run|check|score|summary|compare|file|export (see scripts/deepresearch-bench.ts)",
      );
      return 2;
  }
}

process.exit(await main());
