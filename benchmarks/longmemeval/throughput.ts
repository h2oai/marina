#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ingestion throughput for one LongMemEval-V2 haystack, without a model call:
 *
 *   bun benchmarks/longmemeval/throughput.ts --data <dataset dir> --tier small \
 *     --domain web [--question <id>] [--limit N] [--queries 20] [--work <dir>]
 *
 * Builds a fresh store for the haystack of `--question` (default: the domain's
 * first question; small-tier questions in one domain share one haystack), reports
 * records, bytes, seconds and MB/s, then times `--queries` searches whose text is
 * each trajectory's own goal (never a benchmark question). The database is deleted
 * afterwards unless --keep.
 */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { goalText, type LmeTrajectory } from "./records";
import { DEFAULT_STORE, LmeMemoryStore } from "./store";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    data: { type: "string" },
    tier: { type: "string", default: "small" },
    domain: { type: "string", default: "web" },
    question: { type: "string" },
    limit: { type: "string" },
    queries: { type: "string", default: "20" },
    work: { type: "string" },
    keep: { type: "boolean" },
  },
});
const data = values.data;
if (!data) throw new Error("--data <dataset dir> is required");
const haystacks = (await Bun.file(
  join(data, "haystacks", `lme_v2_${values.tier}.json`),
).json()) as Record<string, string[]>;
let questionId = values.question;
if (!questionId) {
  for await (const line of lines(join(data, "questions.jsonl"))) {
    const q = JSON.parse(line) as { id: string; domain: string };
    if (q.domain === values.domain) {
      questionId = q.id;
      break;
    }
  }
}
const wanted = haystacks[questionId ?? ""];
if (!wanted) throw new Error("no haystack for the selected question");
const ids = values.limit ? wanted.slice(0, Number(values.limit)) : wanted;
const work = values.work ?? join(process.env.TMPDIR ?? "/tmp", `lme-throughput-${process.pid}`);
mkdirSync(work, { recursive: true });
const dbPath = join(work, "memory.db");
process.env.MARINA_DB_DURABILITY ??= "normal";
const store = LmeMemoryStore.open(dbPath, DEFAULT_STORE);

const need = new Set(ids);
const goals: string[] = [];
let records = 0;
let bytes = 0;
let insertMs = 0;
const started = performance.now();
for await (const line of lines(join(data, "trajectories.jsonl"))) {
  // Cheap pre-filter on the id field before parsing a large line.
  const head = line.slice(0, 64);
  const match = /"id":\s*"([^"]+)"/.exec(head);
  if (!match || !need.has(match[1]!)) continue;
  const trajectory = JSON.parse(line) as LmeTrajectory;
  const r = store.insert(trajectory);
  records += r.records;
  bytes += r.bytes;
  insertMs += r.ms;
  if (goals.length < Number(values.queries)) goals.push(goalText(trajectory.goal));
  need.delete(trajectory.id);
  if (need.size === 0) break;
}
const wallS = (performance.now() - started) / 1000;
const latencies: number[] = [];
for (const goal of goals) {
  if (!goal) continue;
  const q = await store.query(goal.slice(0, 400));
  latencies.push(q.ms);
}
const dbBytes = statSync(dbPath).size;
await store.close();
latencies.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      question: questionId,
      tier: values.tier,
      trajectories: ids.length - need.size,
      missing: need.size,
      records,
      content_mb: +(bytes / 1e6).toFixed(1),
      insert_s: +(insertMs / 1000).toFixed(1),
      wall_s: +wallS.toFixed(1),
      insert_mb_per_s: +(bytes / 1e6 / (insertMs / 1000)).toFixed(2),
      db_mb: +(dbBytes / 1e6).toFixed(1),
      query_ms_p50: +(latencies[Math.floor(latencies.length / 2)] ?? 0).toFixed(1),
      query_ms_max: +(latencies.at(-1) ?? 0).toFixed(1),
    },
    null,
    1,
  ),
);
if (!values.keep) rmSync(work, { recursive: true, force: true });

async function* lines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.file(path).stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) yield line;
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) yield buffer;
}
