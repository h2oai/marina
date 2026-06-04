#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runCodeGen } from "./adapters/code-gen";
import { runFreeForm } from "./adapters/free-form";
import { runIFEval } from "./adapters/ifeval";
import { runMultipleChoice } from "./adapters/multiple-choice";
import { runNumeric } from "./adapters/numeric";
import { runShortAnswer } from "./adapters/short-answer";
import {
  downloadAIME,
  downloadAIME2025,
  downloadARC,
  downloadBBH,
  downloadFRAMES,
  downloadGPQA,
  downloadGSM8K,
  downloadHellaSwag,
  downloadHumanEval,
  downloadIFEval,
  downloadMATH,
  downloadMMLUPro,
  downloadMTBench,
  downloadMuSR,
  downloadNarrativeQA,
  downloadSimpleQA,
  downloadTruthfulQA,
  loadRetentionBenchmark,
} from "./download";
import { runRetentionTask, runRetentionTaskPassthrough } from "./modes/memory";
import { computeAccuracy, computeJudgeScore } from "./scoring/accuracy";
import { computePassAtK } from "./scoring/pass-at-k";
import type {
  BenchmarkConfig,
  BenchmarkDefinition,
  BenchmarkResult,
  DatasetItem,
  ResultItem,
} from "./types";

// --- Benchmark Registry ---

const BENCHMARKS: Record<string, BenchmarkDefinition> = {
  "mmlu-pro": {
    name: "MMLU-Pro",
    dataset: "mmlu-pro",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "12K 10-choice MC questions across 57 subjects",
    phase: "A",
    download: downloadMMLUPro,
  },
  ifeval: {
    name: "IFEval",
    dataset: "ifeval",
    adapter: "ifeval",
    scoring: "ifeval",
    description: "541 prompts with verifiable instruction constraints",
    phase: "A",
    download: downloadIFEval,
  },
  truthfulqa: {
    name: "TruthfulQA MC2",
    dataset: "truthfulqa",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "817 MC questions testing truthfulness",
    phase: "A",
    download: downloadTruthfulQA,
  },
  humaneval: {
    name: "HumanEval",
    dataset: "humaneval",
    adapter: "code-gen",
    scoring: "pass-at-k",
    description: "164 Python function completion tasks",
    phase: "A",
    download: downloadHumanEval,
  },
  narrativeqa: {
    name: "NarrativeQA",
    dataset: "narrativeqa",
    adapter: "free-form",
    scoring: "judge",
    description: "Story comprehension — memory vs no-memory",
    phase: "B",
    download: downloadNarrativeQA,
  },
  "mt-bench": {
    name: "MT-Bench",
    dataset: "mt-bench",
    adapter: "free-form",
    scoring: "judge",
    description: "80 multi-turn conversation quality questions",
    phase: "B",
    download: downloadMTBench,
  },
  retention: {
    name: "Memory Retention",
    dataset: "retention",
    adapter: "free-form",
    scoring: "accuracy",
    description: "100 cross-session knowledge retention tasks",
    phase: "B",
    download: async (_dir, limit) => loadRetentionBenchmark(_dir, limit),
  },
  // --- New benchmarks (Tier 1: MC reasoning) ---
  // GPQA Diamond is gated on HuggingFace — skipped until we add auth-token support
  "arc-challenge": {
    name: "ARC-Challenge",
    dataset: "arc-challenge",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "1172 grade-school science reasoning MC",
    phase: "A",
    download: downloadARC,
  },
  hellaswag: {
    name: "HellaSwag",
    dataset: "hellaswag",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "Commonsense sentence-completion MC",
    phase: "A",
    download: downloadHellaSwag,
  },
  musr: {
    name: "MuSR",
    dataset: "musr",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "Multi-step soft reasoning (murder mysteries)",
    phase: "A",
    download: downloadMuSR,
  },
  bbh: {
    name: "BBH Logical Deduction",
    dataset: "bbh",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "BIG-Bench Hard logical deduction (5 objects)",
    phase: "A",
    download: downloadBBH,
  },
  // --- Tier 2: numeric / short-answer ---
  gsm8k: {
    name: "GSM8K",
    dataset: "gsm8k",
    adapter: "numeric",
    scoring: "numeric-match",
    description: "1319 grade-school math word problems",
    phase: "A",
    download: downloadGSM8K,
  },
  math: {
    name: "MATH-500",
    dataset: "math",
    adapter: "numeric",
    scoring: "numeric-match",
    description: "500 competition math problems (MATH benchmark subset)",
    phase: "A",
    download: downloadMATH,
  },
  "simple-qa": {
    name: "SimpleQA",
    dataset: "simpleqa",
    adapter: "short-answer",
    scoring: "normalized-match",
    description: "Short-answer factual questions (OpenAI)",
    phase: "A",
    download: downloadSimpleQA,
  },
  frames: {
    name: "FRAMES",
    dataset: "frames",
    adapter: "short-answer",
    scoring: "judge",
    description: "Multi-hop factual retrieval (Google)",
    phase: "A",
    download: downloadFRAMES,
  },
  aime: {
    name: "AIME-2024",
    dataset: "aime-2024",
    adapter: "numeric",
    scoring: "numeric-match",
    description: "AIME 2024 olympiad math (30 problems, integer 0-999)",
    phase: "A",
    download: downloadAIME,
  },
  "aime-2025": {
    name: "AIME-2025",
    dataset: "aime-2025",
    adapter: "numeric",
    scoring: "numeric-match",
    description: "AIME 2025 olympiad math (30 problems, integer 0-999)",
    phase: "A",
    download: downloadAIME2025,
  },
  gpqa: {
    name: "GPQA-Diamond",
    dataset: "gpqa",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description:
      "198 graduate-level physics/bio/chem multiple-choice (gated; set HF_TOKEN)",
    phase: "A",
    download: downloadGPQA,
  },
};

// --- CLI Parsing ---

function parseCliArgs() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      benchmark: { type: "string", short: "b" },
      mode: { type: "string", short: "m", default: "passthrough" },
      limit: { type: "string", short: "l" },
      endpoint: { type: "string", short: "e", default: "http://localhost:3300" },
      "api-key": { type: "string", short: "k" },
      model: { type: "string", default: "marina" },
      "judge-model": { type: "string" },
      "judge-endpoint": { type: "string" },
      concurrency: { type: "string", short: "c", default: "5" },
      seed: { type: "string", short: "s" },
      compare: { type: "string" },
      list: { type: "boolean" },
      results: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
  });
  return values;
}

// --- Output Formatting ---

function printTable(headers: string[], rows: string[][], colWidths?: number[]): void {
  const widths =
    colWidths ?? headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));

  const sep = widths.map((w) => "─".repeat(w + 2)).join("┼");
  const headerLine = headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join("│");
  const dataLines = rows.map((r) => r.map((c, i) => ` ${c.padEnd(widths[i])} `).join("│"));

  console.log(`┌${sep.replaceAll("┼", "┬")}┐`);
  console.log(`│${headerLine}│`);
  console.log(`├${sep}┤`);
  for (const line of dataLines) {
    console.log(`│${line}│`);
  }
  console.log(`└${sep.replaceAll("┼", "┴")}┘`);
}

function printSummary(result: BenchmarkResult): void {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${result.config.name} — ${result.config.mode} mode`);
  console.log(`${"═".repeat(60)}`);

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  console.log(`  Overall Score: ${pct(result.scores.overall)}`);
  console.log(`  Answered: ${result.metadata.answered}/${result.metadata.total}`);
  console.log(`  Errors: ${result.metadata.errors}`);
  console.log(`  Timeouts: ${result.metadata.timeouts}`);
  console.log(`  Avg Latency: ${result.metadata.avgLatencyMs.toFixed(0)}ms`);
  console.log(`  Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);

  const breakdownEntries = Object.entries(result.scores.breakdown);
  if (breakdownEntries.length > 1) {
    console.log("\n  Breakdown:");
    const rows = breakdownEntries
      .sort(([, a], [, b]) => b - a)
      .map(([cat, score]) => [cat, pct(score)]);
    printTable(["Category", "Score"], rows, [30, 10]);
  }
}

function printComparison(baseline: BenchmarkResult, memory: BenchmarkResult): void {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const delta = (a: number, b: number) => {
    const d = b - a;
    const sign = d >= 0 ? "+" : "";
    return `${sign}${(d * 100).toFixed(1)}%`;
  };

  console.log(`\n${"═".repeat(60)}`);
  console.log("  COMPARISON: Passthrough vs Memory");
  console.log(`${"═".repeat(60)}`);

  printTable(
    ["Metric", "Passthrough", "Memory", "Delta"],
    [
      [
        "Overall",
        pct(baseline.scores.overall),
        pct(memory.scores.overall),
        delta(baseline.scores.overall, memory.scores.overall),
      ],
      ["Answered", `${baseline.metadata.answered}`, `${memory.metadata.answered}`, ""],
      [
        "Avg Latency",
        `${baseline.metadata.avgLatencyMs.toFixed(0)}ms`,
        `${memory.metadata.avgLatencyMs.toFixed(0)}ms`,
        "",
      ],
    ],
    [20, 15, 15, 10],
  );
}

// --- Results Management ---

const RESULTS_DIR = join(import.meta.dir, "results");

function saveResult(result: BenchmarkResult): string {
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const filename = `${result.config.dataset}-${result.config.mode}-${result.timestamp}.json`;
  const path = join(RESULTS_DIR, filename);
  writeFileSync(path, JSON.stringify(result, null, 2));
  return path;
}

function listResults(): void {
  if (!existsSync(RESULTS_DIR)) {
    console.log("No results found.");
    return;
  }

  const files = readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log("No results found.");
    return;
  }

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const rows: string[][] = [];

  for (const file of files.slice(0, 20)) {
    try {
      const data = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf-8")) as BenchmarkResult;
      rows.push([
        data.config.name,
        data.config.mode,
        pct(data.scores.overall),
        `${data.metadata.answered}/${data.metadata.total}`,
        new Date(data.timestamp).toISOString().slice(0, 16),
      ]);
    } catch {
      rows.push([file, "error", "", "", ""]);
    }
  }

  printTable(["Benchmark", "Mode", "Score", "Items", "Date"], rows);
}

// --- Score Computation ---

function computeScores(
  items: ResultItem[],
  scoring: BenchmarkConfig["scoring"],
): { overall: number; breakdown: Record<string, number> } {
  switch (scoring) {
    case "accuracy":
      return computeAccuracy(items);
    case "pass-at-k":
      return computePassAtK(items);
    case "ifeval": {
      const strictCorrect = items.filter((i) => i.correct).length;
      const looseScores = items.filter((i) => i.score !== undefined).map((i) => i.score ?? 0);
      const looseAvg =
        looseScores.length > 0 ? looseScores.reduce((a, b) => a + b, 0) / looseScores.length : 0;
      return {
        overall: items.length > 0 ? strictCorrect / items.length : 0,
        breakdown: {
          strict_accuracy: items.length > 0 ? strictCorrect / items.length : 0,
          loose_accuracy: looseAvg,
        },
      };
    }
    case "judge":
      return computeJudgeScore(items);
    case "numeric-match":
    case "normalized-match":
      return computeAccuracy(items);
    default:
      return computeAccuracy(items);
  }
}

// --- Run Adapters ---

async function runAdapter(items: DatasetItem[], config: BenchmarkConfig): Promise<ResultItem[]> {
  const progressFn = (done: number, total: number) => {
    process.stdout.write(`\r  Progress: ${done}/${total}`);
  };

  let results: ResultItem[];

  switch (config.adapter) {
    case "multiple-choice":
      results = await runMultipleChoice(items, config, progressFn);
      break;
    case "ifeval":
      results = await runIFEval(items, config, progressFn);
      break;
    case "code-gen":
      results = await runCodeGen(items, config, progressFn);
      break;
    case "free-form":
      results = await runFreeForm(items, config, progressFn);
      break;
    case "numeric":
      results = await runNumeric(items, config, progressFn);
      break;
    case "short-answer":
      results = await runShortAnswer(items, config, progressFn);
      break;
    default:
      throw new Error(`Unknown adapter: ${config.adapter}`);
  }

  console.log(""); // newline after progress
  return results;
}

// --- Retention Benchmark Special Runner ---

async function runRetention(items: DatasetItem[], config: BenchmarkConfig): Promise<ResultItem[]> {
  const results: ResultItem[] = [];
  let completed = 0;

  for (const item of items) {
    const teach = (item.metadata?.teach as string) ?? "";
    const distractors = (item.metadata?.distractors as string[]) ?? [];
    const start = performance.now();
    let actual = "";
    let correct = false;

    try {
      if (config.mode === "memory") {
        actual = await runRetentionTask(
          {
            wsUrl: config.endpoint.replace("http", "ws"),
            endpoint: config.endpoint,
            model: config.model,
            apiKey: config.apiKey,
          },
          teach,
          distractors,
          item.question,
        );
      } else {
        actual = await runRetentionTaskPassthrough(
          {
            wsUrl: config.endpoint.replace("http", "ws"),
            endpoint: config.endpoint,
            model: config.model,
            apiKey: config.apiKey,
          },
          teach,
          distractors,
          item.question,
        );
      }

      // Check if the answer is contained in the response
      correct = actual.toLowerCase().includes(item.answer.toLowerCase());
    } catch (e) {
      actual = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    const latencyMs = performance.now() - start;
    results.push({
      id: item.id,
      question: item.question,
      expected: item.answer,
      actual: actual.slice(0, 200),
      correct,
      latencyMs,
      category: "retention",
    });

    completed++;
    process.stdout.write(`\r  Progress: ${completed}/${items.length}`);
  }

  console.log("");
  return results;
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseCliArgs();

  if (args.help) {
    console.log(`
Marina Benchmark Harness

Usage:
  bun run benchmarks/harness.ts --benchmark <name> [options]
  bun run benchmarks/harness.ts --list
  bun run benchmarks/harness.ts --results

Benchmarks:
  Phase A (baseline):  mmlu-pro, ifeval, truthfulqa, humaneval
  Phase B (memory):    narrativeqa, mt-bench, retention

Options:
  -b, --benchmark <name>    Benchmark to run
  -m, --mode <mode>         passthrough (default) or memory
  -l, --limit <n>           Limit number of questions
  -e, --endpoint <url>      API endpoint (default: http://localhost:3300)
  -k, --api-key <key>       API key for authentication
      --model <name>        Model name (default: marina)
  -c, --concurrency <n>     Parallel requests (default: 5)
  -s, --seed <n>            Random seed for subset selection
      --compare <mode>      Run comparison (e.g., --compare passthrough)
      --list                List available benchmarks
      --results             Show past results
  -h, --help                Show this help
`);
    return;
  }

  if (args.list) {
    console.log("\nAvailable Benchmarks:\n");
    const rows = Object.entries(BENCHMARKS).map(([key, def]) => [
      key,
      `Phase ${def.phase}`,
      def.adapter,
      def.description,
    ]);
    printTable(["Name", "Phase", "Adapter", "Description"], rows);
    return;
  }

  if (args.results) {
    listResults();
    return;
  }

  const benchmarkName = args.benchmark;
  if (!benchmarkName) {
    console.error("Error: --benchmark is required. Use --list to see available benchmarks.");
    process.exit(1);
  }

  const benchDef = BENCHMARKS[benchmarkName];
  if (!benchDef) {
    console.error(
      `Error: Unknown benchmark "${benchmarkName}". Use --list to see available benchmarks.`,
    );
    process.exit(1);
  }

  const mode = (args.mode ?? "passthrough") as "passthrough" | "memory";
  const config: BenchmarkConfig = {
    name: benchDef.name,
    dataset: benchDef.dataset,
    adapter: benchDef.adapter,
    scoring: benchDef.scoring,
    mode,
    model: args.model ?? "marina",
    endpoint: args.endpoint ?? "http://localhost:3300",
    apiKey: args["api-key"],
    concurrency: Number.parseInt(args.concurrency ?? "5", 10),
    limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
    seed: args.seed ? Number.parseInt(args.seed, 10) : undefined,
    judge: {
      model: args["judge-model"] ?? args.model ?? "marina",
      endpoint: args["judge-endpoint"] ?? args.endpoint ?? "http://localhost:3300",
    },
  };

  console.log(`\n  Benchmark: ${benchDef.name} (Phase ${benchDef.phase})`);
  console.log(`  Mode: ${config.mode}`);
  console.log(`  Endpoint: ${config.endpoint}`);
  console.log(`  Model: ${config.model}`);
  if (config.limit) console.log(`  Limit: ${config.limit}`);

  // Download/load dataset
  console.log("\n  Loading dataset...");
  const datasetDir = join(import.meta.dir, "datasets");
  let items = await benchDef.download(datasetDir, config.limit);

  if (config.seed !== undefined) {
    const { seededShuffle } = await import("./download");
    items = seededShuffle(items, config.seed);
  }
  if (config.limit) items = items.slice(0, config.limit);

  console.log(`  Loaded ${items.length} items`);

  // Run benchmark
  console.log("\n  Running...");
  const startTime = performance.now();

  let resultItems: ResultItem[];
  if (benchmarkName === "retention") {
    resultItems = await runRetention(items, config);
  } else {
    resultItems = await runAdapter(items, config);
  }

  const duration_ms = performance.now() - startTime;

  // Compute scores
  const scores = computeScores(resultItems, config.scoring);
  // Per-bucket scoring — slice by completion order to reveal any "gets better
  // over time" effect when the responder is accumulating memory across items.
  const BUCKET_SIZE = Number.parseInt(process.env.BENCH_BUCKET_SIZE ?? "50", 10);
  if (resultItems.length >= BUCKET_SIZE * 2) {
    for (let i = 0; i < resultItems.length; i += BUCKET_SIZE) {
      const slice = resultItems.slice(i, i + BUCKET_SIZE);
      const correct = slice.filter((x) => x.correct).length;
      const key = `bucket_${i + 1}_${Math.min(i + BUCKET_SIZE, resultItems.length)}`;
      scores.breakdown[key] = slice.length > 0 ? correct / slice.length : 0;
    }
  }

  const errors = resultItems.filter((i) => i.actual.startsWith("ERROR:")).length;
  const timeouts = resultItems.filter((i) => i.actual.includes("abort")).length;
  const latencies = resultItems
    .filter((i) => !i.actual.startsWith("ERROR:"))
    .map((i) => i.latencyMs);
  const avgLatencyMs =
    latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

  const result: BenchmarkResult = {
    config,
    timestamp: Date.now(),
    duration_ms,
    scores,
    metadata: {
      total: items.length,
      answered: resultItems.length - errors,
      timeouts,
      errors,
      avgLatencyMs,
    },
    items: resultItems,
  };

  // Save and print
  const resultPath = saveResult(result);
  printSummary(result);
  console.log(`\n  Results saved: ${resultPath}`);

  // Comparison mode
  if (args.compare) {
    console.log(`\n  Running comparison: ${args.compare} mode...`);
    const compareConfig = { ...config, mode: args.compare as "passthrough" | "memory" };

    const compareItems =
      benchmarkName === "retention"
        ? await runRetention(items, compareConfig)
        : await runAdapter(items, compareConfig);

    const compareDuration = performance.now() - startTime - duration_ms;
    const compareScores = computeScores(compareItems, compareConfig.scoring);
    const compareErrors = compareItems.filter((i) => i.actual.startsWith("ERROR:")).length;
    const compareLatencies = compareItems
      .filter((i) => !i.actual.startsWith("ERROR:"))
      .map((i) => i.latencyMs);
    const compareAvgLatency =
      compareLatencies.length > 0
        ? compareLatencies.reduce((a, b) => a + b, 0) / compareLatencies.length
        : 0;

    const compareResult: BenchmarkResult = {
      config: compareConfig,
      timestamp: Date.now(),
      duration_ms: compareDuration,
      scores: compareScores,
      metadata: {
        total: items.length,
        answered: compareItems.length - compareErrors,
        timeouts: compareItems.filter((i) => i.actual.includes("abort")).length,
        errors: compareErrors,
        avgLatencyMs: compareAvgLatency,
      },
      items: compareItems,
    };

    const compareResultPath = saveResult(compareResult);
    printSummary(compareResult);
    console.log(`  Results saved: ${compareResultPath}`);

    // Print side-by-side comparison
    if (config.mode === "memory" && args.compare === "passthrough") {
      printComparison(compareResult, result);
    } else {
      printComparison(result, compareResult);
    }
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
