#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin CLI over the memory-delta benchmark harness. All flags pass through:
 *
 *   bun --env-file=/dev/null run scripts/qualify-memory-benchmark.ts --help
 *   bun --env-file=/dev/null run scripts/qualify-memory-benchmark.ts            # offline stub, 5 seeds
 *   bun --env-file=/dev/null run scripts/qualify-memory-benchmark.ts \
 *     --dataset gsm8k --limit 200 --model marina/default --judge marina/default --seeds 5
 *
 * Exit code 0 = every arm completed without per-query errors; 1 = some
 * queries errored (results still written); 2 = the harness could not run.
 * See benchmarks/memory/README.md for the reporting standard.
 */

import { runCli } from "../benchmarks/memory/genbench";

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(
      `qualify:memory:benchmark failed: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(2);
  },
);
