// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BenchmarkResult } from "./types";

/**
 * The result as written to disk: the endpoint credential never leaves the
 * process. `config.apiKey` (which the judge reuses) is dropped, along with any
 * key a judge config might carry.
 */
export function resultForDisk(result: BenchmarkResult): BenchmarkResult {
  const { apiKey: _apiKey, ...config } = result.config;
  const judge = config.judge as
    | (BenchmarkResult["config"]["judge"] & { apiKey?: string })
    | undefined;
  if (judge && "apiKey" in judge) {
    const { apiKey: _judgeKey, ...rest } = judge;
    config.judge = rest;
  }
  return { ...result, config };
}
