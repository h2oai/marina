// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE benchmark registry. Every consumer derives its list from it:
 *
 * - the harness (`benchmarks/harness.ts`) adds each entry's loader;
 * - the in-world runner (`BENCHMARKS` in `src/engine/benchmark-runner.ts`)
 *   adds where the dataset lives on disk;
 * - the benchmark web UI (`benchmarks/server.ts`) serves the metadata.
 *
 * Before 2026-10 these were three hand-synced copies and had drifted (the
 * world could not run narrativeqa, mt-bench, retention or aime-2025).
 * `test/benchmark-registry.test.ts` fails if a consumer stops matching.
 *
 * Pure data: no loaders, no I/O, so the engine can import it without pulling
 * in the harness.
 */

/** How a harness adapter asks and scores an item. */
export type BenchmarkAdapterKind =
  | "multiple-choice"
  | "code-gen"
  | "ifeval"
  | "free-form"
  | "numeric"
  | "short-answer"
  | "hle"
  | "checks";

/** How a run's items become its score. */
export type BenchmarkScoringKind =
  | "accuracy"
  | "pass-at-k"
  | "ifeval"
  | "judge"
  | "numeric-match"
  | "normalized-match";

/**
 * Where a benchmark's items come from: `cache` — downloaded into
 * `benchmarks/datasets/<dataset>.json`; `tracked` — a file in the repository;
 * `generated` — built in code, always ready.
 */
export type BenchmarkSource =
  | { kind: "cache" }
  | { kind: "tracked"; path: string }
  | { kind: "generated" };

export interface BenchmarkEntry {
  /** Display name. */
  name: string;
  /** Dataset id: the ledger's benchmark name and the cache file stem. */
  dataset: string;
  adapter: BenchmarkAdapterKind;
  scoring: BenchmarkScoringKind;
  description: string;
  /** A: model capability. B: memory and conversation. */
  phase: "A" | "B";
  source: BenchmarkSource;
}

const cache = { kind: "cache" } as const;

export const BENCHMARK_REGISTRY = {
  smoke: {
    name: "Smoke (prompt A/B)",
    dataset: "smoke-eval",
    adapter: "checks",
    scoring: "accuracy",
    description: "Frozen 15-item prompt A/B set — measure a prompt or crew change in seconds",
    phase: "A",
    source: { kind: "tracked", path: "benchmarks/smoke-eval.json" },
  },
  "mmlu-pro": {
    name: "MMLU-Pro",
    dataset: "mmlu-pro",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "12K 10-choice MC questions across 57 subjects",
    phase: "A",
    source: cache,
  },
  ifeval: {
    name: "IFEval",
    dataset: "ifeval",
    adapter: "ifeval",
    scoring: "ifeval",
    description: "541 prompts with verifiable instruction constraints",
    phase: "A",
    source: cache,
  },
  truthfulqa: {
    name: "TruthfulQA MC2",
    dataset: "truthfulqa",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "817 MC questions testing truthfulness",
    phase: "A",
    source: cache,
  },
  humaneval: {
    name: "HumanEval",
    dataset: "humaneval",
    adapter: "code-gen",
    scoring: "pass-at-k",
    description: "164 Python function completion tasks",
    phase: "A",
    source: cache,
  },
  narrativeqa: {
    name: "NarrativeQA",
    dataset: "narrativeqa",
    adapter: "free-form",
    scoring: "judge",
    description: "Story comprehension — memory vs no-memory",
    phase: "B",
    source: cache,
  },
  "mt-bench": {
    name: "MT-Bench",
    dataset: "mt-bench",
    adapter: "free-form",
    scoring: "judge",
    description: "80 multi-turn conversation quality questions",
    phase: "B",
    source: cache,
  },
  retention: {
    name: "Memory Retention",
    dataset: "retention",
    adapter: "free-form",
    scoring: "accuracy",
    description: "100 cross-session knowledge retention tasks",
    phase: "B",
    source: { kind: "generated" },
  },
  "arc-challenge": {
    name: "ARC-Challenge",
    dataset: "arc-challenge",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "1172 grade-school science reasoning MC",
    phase: "A",
    source: cache,
  },
  hellaswag: {
    name: "HellaSwag",
    dataset: "hellaswag",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "Commonsense sentence-completion MC",
    phase: "A",
    source: cache,
  },
  musr: {
    name: "MuSR",
    dataset: "musr",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "Multi-step soft reasoning (murder mysteries)",
    phase: "A",
    source: cache,
  },
  bbh: {
    name: "BBH Logical Deduction",
    dataset: "bbh",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "BIG-Bench Hard logical deduction (5 objects)",
    phase: "A",
    source: cache,
  },
  gsm8k: {
    name: "GSM8K",
    dataset: "gsm8k",
    adapter: "numeric",
    scoring: "numeric-match",
    description: "1319 grade-school math word problems",
    phase: "A",
    source: cache,
  },
  math: {
    name: "MATH-500",
    dataset: "math",
    adapter: "numeric",
    scoring: "numeric-match",
    description: "500 competition math problems (MATH benchmark subset)",
    phase: "A",
    source: cache,
  },
  "simple-qa": {
    name: "SimpleQA",
    dataset: "simpleqa",
    adapter: "short-answer",
    scoring: "normalized-match",
    description: "Short-answer factual questions (OpenAI)",
    phase: "A",
    source: cache,
  },
  frames: {
    name: "FRAMES",
    dataset: "frames",
    adapter: "short-answer",
    scoring: "judge",
    description: "Multi-hop factual retrieval (Google)",
    phase: "A",
    source: cache,
  },
  aime: {
    name: "AIME-2024",
    dataset: "aime-2024",
    adapter: "numeric",
    scoring: "numeric-match",
    description: "AIME 2024 olympiad math (30 problems, integer 0-999)",
    phase: "A",
    source: cache,
  },
  "aime-2025": {
    name: "AIME-2025",
    dataset: "aime-2025",
    adapter: "numeric",
    scoring: "numeric-match",
    description: "AIME 2025 olympiad math (30 problems, integer 0-999)",
    phase: "A",
    source: cache,
  },
  gpqa: {
    name: "GPQA-Diamond",
    dataset: "gpqa-diamond",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description:
      "198 graduate-level physics/bio/chem MC, options shuffled per seed (gated; HF_TOKEN)",
    phase: "A",
    source: cache,
  },
  "hle-verified-gold": {
    name: "HLE-Verified Gold",
    dataset: "hle-verified-gold",
    adapter: "hle",
    scoring: "accuracy",
    description: "HLE-Verified Gold subset, text-only; exact match, else equivalence judge",
    phase: "A",
    source: cache,
  },
  "hle-verified-gold-mm": {
    name: "HLE-Verified Gold (multimodal)",
    dataset: "hle-verified-gold-mm",
    adapter: "hle",
    scoring: "accuracy",
    description:
      "HLE-Verified Gold image items, image sent as an image_url part; exact match, else equivalence judge",
    phase: "A",
    source: cache,
  },
} as const satisfies Record<string, BenchmarkEntry>;

/** A registered benchmark key (`mmlu-pro`, `aime-2025`, …). */
export type BenchmarkKey = keyof typeof BENCHMARK_REGISTRY;

/** Every registered key, in registry order. */
export const BENCHMARK_KEYS = Object.keys(BENCHMARK_REGISTRY) as BenchmarkKey[];

/** The entry for `key`, or undefined when it is not registered. */
export function benchmarkEntry(key: string): BenchmarkEntry | undefined {
  return Object.hasOwn(BENCHMARK_REGISTRY, key)
    ? (BENCHMARK_REGISTRY as Record<string, BenchmarkEntry>)[key]
    : undefined;
}

/**
 * True when grading this benchmark can call a judge model: short-answer and
 * HLE items fall back to a judge after exact match; free-form items are
 * judge-scored (memory retention is a containment check and is not).
 */
export function benchmarkUsesJudge(entry: Pick<BenchmarkEntry, "adapter" | "scoring">): boolean {
  if (entry.adapter === "short-answer" || entry.adapter === "hle") return true;
  return entry.adapter === "free-form" && entry.scoring === "judge";
}

/** One row of the benchmark catalog the web UI serves (`GET /api/benchmarks`). */
export interface BenchmarkCatalogRow {
  key: BenchmarkKey;
  name: string;
  phase: "A" | "B";
  adapter: BenchmarkAdapterKind;
  scoring: BenchmarkScoringKind;
  description: string;
}

/** Every registered benchmark as a catalog row, in registry order. */
export function benchmarkCatalog(): BenchmarkCatalogRow[] {
  return BENCHMARK_KEYS.map((key) => {
    const e: BenchmarkEntry = BENCHMARK_REGISTRY[key];
    return {
      key,
      name: e.name,
      phase: e.phase,
      adapter: e.adapter,
      scoring: e.scoring,
      description: e.description,
    };
  });
}
