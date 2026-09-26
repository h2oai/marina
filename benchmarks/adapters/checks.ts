// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `checks` adapter — the frozen 15-item prompt A/B set
 * (benchmarks/smoke-eval.json) as a harness benchmark, so `benchmark run smoke`
 * lands on the same runs and leaderboard as every other benchmark. Each item
 * carries its own check; the prompt goes out as a single user message with no
 * system prompt, exactly as `bun run eval-prompt` sends it, so scores from the
 * two stay comparable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "../modes/passthrough";
import type { BenchmarkConfig, DatasetItem, ResultItem } from "../types";

export type Check =
  | { type: "contains" | "not_contains" | "regex" | "exact"; value: string }
  | { type: "numeric"; value: number };

export interface EvalItem {
  id: string;
  category: string;
  prompt: string;
  check: Check;
}

/** Score a single model output against an item's check. Pure — unit-tested. */
export function score(check: Check, out: string): boolean {
  const lower = out.toLowerCase();
  switch (check.type) {
    case "contains":
      return lower.includes(check.value.toLowerCase());
    case "not_contains":
      return !lower.includes(check.value.toLowerCase());
    case "regex":
      return new RegExp(check.value, "i").test(out);
    case "exact":
      return out.trim() === check.value;
    case "numeric": {
      // Accept the target number anywhere in the output (tolerates "= 391.").
      const nums = out.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g) ?? [];
      return nums.some((n) => Number(n) === check.value);
    }
  }
}

export const SMOKE_EVAL_PATH = join(import.meta.dir, "..", "smoke-eval.json");

export function loadSmokeItems(): EvalItem[] {
  return (JSON.parse(readFileSync(SMOKE_EVAL_PATH, "utf8")) as { items: EvalItem[] }).items;
}

/** Tracked with the repo — nothing to download. */
export async function loadSmoke(_dir: string, limit?: number): Promise<DatasetItem[]> {
  const items = loadSmokeItems().map((i) => ({
    id: i.id,
    question: i.prompt,
    answer: JSON.stringify(i.check),
    category: i.category,
    metadata: { check: i.check },
  }));
  return limit ? items.slice(0, limit) : items;
}

export async function runChecks(
  items: DatasetItem[],
  config: BenchmarkConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<ResultItem[]> {
  const results: ResultItem[] = [];
  const queue = [...items];
  let completed = 0;
  async function worker() {
    while (true) {
      const item = queue.shift();
      if (!item) return;
      const start = performance.now();
      let actual = "";
      let correct = false;
      try {
        actual = await query(
          config.endpoint,
          config.model,
          [{ role: "user", content: item.question }],
          config.apiKey,
        );
        correct = score(item.metadata?.check as Check, actual);
      } catch (e) {
        actual = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      results.push({
        id: item.id,
        question: item.question.slice(0, 300),
        expected: item.answer,
        actual: actual.slice(0, 200),
        correct,
        latencyMs: performance.now() - start,
        category: item.category,
      });
      completed++;
      onProgress?.(completed, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, () => worker()));
  return results;
}
