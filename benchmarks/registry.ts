// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The harness's benchmark registry: the ONE shared registry
 * (`src/engine/benchmark-registry.ts`) plus each benchmark's loader. Kept out
 * of `harness.ts` so it can be imported (tests, tools) without running a
 * benchmark.
 */

import {
  BENCHMARK_KEYS,
  BENCHMARK_REGISTRY,
  type BenchmarkEntry,
  type BenchmarkKey,
} from "../src/engine/benchmark-registry";
import { loadSmoke } from "./adapters/checks";
import { shuffleChoices } from "./adapters/multiple-choice";
import {
  downloadAIME,
  downloadAIME2025,
  downloadARC,
  downloadBBH,
  downloadFRAMES,
  downloadGPQA,
  downloadGSM8K,
  downloadHellaSwag,
  downloadHLEVerifiedGold,
  downloadHLEVerifiedGoldImages,
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
import type { BenchmarkDefinition } from "./types";

/**
 * How each registered benchmark loads (and per seed prepares) its items. The
 * metadata comes from the ONE registry (`src/engine/benchmark-registry.ts`);
 * typing this map by its keys makes a registered benchmark without a loader a
 * compile error.
 */
const LOADERS: Record<
  BenchmarkKey,
  Pick<BenchmarkDefinition, "download"> & Partial<Pick<BenchmarkDefinition, "prepare">>
> = {
  smoke: { download: loadSmoke },
  "mmlu-pro": { download: downloadMMLUPro },
  ifeval: { download: downloadIFEval },
  truthfulqa: { download: downloadTruthfulQA },
  humaneval: { download: downloadHumanEval },
  narrativeqa: { download: downloadNarrativeQA },
  "mt-bench": { download: downloadMTBench },
  retention: { download: async (_dir, limit) => loadRetentionBenchmark(_dir, limit) },
  "arc-challenge": { download: downloadARC },
  hellaswag: { download: downloadHellaSwag },
  musr: { download: downloadMuSR },
  bbh: { download: downloadBBH },
  gsm8k: { download: downloadGSM8K },
  math: { download: downloadMATH },
  "simple-qa": { download: downloadSimpleQA },
  frames: { download: downloadFRAMES },
  aime: { download: downloadAIME },
  "aime-2025": { download: downloadAIME2025 },
  gpqa: {
    download: downloadGPQA,
    prepare: (items, seed) => items.map((item) => shuffleChoices(item, seed)),
  },
  "hle-verified-gold": { download: downloadHLEVerifiedGold },
  "hle-verified-gold-mm": { download: downloadHLEVerifiedGoldImages },
};

/** The harness registry: the shared metadata plus each benchmark's loader. */
export const BENCHMARKS: Record<string, BenchmarkDefinition> = Object.fromEntries(
  BENCHMARK_KEYS.map((key) => {
    const { source: _source, ...meta } = BENCHMARK_REGISTRY[key] as BenchmarkEntry;
    return [key, { ...meta, ...LOADERS[key] }];
  }),
);
