// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { judgeResponse } from "../scoring/judge";
import { query } from "../modes/passthrough";
import type { BenchmarkConfig, DatasetItem, Message, ResultItem } from "../types";

/** Short-answer factual adapter (SimpleQA-style).
 *  Scoring: LLM-as-judge "does the answer contain the correct fact?"
 *  Falls back to normalized substring match if judge fails. */

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function substringMatch(actual: string, expected: string): boolean {
  const na = normalize(actual);
  const ne = normalize(expected);
  if (!ne) return false;
  return na.includes(ne) || ne.includes(na);
}

export async function runShortAnswer(
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
      const messages: Message[] = [
        {
          role: "system",
          content:
            "Answer the factual question concisely — at most a phrase or one sentence. Commit to your best guess: on factual benchmarks, refusal scores the same as a wrong answer, so hedging never helps.",
        },
        { role: "user", content: item.question },
      ];
      const start = performance.now();
      let actual = "";
      let rawResponse = "";
      let correct = false;
      let score = 0;
      try {
        actual = await query(config.endpoint, config.model, messages, config.apiKey);
        rawResponse = actual;
        // Primary check: normalized substring. Cheap, no LLM.
        if (substringMatch(actual, item.answer)) {
          correct = true;
          score = 1;
        } else if (config.judge) {
          // Fallback: LLM judge for paraphrases / near-matches
          const judgeScore = await judgeResponse(
            item.question,
            item.answer,
            actual,
            config.judge,
            config.apiKey,
          );
          correct = judgeScore >= 7;
          score = judgeScore / 10;
        }
      } catch (e) {
        actual = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      const latencyMs = performance.now() - start;
      results.push({
        id: item.id,
        question: item.question.slice(0, 300),
        expected: item.answer,
        actual: actual.slice(0, 200),
        rawResponse: rawResponse.slice(0, 4000),
        correct,
        score,
        latencyMs,
        category: item.category,
      });
      completed++;
      onProgress?.(completed, items.length);
    }
  }

  const n = Math.max(1, config.concurrency);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
