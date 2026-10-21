// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BenchmarkAdapterKind, BenchmarkScoringKind } from "../src/engine/benchmark-registry";
import type { MarinaVersion } from "../src/engine/run-version";

export interface BenchmarkConfig {
  name: string;
  dataset: string;
  adapter: BenchmarkAdapterKind;
  scoring: BenchmarkScoringKind;
  mode: "passthrough" | "memory";
  /** Ground factual answers in live search evidence before answering (`search`). */
  ground?: "search";
  model: string;
  endpoint: string;
  apiKey?: string;
  concurrency: number;
  limit?: number;
  seed?: number;
  /** Fixed disjoint split of the items (benchmarks/partition.ts). */
  partition?: "holdout" | "tune";
  /**
   * Who grades judge-scored items; absent for benchmarks no judge grades.
   * `self_judge`: the judge is the target model, by explicit opt-in (`--self-judge`).
   */
  judge?: { model: string; endpoint: string; self_judge?: boolean };
  /**
   * The run's lesson regime toward a Marina target (`x-marina-eval`): `measure`
   * excludes lessons learned from this board, `live` uses every lesson.
   */
  lessons_mode?: "measure" | "live";
  /** The run asked plain passthru targets to inject lessons (`x-marina-lessons: on`). */
  lessons?: boolean;
}

export interface BenchmarkResult {
  config: BenchmarkConfig;
  /** The Marina code that produced the run (`benchmarks/run-version.ts`). Absent on older results. */
  marina?: MarinaVersion;
  timestamp: number;
  duration_ms: number;
  scores: {
    overall: number;
    breakdown: Record<string, number>;
  };
  metadata: {
    total: number;
    answered: number;
    timeouts: number;
    errors: number;
    avgLatencyMs: number;
    /** Reported usage and cost totals (benchmarks/usage.ts). Absent on older results. */
    usage?: UsageSummary;
  };
  items: ResultItem[];
}

export interface ResultItem {
  id: string;
  question: string;
  expected: string;
  actual: string;
  /** Raw model response for adapters that summarize `actual` (ifeval, code-gen).
   *  Capped at ~4KB per item. Diagnostic only — not used for scoring. */
  rawResponse?: string;
  correct: boolean;
  score?: number;
  latencyMs: number;
  category?: string;
  /** What answering this item cost, as the endpoint reported it. */
  usage?: ItemUsage;
  /** What judging this item cost (judge-scored adapters only). */
  judgeUsage?: ItemUsage;
  /**
   * Search results given to the model before it answered (`--ground search` runs
   * only). 0 means grounding found nothing usable and the model answered unaided.
   */
  evidence?: number;
  /** Judge verdict when a judge decided the item; "error" = the judge failed. */
  judge?: "correct" | "incorrect" | "error";
  /** The target's `x-request-id` for this item (a Marina traceId); filed to the ledger. */
  traceId?: string;
  /** The judge call's `x-request-id`, when the judge reported one. */
  judgeTraceId?: string;
  /** The answer arrived through Marina's output repair (`repaired:parse|shot`). */
  repaired?: string;
  /**
   * `answerDigest` of the item's answer when `actual` is not the answer itself
   * (an adapter that keeps `actual` empty). Filed as a digest, never as text.
   */
  answerDigest?: string;
  /**
   * The answer was forced at a turn, step or time budget (Marina's
   * `x-marina-budget-forced` header, or the adapter's own loop).
   */
  budgetForced?: boolean;
  /** Verification outcome: `not_run` (infrastructure never ran the checks) is not `failed`. */
  verification?: "passed" | "failed" | "not_run";
  /** Lesson ids the target served for this item (`x-marina-lessons`); ids only. */
  lessons?: string[];
  /** Lesson ids recalled for this item but not shown (observe mode). */
  lessonsObserved?: string[];
}

/** Usage of one model call. Undefined fields were not reported — never estimated. */
export interface CallUsage {
  promptTokens?: number;
  completionTokens?: number;
  /**
   * Prompt tokens served from the provider's prompt cache (OpenAI
   * `prompt_tokens_details.cached_tokens`, Anthropic `cache_read_input_tokens`),
   * and tokens written to it. Both are part of `promptTokens`. A run whose
   * prompts were cached by another run (two arms on the same items and key at
   * once) reads cheap here: compare arms with this in view.
   */
  cachedPromptTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/** Usage summed over an item's calls; `calls` counts every call made. */
export interface ItemUsage extends CallUsage {
  calls: number;
}

/** Usage summed over a run. `pricedItems` counts items whose cost was reported. */
export interface UsageSummary {
  items: number;
  calls: number;
  pricedItems: number;
  costUsd?: number;
  judgeCostUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Answer and judge prompt tokens read from / written to the prompt cache (see `CallUsage`). */
  cachedPromptTokens?: number;
  cacheWriteTokens?: number;
}

export interface DatasetItem {
  id: string;
  question: string;
  choices?: string[];
  answer: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface Message {
  role: "system" | "user" | "assistant";
  /** Plain text, or OpenAI content parts (text + `image_url`) for multimodal items. */
  content: string | ContentPart[];
}

export interface BenchmarkDefinition {
  name: string;
  dataset: string;
  adapter: BenchmarkConfig["adapter"];
  scoring: BenchmarkConfig["scoring"];
  description: string;
  phase: "A" | "B";
  download: (dir: string, limit?: number) => Promise<DatasetItem[]>;
  /** Per-run item preparation after the seeded slice (e.g. per-seed option order). */
  prepare?: (items: DatasetItem[], seed: number) => DatasetItem[];
}
