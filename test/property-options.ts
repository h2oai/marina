// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/** Fixed CI seed; fast-check prints a shrink path on failure for exact replay. */
export function propertyOptions(defaultRuns = 40) {
  const numRuns = Number(process.env.FC_RUNS ?? defaultRuns);
  const seed = Number(process.env.FC_SEED ?? 0x4d415249);
  if (!Number.isInteger(numRuns) || numRuns < 1 || numRuns > 100_000 || !Number.isInteger(seed))
    throw new Error("FC_RUNS must be 1–100000 and FC_SEED must be an integer");
  return { numRuns, seed, ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}) };
}
