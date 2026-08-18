// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { query } from "../modes/passthrough";
import { checkInstruction } from "../scoring/ifeval-checks";
import type { BenchmarkConfig, DatasetItem, Message, ResultItem } from "../types";

export async function runIFEval(
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
      const messages: Message[] = [{ role: "user", content: item.question }];
      const start = performance.now();
      let actual = "";
      let allPassed = false;
      let passedCount = 0;
      let totalConstraints = 0;

      try {
        actual = await query(config.endpoint, config.model, messages, config.apiKey);
        const instructionIds = (item.metadata?.instruction_id_list as string[]) ?? [];
        const kwargs = (item.metadata?.kwargs as Record<string, unknown>[]) ?? [];
        totalConstraints = instructionIds.length;
        passedCount = 0;
        for (let i = 0; i < instructionIds.length; i++) {
          const passed = checkInstruction(actual, instructionIds[i], kwargs[i] ?? {});
          if (passed) passedCount++;
        }
        allPassed = passedCount === totalConstraints;
      } catch (e) {
        actual = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }

      const latencyMs = performance.now() - start;
      results.push({
        id: item.id,
        question: item.question,
        expected: `${totalConstraints} constraints`,
        actual: `${passedCount}/${totalConstraints} passed`,
        rawResponse: actual.slice(0, 4000),
        correct: allPassed,
        score: totalConstraints > 0 ? passedCount / totalConstraints : 0,
        latencyMs,
        category: "ifeval",
      });
      completed++;
      onProgress?.(completed, items.length);
    }
  }

  const n = Math.max(1, config.concurrency);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
