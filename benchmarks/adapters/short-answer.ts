// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { excludedSource } from "../../src/arena/research/web-search";
import { standaloneSearchHttp } from "../../src/engine/search-providers/asof-http";
import {
  initProvidersSync,
  type SearchResult,
  search,
} from "../../src/engine/search-providers/index";
import { queryWithUsage, replyLabels } from "../modes/passthrough";
import { judgeResponseWithUsage } from "../scoring/judge";
import type { BenchmarkConfig, DatasetItem, ItemUsage, Message, ResultItem } from "../types";
import { addCallUsage } from "../usage";

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
  if (!na || !ne) return false;
  return na.includes(ne) || ne.includes(na);
}

/**
 * Pages that would hand the model the benchmark's own answer key: the dataset,
 * its repository and mirrors. A grounded run must never read them.
 */
const GROUND_BARS: Record<string, { urls: string[]; names: string[] }> = {
  simpleqa: {
    urls: [
      "*/datasets/*/*simpleqa*",
      "*/datasets/*/*simple-qa*",
      "*/datasets/*/*simple_qa*",
      "github.com/openai/simple-evals",
      "github.com/*/*simple-evals*",
      "github.com/*/*simpleqa*",
      "openaipublic.blob.core.windows.net/simple-evals",
      "kaggle.com/datasets/*/*simpleqa*",
    ],
    names: ["simpleqa", "simple-qa", "simple_qa", "simple-evals"],
  },
  frames: {
    urls: [
      "*/datasets/google/frames-benchmark",
      "*/datasets/*/*frames*",
      "github.com/*/*frames-benchmark*",
      "kaggle.com/datasets/*/*frames*",
    ],
    names: ["frames-benchmark", "frames benchmark"],
  },
};

/** What grounding did across a run, so an empty-evidence run is never mistaken for a grounded one. */
export interface GroundingStats {
  items: number;
  withEvidence: number;
  barred: number;
  failures: number;
}

/** True for a search result from the dataset's own sources (by URL, or by naming the dataset). */
export function groundingBarred(dataset: string): (r: SearchResult) => boolean {
  const bars = GROUND_BARS[dataset] ?? { urls: [], names: [] };
  const barredUrl = excludedSource({ urls: bars.urls });
  return (r) => {
    const text = `${r.url} ${r.title} ${r.snippet}`.toLowerCase();
    return barredUrl(r.url, r.title) || bars.names.some((n) => text.includes(n));
  };
}

/** Live search evidence for one question, with the dataset's own sources removed. */
async function groundEvidence(
  question: string,
  dataset: string,
  stats: GroundingStats,
): Promise<string[]> {
  stats.items++;
  const barred = groundingBarred(dataset);
  try {
    initProvidersSync();
    const failures: string[] = [];
    const results = await search(question, { maxResults: 8, failures }, standaloneSearchHttp());
    stats.failures += failures.length;
    const kept = results.filter((r) => {
      if (barred(r)) {
        stats.barred++;
        return false;
      }
      return r.snippet.trim().length > 0;
    });
    const evidence = kept
      .slice(0, 5)
      .map((r) => (r.title ? `${r.title}: ${r.snippet}` : r.snippet));
    if (evidence.length > 0) stats.withEvidence++;
    return evidence;
  } catch {
    stats.failures++;
    return []; // allow-empty-catch: grounding is best-effort; the item is answered unaided and counted
  }
}

export async function runShortAnswer(
  items: DatasetItem[],
  config: BenchmarkConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<ResultItem[]> {
  const results: ResultItem[] = [];
  const grounding: GroundingStats = { items: 0, withEvidence: 0, barred: 0, failures: 0 };
  const queue = [...items];
  let completed = 0;

  async function worker() {
    while (true) {
      const item = queue.shift();
      if (!item) return;
      const start = performance.now();
      const evidence =
        config.ground === "search"
          ? await groundEvidence(item.question, config.dataset, grounding)
          : [];
      const system =
        (evidence.length
          ? `Relevant search results — answer from these where they suffice, otherwise use your own knowledge:\n${evidence.map((e, i) => `[${i + 1}] ${e}`).join("\n")}\n\n`
          : "") +
        "Answer the factual question concisely — at most a phrase or one sentence. Commit to your best guess: on factual benchmarks, refusal scores the same as a wrong answer, so hedging never helps.";
      const messages: Message[] = [
        { role: "system", content: system },
        { role: "user", content: item.question },
      ];
      let actual = "";
      let rawResponse = "";
      let correct = false;
      let score = 0;
      let usage: ItemUsage | undefined;
      let judgeUsage: ItemUsage | undefined;
      let traceId: string | undefined;
      let labels: ReturnType<typeof replyLabels> = {};
      try {
        const reply = await queryWithUsage(config.endpoint, config.model, messages, config.apiKey);
        usage = addCallUsage(undefined, reply.usage);
        traceId = reply.requestId;
        labels = replyLabels(reply);
        actual = reply.content;
        rawResponse = actual;
        // Primary check: normalized substring. Cheap, no LLM.
        if (substringMatch(actual, item.answer)) {
          correct = true;
          score = 1;
        } else if (config.judge) {
          // Fallback: LLM judge for paraphrases / near-matches
          const judged = await judgeResponseWithUsage(
            item.question,
            item.answer,
            actual,
            config.judge,
            config.apiKey,
          );
          judgeUsage = judged.usage;
          const judgeScore = judged.score;
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
        ...(usage ? { usage } : {}),
        ...(judgeUsage ? { judgeUsage } : {}),
        ...(traceId ? { traceId } : {}),
        ...(config.ground === "search" ? { evidence: evidence.length } : {}),
        ...labels,
      });
      completed++;
      onProgress?.(completed, items.length);
    }
  }

  const n = Math.max(1, config.concurrency);
  await Promise.all(Array.from({ length: n }, () => worker()));
  if (config.ground === "search") {
    console.log(
      `\n  Grounding: ${grounding.withEvidence}/${grounding.items} items had evidence · ${grounding.barred} results barred · ${grounding.failures} search failures`,
    );
  }
  return results;
}
