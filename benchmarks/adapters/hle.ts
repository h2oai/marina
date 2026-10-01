// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Humanity's Last Exam style items (HLE-Verified Gold, text-only).
 *
 * Two answer types, both carried on `item.metadata.answerType`:
 *   - `multipleChoice`: the options are inside the question text and the
 *     reference is a letter. Scored by exact letter — no judge.
 *   - `exactMatch`: a short reference answer. A normalized exact match scores
 *     without a judge; anything else goes to the strict equivalence judge
 *     (`judgeEquivalence`, the run's `--judge-model`). A judge failure scores
 *     the item wrong and is recorded as `judge: "error"`.
 */

import { queryWithUsage } from "../modes/passthrough";
import { judgeEquivalence } from "../scoring/judge";
import type { BenchmarkConfig, DatasetItem, ItemUsage, Message, ResultItem } from "../types";
import { addCallUsage } from "../usage";

const MC_SYSTEM =
  "Your response should be in the following format:\nExplanation: {your explanation for your answer choice}\nAnswer: {the letter of your chosen answer}\nConfidence: {your confidence score between 0% and 100% for your answer}";

const EXACT_SYSTEM =
  "Your response should be in the following format:\nExplanation: {your explanation for your final answer}\nExact Answer: {your succinct, final answer}\nConfidence: {your confidence score between 0% and 100% for your answer}";

export function isMultipleChoice(item: DatasetItem): boolean {
  return item.metadata?.answerType === "multipleChoice";
}

export function formatHLEPrompt(item: DatasetItem): Message[] {
  return [
    { role: "system", content: isMultipleChoice(item) ? MC_SYSTEM : EXACT_SYSTEM },
    { role: "user", content: item.question },
  ];
}

/** The text after the LAST `Exact Answer:` / `Final Answer:` / `Answer:` label, if any. */
export function extractFinalAnswer(response: string): string | undefined {
  const matches = [
    ...response.matchAll(
      /^[\s*#>-]*(?:exact answer|final answer|answer)\s*\**\s*[:：]\s*\**\s*(.+)$/gim,
    ),
  ];
  const last = matches[matches.length - 1]?.[1];
  return last?.replace(/\*+\s*$/g, "").trim() || undefined;
}

/** The letter a multiple-choice response commits to (A–Z), or "". */
export function extractChoiceLetter(response: string): string {
  const final = extractFinalAnswer(response);
  if (final) {
    // First standalone capital letter of the answer line, skipping the pronoun
    // "I" ("I think C" → C, "B is correct" → B, "(A) Paris" → A).
    for (const m of final.matchAll(/(?<![A-Za-z])([A-Z])(?![A-Za-z])/g)) {
      const at = m.index ?? 0;
      if (m[1] === "I" && /^I\s+[a-z]/.test(final.slice(at))) continue;
      if (m[1]) return m[1];
    }
  }
  const inline = [
    ...response.toUpperCase().matchAll(/ANSWER\s*(?:IS|:)\s*\(?\**([A-Z])(?![A-Z])/g),
  ];
  if (inline.length > 0) return inline[inline.length - 1]?.[1] ?? "";
  const bare = response.trim().toUpperCase();
  return /^[A-Z]$/.test(bare) ? bare : "";
}

/** Lowercase, drop TeX wrappers, `$`, surrounding quotes, whitespace and a trailing period. */
export function normalizeShortAnswer(s: string): string {
  return s
    .replace(/\\boxed\{([^{}]*)\}/g, "$1")
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/\$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\.$/, "")
    .trim()
    .toLowerCase();
}

/** The part of a response the judge reads: the labelled final answer, else the tail. */
function judgeExcerpt(response: string): string {
  return extractFinalAnswer(response) ?? response.slice(-2000);
}

export async function runHLE(
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
      let rawResponse = "";
      let correct = false;
      let usage: ItemUsage | undefined;
      let judgeUsage: ItemUsage | undefined;
      let judge: ResultItem["judge"];
      try {
        const reply = await queryWithUsage(
          config.endpoint,
          config.model,
          formatHLEPrompt(item),
          config.apiKey,
        );
        usage = addCallUsage(undefined, reply.usage);
        rawResponse = reply.content;
        if (isMultipleChoice(item)) {
          actual = extractChoiceLetter(reply.content);
          correct = actual !== "" && actual === item.answer.trim().toUpperCase();
        } else {
          actual = extractFinalAnswer(reply.content) ?? reply.content.trim().slice(-200);
          if (normalizeShortAnswer(actual) === normalizeShortAnswer(item.answer)) {
            correct = true;
          } else if (config.judge) {
            const verdict = await judgeEquivalence(
              item.question,
              item.answer,
              judgeExcerpt(reply.content),
              config.judge,
              config.apiKey,
            );
            judge = verdict.verdict;
            judgeUsage = verdict.usage;
            correct = verdict.verdict === "correct";
          }
        }
      } catch (e) {
        actual = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      results.push({
        id: item.id,
        question: item.question.slice(0, 300),
        expected: item.answer,
        actual: actual.slice(0, 200),
        rawResponse: rawResponse.slice(0, 4000),
        correct,
        score: correct ? 1 : 0,
        latencyMs: performance.now() - start,
        category: item.category,
        ...(usage ? { usage } : {}),
        ...(judgeUsage ? { judgeUsage } : {}),
        ...(judge ? { judge } : {}),
      });
      completed++;
      onProgress?.(completed, items.length);
    }
  }

  const n = Math.max(1, config.concurrency);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
