// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Task families of the registered benchmarks (`BENCHMARKS` in
 * `benchmark-runner.ts`): what kind of work each one measures, as DATA.
 *
 * A family names a kind of task (`math`, `code`, `qa.exact`, …), never a
 * board. Roles declare the families they work in (their traits' `families`
 * capability); route evidence for a role with no configured families reads
 * the benchmarks tagged with them (`benchmark-evidence.ts`). A benchmark's
 * own name also works as a family of one.
 */

export const BENCHMARK_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  "mmlu-pro": ["qa.mc", "knowledge"],
  truthfulqa: ["qa.mc", "truthfulness"],
  "arc-challenge": ["qa.mc", "reasoning", "science"],
  hellaswag: ["qa.mc", "commonsense"],
  musr: ["reasoning"],
  bbh: ["reasoning"],
  gsm8k: ["math"],
  math: ["math"],
  "simple-qa": ["qa.exact", "knowledge"],
  humaneval: ["code"],
  ifeval: ["instruction"],
  frames: ["qa.exact", "research"],
  aime: ["math"],
  gpqa: ["qa.mc", "science", "reasoning"],
  "hle-verified-gold": ["qa.exact", "reasoning"],
  "hle-verified-gold-mm": ["qa.exact", "vision"],
};

/** The registered benchmarks tagged with any of `families`, in registry order. */
export function benchmarksInFamilies(families: readonly string[]): string[] {
  const wanted = new Set(families.map((f) => f.trim().toLowerCase()).filter(Boolean));
  return Object.entries(BENCHMARK_FAMILIES)
    .filter(([, tags]) => tags.some((t) => wanted.has(t)))
    .map(([name]) => name);
}
