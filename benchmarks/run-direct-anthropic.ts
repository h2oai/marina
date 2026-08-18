// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Run A: hit Anthropic directly with the SAME 50 MMLU-Pro items as the
// harness with --seed 42 --limit 50. Uses identical prompt, model, temp.
// Output goes to benchmarks/results/mmlu-pro-direct-<ts>.json so we can
// diff against the Marina passthrough run.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seededShuffle } from "./download";
import type { DatasetItem, ResultItem } from "./types";

const MODEL = "claude-sonnet-4-20250514"; // matches proxyToAnthropic default
const LETTERS = "ABCDEFGHIJ";
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) throw new Error("ANTHROPIC_API_KEY missing");

function extractLetter(response: string): string {
  const cleaned = response.trim().toUpperCase();
  const explicit = [...cleaned.matchAll(/ANSWER\s*(?:IS|:|=|WOULD BE)\s*\(?\**([A-J])\**\)?/g)];
  if (explicit.length > 0) return explicit[explicit.length - 1][1];
  if (cleaned.length <= 5) {
    const m = cleaned.match(/\b([A-J])\b/);
    if (m) return m[1];
  }
  const all = [...cleaned.matchAll(/\b([A-J])\b/g)];
  if (all.length > 0) return all[all.length - 1][1];
  if (cleaned.length > 0 && /[A-J]/.test(cleaned[0])) return cleaned[0];
  return "";
}

async function callAnthropic(systemMsg: string, userMsg: string): Promise<string> {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        temperature: 0,
        system: systemMsg,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    if (resp.status === 429 && attempt < maxAttempts) {
      await resp.text().catch(() => "");
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1) + Math.random() * 200));
      continue;
    }
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as { content: Array<{ type: string; text: string }> };
    return data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  throw new Error("exhausted retries");
}

async function main() {
  const seed = 42;
  const limit = 50;
  const cachePath = join(import.meta.dir, "datasets", "mmlu-pro.json");
  const all = JSON.parse(readFileSync(cachePath, "utf-8")) as DatasetItem[];
  const shuffled = seededShuffle(all, seed);
  const items = shuffled.slice(0, limit);
  console.log(`Loaded ${items.length} items (seed=${seed})`);

  const results: ResultItem[] = [];
  const concurrency = 5;
  const queue = [...items];
  let completed = 0;

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const choices = item.choices ?? [];
      const choiceText = choices.map((c, i) => `${LETTERS[i]}) ${c}`).join("\n");
      const systemMsg = "Answer the multiple-choice question. Reply with ONLY the letter of the correct answer.";
      const userMsg = `${item.question}\n\n${choiceText}\n\nAnswer:`;

      const start = performance.now();
      let actual = "";
      let correct = false;
      try {
        const raw = await callAnthropic(systemMsg, userMsg);
        actual = extractLetter(raw);
        correct = actual === item.answer.trim().toUpperCase();
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
        latencyMs,
        category: item.category,
      });
      completed++;
      process.stdout.write(`\r  Progress: ${completed}/${items.length}`);
    }
  }

  const startTime = performance.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const duration_ms = performance.now() - startTime;
  process.stdout.write("\n");

  const correct = results.filter((r) => r.correct).length;
  const errors = results.filter((r) => r.actual.startsWith("ERROR:")).length;
  const overall = correct / results.length;

  const output = {
    config: { name: "MMLU-Pro", dataset: "mmlu-pro", mode: "direct-anthropic", model: MODEL, seed, limit },
    timestamp: Date.now(),
    duration_ms,
    scores: { overall, breakdown: {} },
    metadata: { total: results.length, answered: results.length - errors, errors, timeouts: 0, avgLatencyMs: 0 },
    items: results,
  };
  const outPath = join(import.meta.dir, "results", `mmlu-pro-direct-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n  Direct Anthropic — MMLU-Pro`);
  console.log(`  Overall Score: ${(overall * 100).toFixed(1)}%`);
  console.log(`  Answered: ${results.length - errors}/${results.length}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Duration: ${(duration_ms / 1000).toFixed(1)}s`);
  console.log(`  Saved: ${outPath}`);
}

await main();
