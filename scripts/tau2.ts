#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * τ²-bench results → Marina's benchmark ledger (thin adapter; see docs/guides/tau2.md).
 *
 *   bun run tau2 summary <results.json>              pass^1..pass^k and reward per run
 *   bun run tau2 convert <results.json> --out f.json harness-shaped file for `bun run benchmark:import`
 *
 * τ²-bench itself runs unmodified: point its `--agent-llm` / `--user-llm` at a
 * Marina `/v1` (LiteLLM `openai/<model>` with `api_base`). Nothing here talks to
 * a leaderboard.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { passHatK, servedModel, type Tau2Results, tau2ToHarness } from "../benchmarks/tau2/convert";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { out: { type: "string" }, benchmark: { type: "string" } },
});
const [cmd, file] = positionals;
if (!cmd || !file || (cmd !== "summary" && cmd !== "convert")) {
  console.error(
    "usage: bun run tau2 summary|convert <results.json> [--out file.json] [--benchmark id]",
  );
  process.exit(2);
}
const results = JSON.parse(readFileSync(file, "utf8")) as Tau2Results;
if (cmd === "summary") {
  const trials = results.info?.num_trials ?? 1;
  const sims = results.simulations ?? [];
  const reward =
    sims.reduce((t, s) => t + (s.reward_info?.reward ?? 0), 0) / Math.max(1, sims.length);
  console.log(
    `${results.info?.environment_info?.domain_name ?? "?"} · agent ${servedModel(results.info?.agent_info?.llm)} · user ${servedModel(results.info?.user_info?.llm)} · ${sims.length} simulations`,
  );
  console.log(`mean reward ${reward.toFixed(3)}`);
  for (let k = 1; k <= trials; k++)
    console.log(`pass^${k} ${passHatK(results, k)?.toFixed(3) ?? "n/a"}`);
} else {
  const out = values.out ?? file.replace(/\.json$/, ".ledger.json");
  writeFileSync(
    out,
    JSON.stringify(tau2ToHarness(results, { benchmark: values.benchmark }), null, 1),
  );
  console.log(`wrote ${out}`);
}
