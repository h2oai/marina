// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { mulberry32 } from "../stats";
import { queryWithUsage } from "../modes/passthrough";
import type { BenchmarkConfig, DatasetItem, ItemUsage, Message, ResultItem } from "../types";
import { addCallUsage } from "../usage";

const LETTERS = "ABCDEFGHIJ";

/**
 * Datasets hard enough that a letter-only reply forfeits accuracy: the model
 * reasons first and ends with an `Answer: X` line, which `extractLetter` reads.
 */
const REASONING_DATASETS = new Set(["gpqa-diamond"]);

const LETTER_ONLY_PROMPT =
  "Answer the multiple-choice question. Reply with ONLY the letter of the correct answer.";

const REASONING_PROMPT =
  "Answer the multiple-choice question. Think it through, then end your reply with a final line of the form `Answer: X`, where X is the letter of the single correct option.";

export function formatMCPrompt(item: DatasetItem, reasoning = false): Message[] {
  const choices = item.choices ?? [];
  const choiceText = choices.map((c, i) => `${LETTERS[i]}) ${c}`).join("\n");

  return [
    { role: "system", content: reasoning ? REASONING_PROMPT : LETTER_ONLY_PROMPT },
    { role: "user", content: `${item.question}\n\n${choiceText}\n\nAnswer:` },
  ];
}

/**
 * The option letter a response commits to, limited to the first `nChoices`
 * letters (so a four-option question never reads a stray "I" or "F" as an answer).
 */
export function extractLetter(response: string, nChoices = LETTERS.length): string {
  const span = LETTERS.slice(0, Math.max(1, Math.min(LETTERS.length, nChoices)));
  const cls = `[${span[0]}-${span[span.length - 1]}]`;
  const cleaned = response.trim().toUpperCase();
  // 1. Prefer explicit "answer is X" / "answer: X" / "answer = X" — take LAST occurrence.
  const explicit = [
    ...cleaned.matchAll(
      new RegExp(`ANSWER\\s*(?:IS|:|=|WOULD BE)\\s*\\(?\\**\\(?(${cls})\\)?\\**\\)?(?![A-Z])`, "g"),
    ),
  ];
  if (explicit.length > 0) return explicit[explicit.length - 1]?.[1] ?? "";
  // 2. If response is short (<= 5 chars), first letter wins.
  if (cleaned.length <= 5) {
    const m = cleaned.match(new RegExp(`\\b(${cls})\\b`));
    if (m) return m[1] ?? "";
  }
  // 3. Otherwise scan for the LAST standalone letter — reasoning usually ends with the answer.
  const all = [...cleaned.matchAll(new RegExp(`\\b(${cls})\\b`, "g"))];
  if (all.length > 0) return all[all.length - 1]?.[1] ?? "";
  // 4. Last-resort first character.
  if (cleaned.length > 0 && new RegExp(cls).test(cleaned[0] ?? "")) return cleaned[0] ?? "";
  return "";
}

/** 32-bit FNV-1a, to derive a per-item shuffle seed from (run seed, item id). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic per-seed option order. Expects `item.answer` to be the letter of
 * the correct option in the CURRENT order and returns the item with permuted
 * `choices` and the correct option's new letter. Same (seed, id) ⇒ same order;
 * a different seed reorders, so a position bias cannot follow the answer.
 */
export function shuffleChoices(item: DatasetItem, seed: number): DatasetItem {
  const choices = item.choices ?? [];
  const correct = LETTERS.indexOf(item.answer.trim().toUpperCase());
  if (choices.length < 2 || correct < 0 || correct >= choices.length) return item;
  const rand = mulberry32(fnv1a(`${seed}:${item.id}`));
  const order = choices.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  return {
    ...item,
    choices: order.map((o) => choices[o] as string),
    answer: LETTERS[order.indexOf(correct)] as string,
  };
}

export async function runMultipleChoice(
  items: DatasetItem[],
  config: BenchmarkConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<ResultItem[]> {
  const results: ResultItem[] = [];
  const isTruthfulQA = config.dataset === "truthfulqa";
  const reasoning = REASONING_DATASETS.has(config.dataset);
  const queue = [...items];
  let completed = 0;

  // N workers pulling from a shared queue — correct at any concurrency, no
  // microtask races, no settled-promise leaks. (The prior race-based pool
  // was buggy: Promise.resolve(false) always beat pool[i].then(() => true)
  // in the microtask order, so settled tasks never got spliced and the pool
  // grew unbounded — effectively disabling the concurrency cap.)
  async function worker() {
    while (true) {
      const item = queue.shift();
      if (!item) return;
      const messages = formatMCPrompt(item, reasoning);
      const start = performance.now();
      let actual = "";
      let rawResponse: string | undefined;
      let correct = false;
      let score: number | undefined;
      let usage: ItemUsage | undefined;

      try {
        const reply = await queryWithUsage(config.endpoint, config.model, messages, config.apiKey);
        usage = addCallUsage(undefined, reply.usage);
        actual = extractLetter(reply.content, item.choices?.length);
        if (reasoning) rawResponse = reply.content.slice(0, 4000);

        if (isTruthfulQA) {
          const correctIndices = item.answer.split(",").map(Number);
          const selectedIndex = LETTERS.indexOf(actual);
          correct = correctIndices.includes(selectedIndex);
          score = correct ? 1 : 0;
        } else {
          correct = actual === item.answer.trim().toUpperCase();
        }
      } catch (e) {
        actual = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }

      const latencyMs = performance.now() - start;
      results.push({
        id: item.id,
        question: item.question,
        expected: item.answer,
        actual,
        ...(rawResponse !== undefined ? { rawResponse } : {}),
        correct,
        score,
        latencyMs,
        category: item.category,
        ...(usage ? { usage } : {}),
      });

      completed++;
      onProgress?.(completed, items.length);
    }
  }

  const n = Math.max(1, config.concurrency);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
