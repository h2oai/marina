// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { query } from "../modes/passthrough";
import type { BenchmarkConfig, DatasetItem, Message, ResultItem } from "../types";

/** Extract the final numeric / symbolic answer from a free-form response.
 *  Priority order:
 *   1. \boxed{...}   (MATH convention)
 *   2. "#### N"      (GSM8K convention)
 *   3. "answer is X"
 *   4. Last number/fraction in the response
 */
function extractAnswer(response: string): string {
  // 1. \boxed{…} — MATH uses this. Take the INNERMOST content.
  const boxed = [...response.matchAll(/\\boxed\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)];
  if (boxed.length > 0) return boxed[boxed.length - 1]![1]!.trim();

  // 2. "#### N" — GSM8K
  const gsm = response.match(/####\s*(-?[\d,.]+(?:\/[\d]+)?)/);
  if (gsm) return gsm[1]!.replace(/,/g, "").trim();

  // 3. "The answer is X" / "Final answer: X"
  const explicit = response.match(/(?:the\s+)?(?:final\s+)?answer\s*(?:is|:|=)\s*\$?([^\n.,]+?)(?:\.|,|\n|$)/i);
  if (explicit) return explicit[1]!.trim().replace(/^[$\s]+|[$\s]+$/g, "");

  // 4. Last number in text
  const nums = [...response.matchAll(/(-?\d+(?:\.\d+)?(?:\/\d+)?)/g)];
  if (nums.length > 0) return nums[nums.length - 1]![1]!;

  return "";
}

/** Normalize numeric strings for comparison.
 *  Handles: "1,000" → "1000", "1/2" → "0.5", "$42" → "42", "\frac{1}{2}" → "0.5" */
function normalize(s: string): string {
  let t = s.trim().toLowerCase();
  t = t.replace(/[,$\\]/g, "");
  t = t.replace(/^\s*\{|\}\s*$/g, "");
  t = t.replace(/\\frac\{(-?\d+)\}\{(-?\d+)\}/g, (_m, a, b) => {
    const n = Number.parseFloat(a) / Number.parseFloat(b);
    return Number.isFinite(n) ? n.toString() : _m;
  });
  // Simple fraction a/b
  const frac = t.match(/^(-?\d+)\/(-?\d+)$/);
  if (frac) {
    const n = Number.parseFloat(frac[1]!) / Number.parseFloat(frac[2]!);
    if (Number.isFinite(n)) t = n.toString();
  }
  // Trailing zeros on decimals
  if (/^-?\d+\.\d+$/.test(t)) t = Number.parseFloat(t).toString();
  return t;
}

function answersMatch(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  const fa = Number.parseFloat(na);
  const fb = Number.parseFloat(nb);
  if (Number.isFinite(fa) && Number.isFinite(fb)) {
    return Math.abs(fa - fb) < 1e-6;
  }
  return false;
}

export async function runNumeric(
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
            "Solve the problem step by step. At the end, write your final numeric answer inside \\boxed{...}. If a number, give it as a decimal or integer (not a fraction). No extra text after the boxed answer.",
        },
        { role: "user", content: item.question },
      ];
      const start = performance.now();
      let actual = "";
      let extracted = "";
      let correct = false;
      try {
        const response = await query(config.endpoint, config.model, messages, config.apiKey);
        actual = response;
        extracted = extractAnswer(response);
        correct = answersMatch(extracted, item.answer);
      } catch (e) {
        actual = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      const latencyMs = performance.now() - start;
      results.push({
        id: item.id,
        question: item.question.slice(0, 300),
        expected: item.answer,
        actual: extracted || actual.slice(0, 100),
        correct,
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
