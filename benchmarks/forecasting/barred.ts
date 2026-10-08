// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Each forecasting board's own pages, barred from research on that board: the
 * dataset (which holds the resolutions), its mirrors, and the board's question,
 * answer and leaderboard pages. A forecast must come from evidence about the
 * world, never from the board itself. Applied to every retrieval engine through
 * `barredRetriever` (`src/arena/research/barred.ts`); `*` is one path segment.
 */

import type { SourceExclusion } from "../../src/arena/research/briefs";

const HF_MIRRORS = (repo: string) => [
  `huggingface.co/datasets/${repo}`,
  `huggingface.co/api/datasets/${repo}`,
  `hf.co/datasets/${repo}`,
  `hf-mirror.com/datasets/${repo}`,
  `datasets-server.huggingface.co/rows?dataset=${repo}`,
];

export const BOARD_EXCLUSIONS: Record<string, SourceExclusion> = {
  futurex: {
    urls: [
      ...HF_MIRRORS("futurex-ai/Futurex-Online"),
      ...HF_MIRRORS("futurex-ai/Futurex-Past"),
      "huggingface.co/datasets/*/futurex-online",
      "huggingface.co/datasets/*/futurex-past",
      "huggingface.co/spaces/futurex-ai",
      "futurex-ai.github.io",
      "github.com/futurex-ai",
    ],
  },
  metaculus: {
    // Question pages show the community forecast and, once closed, the resolution.
    urls: ["metaculus.com/questions", "metaculus.com/c", "metaculus.com/api", "metaculus.com/api2"],
  },
  forecastbench: {
    urls: [
      "forecastbench.org",
      "github.com/forecastingresearch/forecastbench-datasets",
      "raw.githubusercontent.com/forecastingresearch/forecastbench-datasets",
      "codeload.github.com/forecastingresearch/forecastbench-datasets",
      "huggingface.co/datasets/forecastingresearch",
    ],
  },
};

/** The barred list for a board (`futurex-past-clean` → `futurex`), or none. */
export function boardExclusion(benchmark: string): SourceExclusion | undefined {
  const name = benchmark.toLowerCase();
  const key = Object.keys(BOARD_EXCLUSIONS).find((k) => name === k || name.startsWith(`${k}-`));
  return key ? BOARD_EXCLUSIONS[key] : undefined;
}
