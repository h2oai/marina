// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reference scores — published leaderboard values for foundation models.
 *
 * The ONLY comparable numbers we care about are:
 *   (1) a model (reference — from this table, sourced from vendor cards /
 *       public leaderboards); and
 *   (2) an Marina instance (measured — in the `benchmark_runs` table,
 *       identified by its orchestration, model-config, and memory-state).
 *
 * We deliberately do NOT run "bare model through our thin provider" as a
 * third row type. That's just a less-reliable re-measurement of what the
 * vendor already publishes, and wastes the token budget we should be
 * spending on the Marina side of the comparison.
 *
 * ── Curation rules ──
 *  - Every entry cites a source URL and a date.
 *  - Only add a score if you can cite it. No guessed numbers.
 *  - Score is 0.0-1.0 (so GSM8K 85.7% → 0.857).
 *  - `n` is the sample size if the source reports on a subset; omit for
 *    full-dataset evaluations (the normal case).
 *  - When a vendor releases a new model, add their whole benchmark sweep
 *    in one commit with the source URL from their model card or blog.
 *
 * Benchmark keys match the BENCHMARKS registry in `harness.ts`.
 */

export interface ReferenceScore {
  /** Model identifier — matches the agent_configs.model convention
   *  (provider/model). Stable across re-runs. */
  modelId: string;
  /** Benchmark key — matches BENCHMARKS registry keys in harness.ts. */
  benchmark: string;
  /** Score as a fraction 0.0-1.0. */
  score: number;
  /** Optional sample size for subset evaluations. */
  n?: number;
  /** Citation URL (model card, vendor blog, leaderboard). */
  sourceUrl: string;
  /** When this score was captured/published (ISO yyyy-mm-dd). */
  asOf: string;
  /** Optional free-form note (e.g., "chain-of-thought", "strict mode"). */
  note?: string;
}

/**
 * Seed entries. This is deliberately small — it's more valuable to have a
 * few trustworthy, cited entries than a large table of uncertain ones.
 * Expand as needed when we benchmark against a new foundation model.
 *
 * Sources to mine as we add more:
 *   - anthropic.com/news model announcements
 *   - openai.com/news model announcements
 *   - ai.google.dev / deepmind.google releases
 *   - llm-stats.com (aggregated)
 *   - lmarena.ai (live)
 *   - papers accompanying specific models (e.g., AIME solve-rate tables)
 */
export const REFERENCE_SCORES: ReferenceScore[] = [
  // ── Anthropic ─────────────────────────────────────────────────────────
  // Claude Haiku 4.5 — SWE-bench Verified from the release announcement.
  {
    modelId: "anthropic/claude-haiku-4-5",
    benchmark: "swe-bench-verified",
    score: 0.733,
    sourceUrl: "https://www.anthropic.com/news/claude-haiku-4-5",
    asOf: "2025-10-15",
  },
  // Claude Haiku 4.5 — TruthfulQA measured in-house 2026-04-23 via thin
  // Anthropic proxy. Kept as an empirical anchor; will replace with an
  // Anthropic-published number when we find one.
  {
    modelId: "anthropic/claude-haiku-4-5",
    benchmark: "truthfulqa",
    score: 0.95,
    n: 20,
    sourceUrl: "internal://gen-0-haiku-experiment-2026-04-23",
    asOf: "2026-04-23",
    note: "N=20 seed=42 via thin provider — replace when vendor publishes",
  },

  // Claude Sonnet 4.6 — from morphllm's curated Claude benchmark roundup.
  {
    modelId: "anthropic/claude-sonnet-4-6",
    benchmark: "swe-bench-verified",
    score: 0.796,
    sourceUrl: "https://www.morphllm.com/claude-benchmarks",
    asOf: "2026-04-23",
  },
  {
    modelId: "anthropic/claude-sonnet-4-6",
    benchmark: "gpqa",
    score: 0.741,
    sourceUrl: "https://www.morphllm.com/claude-benchmarks",
    asOf: "2026-04-23",
    note: "GPQA Diamond",
  },
  {
    modelId: "anthropic/claude-sonnet-4-6",
    benchmark: "mmlu-pro",
    score: 0.893,
    sourceUrl: "https://iternal.ai/llm-selection-guide",
    asOf: "2026-03-01",
    note: "source reports as MMLU — most 2026 frontier reporting is MMLU-Pro-shape",
  },

  // Claude Opus 4.6 — morphllm & Vellum (two independent sources for GPQA
  // disagree slightly: 91.3% vs 93.6%. Keeping morphllm's as the primary
  // entry; Vellum's stays as a secondary datapoint for honest spread.)
  {
    modelId: "anthropic/claude-opus-4-6",
    benchmark: "swe-bench-verified",
    score: 0.808,
    sourceUrl: "https://www.morphllm.com/claude-benchmarks",
    asOf: "2026-04-23",
  },
  {
    modelId: "anthropic/claude-opus-4-6",
    benchmark: "gpqa",
    score: 0.913,
    sourceUrl: "https://www.morphllm.com/claude-benchmarks",
    asOf: "2026-04-23",
    note: "GPQA Diamond",
  },
  {
    modelId: "anthropic/claude-opus-4-6",
    benchmark: "humaneval",
    score: 0.95,
    sourceUrl: "https://www.morphllm.com/claude-benchmarks",
    asOf: "2026-04-23",
  },
  {
    modelId: "anthropic/claude-opus-4-6",
    benchmark: "aime-2025",
    score: 0.998,
    sourceUrl: "https://www.vellum.ai/llm-leaderboard",
    asOf: "2026-04-23",
  },
  {
    modelId: "anthropic/claude-opus-4-6",
    benchmark: "mmlu-pro",
    score: 0.911,
    sourceUrl: "https://iternal.ai/llm-selection-guide",
    asOf: "2026-03-01",
    note: "source reports as MMLU — likely MMLU-Pro-shape",
  },

  // ── OpenAI ───────────────────────────────────────────────────────────
  {
    modelId: "openai/gpt-5-2",
    benchmark: "gpqa",
    score: 0.924,
    sourceUrl: "https://iternal.ai/llm-selection-guide",
    asOf: "2026-03-01",
    note: "GPQA Diamond",
  },
  {
    modelId: "openai/gpt-5-2",
    benchmark: "aime-2025",
    score: 1.0,
    sourceUrl: "https://iternal.ai/llm-selection-guide",
    asOf: "2026-03-01",
  },
  {
    modelId: "openai/gpt-5-2",
    benchmark: "swe-bench-verified",
    score: 0.8,
    sourceUrl: "https://iternal.ai/llm-selection-guide",
    asOf: "2026-03-01",
  },
  {
    modelId: "openai/gpt-5-4",
    benchmark: "gpqa",
    score: 0.92,
    sourceUrl: "https://iternal.ai/llm-selection-guide",
    asOf: "2026-03-01",
    note: "GPQA Diamond",
  },
  {
    modelId: "openai/gpt-5-4",
    benchmark: "aime-2025",
    score: 0.88,
    sourceUrl: "https://iternal.ai/llm-selection-guide",
    asOf: "2026-03-01",
  },

  // ── Google ────────────────────────────────────────────────────────────
  {
    modelId: "google/gemini-3-pro",
    benchmark: "gpqa",
    score: 0.919,
    sourceUrl: "https://www.vellum.ai/llm-leaderboard",
    asOf: "2026-04-23",
    note: "GPQA Diamond",
  },
  {
    modelId: "google/gemini-3-pro",
    benchmark: "aime-2025",
    score: 1.0,
    sourceUrl: "https://www.vellum.ai/llm-leaderboard",
    asOf: "2026-04-23",
  },
  {
    modelId: "google/gemini-3-1-pro",
    benchmark: "gpqa",
    score: 0.943,
    sourceUrl: "https://iternal.ai/llm-selection-guide",
    asOf: "2026-03-01",
    note: "GPQA Diamond",
  },
  {
    modelId: "google/gemini-3-1-pro",
    benchmark: "aime-2025",
    score: 1.0,
    sourceUrl: "https://iternal.ai/llm-selection-guide",
    asOf: "2026-03-01",
  },
  {
    modelId: "google/gemini-3-1-pro",
    benchmark: "swe-bench-verified",
    score: 0.806,
    sourceUrl: "https://iternal.ai/llm-selection-guide",
    asOf: "2026-03-01",
  },
  {
    modelId: "google/gemini-3-1-pro",
    benchmark: "mmlu-pro",
    score: 0.926,
    sourceUrl: "https://iternal.ai/llm-selection-guide",
    asOf: "2026-03-01",
    note: "source reports as MMLU — likely MMLU-Pro-shape",
  },
  {
    modelId: "google/gemini-3-flash",
    benchmark: "gpqa",
    score: 0.904,
    sourceUrl: "https://iternal.ai/llm-selection-guide",
    asOf: "2026-03-01",
    note: "GPQA Diamond",
  },
  {
    modelId: "google/gemini-3-flash",
    benchmark: "swe-bench-verified",
    score: 0.78,
    sourceUrl: "https://iternal.ai/llm-selection-guide",
    asOf: "2026-03-01",
  },
];

// ── Lookup helpers ───────────────────────────────────────────────────────

/** Return the most-recent reference score for a (model, benchmark) pair. */
export function lookupReferenceScore(
  modelId: string,
  benchmark: string,
): ReferenceScore | undefined {
  const matches = REFERENCE_SCORES.filter(
    (r) => r.modelId === modelId && r.benchmark === benchmark,
  );
  if (matches.length === 0) return undefined;
  return matches.reduce((latest, current) => (current.asOf > latest.asOf ? current : latest));
}

/** All reference scores for a benchmark (any model), most-recent first. */
export function referenceScoresForBenchmark(benchmark: string): ReferenceScore[] {
  return REFERENCE_SCORES.filter((r) => r.benchmark === benchmark).sort((a, b) =>
    a.asOf > b.asOf ? -1 : 1,
  );
}

/** All reference scores for a model (any benchmark), most-recent first. */
export function referenceScoresForModel(modelId: string): ReferenceScore[] {
  return REFERENCE_SCORES.filter((r) => r.modelId === modelId).sort((a, b) =>
    a.asOf > b.asOf ? -1 : 1,
  );
}

/** All unique model IDs present in the reference table. */
export function knownReferenceModels(): string[] {
  return Array.from(new Set(REFERENCE_SCORES.map((r) => r.modelId))).sort();
}
