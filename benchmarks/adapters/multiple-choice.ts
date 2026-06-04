import { query } from "../modes/passthrough";
import type { BenchmarkConfig, DatasetItem, Message, ResultItem } from "../types";

const LETTERS = "ABCDEFGHIJ";

function formatMCPrompt(item: DatasetItem): Message[] {
  const choices = item.choices ?? [];
  const choiceText = choices.map((c, i) => `${LETTERS[i]}) ${c}`).join("\n");

  return [
    {
      role: "system",
      content:
        "Answer the multiple-choice question. Reply with ONLY the letter of the correct answer.",
    },
    {
      role: "user",
      content: `${item.question}\n\n${choiceText}\n\nAnswer:`,
    },
  ];
}

function extractLetter(response: string): string {
  const cleaned = response.trim().toUpperCase();
  // 1. Prefer explicit "answer is X" / "answer: X" / "answer = X" — take LAST occurrence.
  const explicit = [...cleaned.matchAll(/ANSWER\s*(?:IS|:|=|WOULD BE)\s*\(?\**([A-J])\**\)?/g)];
  if (explicit.length > 0) return explicit[explicit.length - 1][1];
  // 2. If response is short (<= 5 chars), first letter wins.
  if (cleaned.length <= 5) {
    const m = cleaned.match(/\b([A-J])\b/);
    if (m) return m[1];
  }
  // 3. Otherwise scan for the LAST \b[A-J]\b — reasoning usually ends with the answer.
  const all = [...cleaned.matchAll(/\b([A-J])\b/g)];
  if (all.length > 0) return all[all.length - 1][1];
  // 4. Last-resort first character.
  if (cleaned.length > 0 && /[A-J]/.test(cleaned[0])) return cleaned[0];
  return "";
}

export async function runMultipleChoice(
  items: DatasetItem[],
  config: BenchmarkConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<ResultItem[]> {
  const results: ResultItem[] = [];
  const isTruthfulQA = config.dataset === "truthfulqa";
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
      const messages = formatMCPrompt(item);
      const start = performance.now();
      let actual = "";
      let correct = false;
      let score: number | undefined;

      try {
        const response = await query(config.endpoint, config.model, messages, config.apiKey);
        actual = extractLetter(response);

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
