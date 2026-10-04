#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * BrowseComp-Plus — a thin adapter over Marina's local corpus search and model
 * API (see docs/guides/browsecomp-plus.md).
 *
 *   bun run browsecomp-plus run --queries q.jsonl --model <id> [--limit 100 --seed 1]
 *       [--replicates 2] [--group <key>] [--out <dir>] [--qrels qrel_evidence.txt]
 *       [--judge-model openrouter/qwen/qwen3-32b] [--file-to http://localhost:3300]
 *       [--formation single|ensemble:N|mapreduce:N|sharding:N|blackboard:NxR]
 *       [--lead-model <id>] [--offset N] [--max-usd N] [--resume]
 *   bun run browsecomp-plus compare <armA-dir> <armB-dir>   pooled paired comparison
 *
 * `--max-usd` is a hard spend stop for the whole invocation (every replicate,
 * agents and judge), summed from each call's `x-marina-cost-usd` and checked
 * before every call; the server's own daily cap trips it too. Queries it stops
 * are NOT RUN — left out of scoring, never counted wrong — and a stopped
 * replicate is reported incomplete and not filed. `--resume` reuses the queries
 * already answered and judged in the output directory.
 *
 * `--model` is any id the Marina at `--endpoint` serves: a passthru model
 * (`openrouter/openai/gpt-6-luna`), the verification formation
 * (`marina/verify:<proposer>[+<checker>]`) or a crew (`marina:<crew>`).
 * The key is MARINA_BENCH_API_KEY (a MODEL_API_KEYS entry on that server).
 *
 * Output per replicate (`<out>/rep<i>/`): `runs/run_<id>.json` (the official
 * run format), `evals/…_eval.json`, `summary.json` (the leaderboard fields)
 * and `result.json` (ledger-shaped: ids and outcomes only). Keep `--out`
 * outside the repository — run files hold query and answer text. NOTHING IS
 * SUBMITTED: submission is a manual, operator-approved step.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { workerPool } from "../benchmarks/browsecomp-plus/corpus-pool";
import { formationLabel, parseFormation } from "../benchmarks/browsecomp-plus/formations";
import { parseQrels } from "../benchmarks/browsecomp-plus/official";
import {
  loadQueries,
  runArm,
  sampleQueries,
  submissionSummary,
  toBenchmarkResult,
} from "../benchmarks/browsecomp-plus/run";
import { fileToLedger } from "../benchmarks/ledger-file";
import { comparePooled, seedFromIds } from "../benchmarks/replicate-stats";
import {
  defaultReplicateGroup,
  formatPooled,
  parseReplicates,
  poolResults,
  replicateFromResult,
  validGroupKey,
} from "../benchmarks/replicates";
import { parseMaxUsd, SpendGuard } from "../benchmarks/spend-guard";
import { wilsonInterval } from "../benchmarks/stats";
import type { BenchmarkResult } from "../benchmarks/types";
import { CORPUS_LEAD_CHARS, corpusDir } from "../src/engine/search-providers/corpus";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    queries: { type: "string" },
    model: { type: "string" },
    endpoint: { type: "string", default: "http://localhost:3300" },
    corpus: { type: "string", default: "browsecomp-plus" },
    qrels: { type: "string" },
    "gold-qrels": { type: "string" },
    limit: { type: "string" },
    offset: { type: "string", default: "0" },
    formation: { type: "string", default: "single" },
    "lead-model": { type: "string" },
    "lead-turns": { type: "string", default: "12" },
    workers: { type: "string", default: "6" },
    seed: { type: "string", default: "1" },
    replicates: { type: "string" },
    group: { type: "string" },
    out: { type: "string" },
    "judge-model": { type: "string", default: "openrouter/qwen/qwen3-32b" },
    k: { type: "string", default: "5" },
    "snippet-chars": { type: "string", default: String(CORPUS_LEAD_CHARS) },
    "doc-chars": { type: "string", default: "20000" },
    "max-turns": { type: "string", default: "30" },
    "max-tokens": { type: "string" },
    concurrency: { type: "string", default: "4" },
    "timeout-s": { type: "string", default: "600" },
    "file-to": { type: "string" },
    label: { type: "string" },
    llm: { type: "string" },
    link: { type: "string", default: "https://github.com/h2oai/marina" },
    "max-usd": { type: "string" },
    resume: { type: "boolean", default: false },
  },
});

function int(name: string, raw: string | undefined, min = 1): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer ≥ ${min}`);
  return n;
}

async function run(): Promise<number> {
  if (!values.queries || !values.model) throw new Error("run needs --queries and --model");
  const apiKey = process.env.MARINA_BENCH_API_KEY;
  const reps = parseReplicates(values.replicates);
  const seed = int("seed", values.seed, 0);
  const limit = values.limit ? int("limit", values.limit) : undefined;
  const concurrency = int("concurrency", values.concurrency);
  const formation = parseFormation(values.formation!);
  const lead = values["lead-model"];
  const offset = int("offset", values.offset, 0);
  const label =
    values.label ??
    (formation.kind === "single" ? values.model : `${formationLabel(formation)}:${values.model}`);
  const group =
    values.group ??
    (reps > 1 ? defaultReplicateGroup(`browsecomp-plus:${label}`, Date.now()) : undefined);
  if (group && !validGroupKey(group)) throw new Error(`invalid --group ${group}`);
  const out =
    values.out ?? join("data", "browsecomp-plus", label.replace(/[^A-Za-z0-9._-]+/g, "_"));
  const queries = sampleQueries(loadQueries(values.queries), limit, seed, offset);
  const qrels = values.qrels ? parseQrels(readFileSync(values.qrels, "utf8")) : undefined;
  const goldQrels = values["gold-qrels"]
    ? parseQrels(readFileSync(values["gold-qrels"], "utf8"))
    : undefined;
  const guard = new SpendGuard(parseMaxUsd(values["max-usd"]));
  const endpoint = { baseUrl: values.endpoint!, apiKey, guard };
  const timeoutMs = int("timeout-s", values["timeout-s"]) * 1000;
  const backend = workerPool(values.corpus!, corpusDir(), int("workers", values.workers));
  const target =
    formation.kind === "single"
      ? values.model
      : { formation: formationLabel(formation), model: values.model, lead: lead ?? values.model };
  console.error(
    `${queries.length} queries × ${reps} replicate(s) · ${typeof target === "string" ? target : JSON.stringify(target)} · corpus ${values.corpus} (${corpusDir()})${guard.maxUsd !== undefined ? ` · spend cap $${guard.maxUsd}` : ""}`,
  );
  const results: BenchmarkResult[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    const dir = reps > 1 ? join(out, `rep${rep}`) : out;
    mkdirSync(dir, { recursive: true });
    const arm = await runArm(queries, {
      model: values.model,
      endpoint,
      agent: {
        corpus: values.corpus!,
        backend,
        k: int("k", values.k),
        snippetChars: int("snippet-chars", values["snippet-chars"], 0),
        docChars: int("doc-chars", values["doc-chars"]),
        maxTurns: int("max-turns", values["max-turns"]),
        ...(values["max-tokens"] ? { maxTokens: int("max-tokens", values["max-tokens"]) } : {}),
        timeoutMs,
      },
      judge: { endpoint, model: values["judge-model"]!, timeoutMs: 180_000 },
      concurrency,
      formation,
      formationOptions: {
        leadTurns: int("lead-turns", values["lead-turns"]),
        ...(lead ? { leadModel: lead } : {}),
      },
      qrels,
      goldQrels,
      outDir: dir,
      resume: values.resume,
      onProgress: (done, total, ev) => {
        if (done % 10 === 0 || done === total)
          console.error(
            `  rep ${rep}: ${done}/${total} (last ${ev.query_id}: ${ev.correct ? "correct" : "wrong"}) · spent $${guard.spent.toFixed(2)}`,
          );
      },
    });
    const golds = arm.items
      .map((i) => i.eval.goldRecall)
      .filter((r): r is number => typeof r === "number");
    const goldRecall = golds.length
      ? Math.round((golds.reduce((t, r) => t + r, 0) / golds.length) * 10000) / 100
      : null;
    const summary = submissionSummary(arm, {
      llm: values.llm ?? values.model,
      link: values.link!,
      extra: {
        Attribution: "H2O.ai Marina",
        Marina: {
          model: values.model,
          formation: formationLabel(formation),
          ...(lead ? { lead_model: lead } : {}),
          judge: values["judge-model"],
          queries: queries.length,
          seed,
          offset,
          replicate: rep,
          cost_usd: Number(arm.costUsd.toFixed(4)),
          judge_cost_usd: Number(arm.judgeCostUsd.toFixed(4)),
          gold_recall_pct: goldRecall,
          incomplete: arm.items.filter((i) => i.run.record.status !== "completed").length,
          ...(arm.resumed.length ? { resumed: arm.resumed.length } : {}),
          ...(arm.stoppedBy ? { stopped_by: arm.stoppedBy, not_run: arm.notRun.length } : {}),
        },
      },
    });
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
    const result = toBenchmarkResult(arm, {
      endpoint: values.endpoint!,
      judgeModel: values["judge-model"]!,
      concurrency,
      seed,
      limit,
      target,
    });
    writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 1));
    const n = arm.items.length;
    const k = arm.items.filter((i) => i.eval.correct).length;
    const ci = wilsonInterval(k, n);
    console.log(
      `rep ${rep}: accuracy ${summary["Accuracy (%)"]}% [${(ci.low * 100).toFixed(1)}, ${(ci.high * 100).toFixed(1)}] · recall ${summary["Recall (%)"] ?? "n/a"}% (gold ${goldRecall ?? "n/a"}%) · search calls ${summary["Search Calls"]} · cost $${arm.costUsd.toFixed(2)} (+ judge $${arm.judgeCostUsd.toFixed(2)}) → ${dir}`,
    );
    if (arm.stoppedBy) {
      console.log(
        `  STOPPED (${arm.stoppedBy}): ${arm.notRun.length} of ${queries.length} queries not run — replicate incomplete, not filed, not pooled; --resume continues it`,
      );
      break;
    }
    results.push(result);
    if (values["file-to"]) {
      const filed = await fileToLedger(result, {
        fileTo: values["file-to"],
        apiKey,
        targetKind: values.model.startsWith("marina:") ? "crew" : "model",
        target,
        label,
        judge: values["judge-model"],
        costUsd: arm.costUsd,
        ...(group ? { replicateGroup: group } : {}),
      });
      console.log(
        filed.ok
          ? `  filed run ${filed.runId} (group ${filed.replicateGroup ?? "auto"})`
          : `  ledger filing failed: ${filed.error}`,
      );
    }
  }
  if (results.length > 1) console.log(formatPooled(label, poolResults(results)));
  console.log(`spent $${guard.spent.toFixed(2)} (agents + judge, from x-marina-cost-usd)`);
  backend.close();
  return 0;
}

function readResults(dir: string): BenchmarkResult[] {
  const one = join(dir, "result.json");
  if (existsSync(one)) return [JSON.parse(readFileSync(one, "utf8")) as BenchmarkResult];
  return readdirSync(dir)
    .filter((d) => /^rep\d+$/.test(d) && existsSync(join(dir, d, "result.json")))
    .sort()
    .map((d) => JSON.parse(readFileSync(join(dir, d, "result.json"), "utf8")) as BenchmarkResult);
}

function compare(): number {
  const [a, b] = positionals.slice(1);
  if (!a || !b) throw new Error("usage: bun run browsecomp-plus compare <armA-dir> <armB-dir>");
  const ra = readResults(a);
  const rb = readResults(b);
  const cmp = comparePooled(ra.map(replicateFromResult), rb.map(replicateFromResult), {
    seed: seedFromIds([a, b]),
  });
  console.log(formatPooled(a, cmp.a));
  console.log(formatPooled(b, cmp.b));
  console.log(
    `A − B = ${(cmp.delta * 100).toFixed(1)} pts [${(cmp.low * 100).toFixed(1)}, ${(cmp.high * 100).toFixed(1)}] · bootstrap p ${cmp.p.toFixed(3)} · ${cmp.items} common items${cmp.replicated ? "" : " · not replicated"} · single-pair McNemar p ${cmp.pairP.min.toFixed(3)}–${cmp.pairP.max.toFixed(3)}`,
  );
  return 0;
}

async function main(): Promise<number> {
  switch (positionals[0]) {
    case "run":
      return run();
    case "compare":
      return compare();
    default:
      throw new Error(
        "usage: bun run browsecomp-plus run|compare (see scripts/browsecomp-plus.ts)",
      );
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  },
);
