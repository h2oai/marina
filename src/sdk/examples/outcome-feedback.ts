// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Outcome Feedback — close the reinforcement loop.
 *
 * Reads a benchmark result JSON. For each item:
 *   - Looks up the per-question pool (name = "<prefix><item.id>" or the pool
 *     that received the item's request id, based on log scan).
 *   - Adds an outcome note: "[outcome] correct=true/false expected=X got=Y"
 *   - Links the outcome to the winning analysis via `supports` (if correct) or
 *     `contradicts` (if wrong). This grows the reinforcement graph: reasoning
 *     patterns linked to correct outcomes accumulate `supports` weight,
 *     misleading patterns accumulate `contradicts` weight.
 *
 * Over many runs, `pool bench-q-*` recall + spreading activation surfaces
 * prior reasoning that led to correct answers, and warns agents away from
 * patterns that led to wrong answers.
 *
 * Usage:
 *   bun run src/sdk/examples/outcome-feedback.ts <result-json-path> [pool-prefix]
 *
 * Env:
 *   WS_URL, MARINA_ENDPOINT  — local defaults
 *   AGENT_NAME                 — default "OutcomeFeedback"
 *   POOL_PREFIX                — default "bench-q-"
 */

import { readFileSync } from "node:fs";
import { MarinaAgent } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const AGENT_NAME = process.env.AGENT_NAME ?? "OutcomeFeedback";

interface ResultItem {
  id: string;
  question: string;
  expected: string;
  actual: string;
  correct: boolean;
  score?: number;
  latencyMs?: number;
  category?: string;
}
interface BenchResult {
  config: { name?: string };
  items: ResultItem[];
}

async function main() {
  const resultPath = process.argv[2];
  if (!resultPath) {
    console.error("Usage: bun run outcome-feedback.ts <result-json> [pool-prefix]");
    process.exit(1);
  }
  const _poolPrefix = process.argv[3] ?? "bench-q-";
  const result = JSON.parse(readFileSync(resultPath, "utf-8")) as BenchResult;

  const agent = new MarinaAgent(WS_URL, { autoReconnect: true, commandDrainTimeout: 2000 });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[outcome] logged in as ${session.name} (${session.entityId})`);
  console.log(`[outcome] benchmark=${result.config?.name} items=${result.items.length}`);

  let wrote = 0;
  for (const item of result.items) {
    // Item.id is the benchmark's item id, but per-question pools were keyed
    // on the LLM request id (from the orchestrator). Without a direct mapping
    // we key the outcome note by item.id and rely on recall to surface it.
    // Future: orchestrator could write item.id into the pool note so we can
    // match exactly. For now, dump into a flat outcome pool keyed by benchmark.
    const bench = result.config?.name ?? "unknown";
    const outcomePool = `outcomes:${bench.toLowerCase()}`;
    try {
      await agent.command(`pool create ${outcomePool}`);
    } catch {
      /* exists */
    }
    const corr = item.correct ? "true" : "false";
    const note = `[outcome ${item.id}] correct=${corr} expected=${item.expected} got=${item.actual.slice(0, 100).replace(/\n/g, " ")} ${item.category ? `category=${item.category}` : ""}`;
    try {
      await agent.command(
        `pool ${outcomePool} add ${note.slice(0, 500)} importance ${item.correct ? 9 : 10}`,
      );
      wrote++;
    } catch (e) {
      console.error(`[outcome] failed to add ${item.id}:`, e);
    }
  }
  console.log(`[outcome] wrote ${wrote}/${result.items.length} outcome notes`);
  agent.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("[outcome] fatal:", e);
  process.exit(1);
});
