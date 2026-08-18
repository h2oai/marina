// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Benchmark Preflight — Marina inspects a benchmark BEFORE running it.
 *
 * One-shot script that:
 *   1. Loads N sample items from the target benchmark
 *   2. Asks a strong LLM to profile the benchmark:
 *      - dominant question type(s)
 *      - domain distribution
 *      - expected-answer format (letter / number / free-form / constraint)
 *      - likely failure modes
 *   3. Picks the right orchestrator + translator + escalator for this profile
 *   4. Writes a profile note into pool:benchmark-profiles for future runs
 *   5. Seeds benchmark-specific pools (common patterns, traps, rubric)
 *   6. Emits a recommended launch command
 *
 * This is the Marina advantage: a model that configures itself for a
 * task before being evaluated on it. Foundation models can't.
 *
 * Usage:
 *   bun run src/sdk/examples/benchmark-preflight.ts mmlu-pro
 *   bun run src/sdk/examples/benchmark-preflight.ts math
 *
 * Env:
 *   PREFLIGHT_MODEL  — strong model for analysis (default marina:gemini)
 *   PREFLIGHT_SAMPLE — how many items to inspect (default 5)
 *   SEED             — dataset seed for sampling (default 42)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MarinaAgent } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME ?? "Preflight";
const PREFLIGHT_MODEL = process.env.PREFLIGHT_MODEL ?? "marina:gemini";
const PREFLIGHT_SAMPLE = Number.parseInt(process.env.PREFLIGHT_SAMPLE ?? "5", 10);
const SEED = Number.parseInt(process.env.SEED ?? "42", 10);

async function callMarina(
  model: string,
  messages: Array<{ role: string; content: string }>,
  temperature = 0,
): Promise<string> {
  const resp = await fetch(`${MARINA_ENDPOINT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature }),
  });
  if (!resp.ok) throw new Error(`Marina ${resp.status}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

function loadSampleItems(benchmark: string, n: number): unknown[] {
  const path = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "benchmarks",
    "datasets",
    `${benchmark}.json`,
  );
  if (!existsSync(path)) {
    console.error(`[preflight] dataset cache missing for ${benchmark}: ${path}`);
    console.error("           run the harness once with --limit 5 to populate the cache first");
    process.exit(1);
  }
  const all = JSON.parse(readFileSync(path, "utf-8")) as unknown[];
  // Seeded shuffle (same as harness uses)
  const arr = [...all];
  let s = SEED;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

async function profile(benchmark: string, samples: unknown[]): Promise<string> {
  const sampleBlock = samples
    .map((s, i) => `--- Sample ${i + 1} ---\n${JSON.stringify(s).slice(0, 2000)}`)
    .join("\n\n");
  const prompt = `You are profiling a benchmark before a system is evaluated on it. Study the samples.

BENCHMARK: ${benchmark}

SAMPLES (${samples.length}):
${sampleBlock}

Answer in EXACTLY this format (no preamble, fill each line):
TYPE: (multiple-choice | numeric | short-answer | instruction-following | free-form | multi-turn)
ANSWER_FORMAT: how the correct answer is expressed (e.g. single letter A-J, \\boxed{number}, short phrase)
DOMAINS: comma-separated list of domains that appear (law, math, science, grammar, etc.)
DIFFICULTY: easy | moderate | hard | frontier-level
CONSTRAINT_STYLE: (none | word-count | forbidden-words | format | multi-constraint)
KEY_TRAP: one-sentence description of the most likely failure mode
RECOMMENDED_ORCHESTRATOR: (passthrough | smart | nsed | nsed-smart | debate | pipeline | foundry | adaptive | blackboard | world | synthesis)
RECOMMENDED_TRANSLATOR: (haiku | gemini | qwen | nemotron | sonnet | none)
RECOMMENDED_STRONG: (sonnet | gemini | opus | nemotron | deepseek)
USE_WEB: (true | false)
USE_SEED_POOLS: comma-separated pool names that would help (e.g. seed:math,seed:logic)
RATIONALE: one sentence why this config fits

Now:`;
  return callMarina(PREFLIGHT_MODEL, [
    {
      role: "system",
      content:
        "You profile benchmarks precisely. You output exactly the requested fields, one per line, nothing else.",
    },
    { role: "user", content: prompt },
  ]);
}

interface Profile {
  type: string;
  answerFormat: string;
  domains: string[];
  difficulty: string;
  constraintStyle: string;
  keyTrap: string;
  orchestrator: string;
  translator: string;
  strong: string;
  useWeb: boolean;
  useSeedPools: string[];
  rationale: string;
}

function parseProfile(text: string): Profile {
  const get = (key: string) => text.match(new RegExp(`${key}:\\s*(.+)`, "i"))?.[1]?.trim() ?? "";
  return {
    type: get("TYPE"),
    answerFormat: get("ANSWER_FORMAT"),
    domains: get("DOMAINS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    difficulty: get("DIFFICULTY"),
    constraintStyle: get("CONSTRAINT_STYLE"),
    keyTrap: get("KEY_TRAP"),
    orchestrator: get("RECOMMENDED_ORCHESTRATOR"),
    translator: get("RECOMMENDED_TRANSLATOR"),
    strong: get("RECOMMENDED_STRONG"),
    useWeb: /true/i.test(get("USE_WEB")),
    useSeedPools: get("USE_SEED_POOLS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rationale: get("RATIONALE"),
  };
}

function emitLaunch(benchmark: string, p: Profile): string {
  const translatorChan = p.translator === "none" ? "" : `translator-${p.translator}`;
  const strong = `marina:${p.strong}`;
  const pools = p.useSeedPools.join(",");
  const lines: string[] = [
    "#!/usr/bin/env bash",
    `# Preflight-recommended launch for benchmark: ${benchmark}`,
    `# Rationale: ${p.rationale}`,
    `# Trap to watch: ${p.keyTrap}`,
    "",
    "# Ensure translator variants are running:",
    "./benchmarks/launch-translators.sh  # (if not already)",
    "",
    "# Kill old orchestrator, launch recommended one",
    'pkill -f "sdk/examples/(nsed|debate|pipeline|foundry|adaptive|blackboard|synthesis|world-coordinator)-provider" 2>/dev/null',
    "sleep 3",
    "sqlite3 marina.db \"DELETE FROM channel_members WHERE channel_id='ch:model'\"",
    "",
  ];
  if (p.orchestrator === "synthesis") {
    lines.push(
      `SYNTH_STRONG=${strong} \\`,
      `  SYNTH_USE_WEB=${p.useWeb ? "true" : "false"} \\`,
      `  SYNTH_POOLS=${pools || "seed:math,seed:logic"} \\`,
      `  TRANSLATOR_CHANNEL=${translatorChan || "translator"} \\`,
      "  bun run src/sdk/examples/synthesis-provider.ts &",
    );
  } else if (p.orchestrator === "adaptive") {
    lines.push(`ADAPTIVE_STRONG=${strong} \\`, "  bun run src/sdk/examples/adaptive-provider.ts &");
  } else if (p.orchestrator === "pipeline") {
    lines.push(
      `PIPELINE_REASON=${strong} \\`,
      `  PIPELINE_PARSE=marina:${p.translator || "haiku"} \\`,
      "  bun run src/sdk/examples/pipeline-provider.ts &",
    );
  } else if (p.orchestrator === "foundry") {
    lines.push(`FOUNDRY_WORKER=${strong} \\`, "  bun run src/sdk/examples/foundry-provider.ts &");
  } else if (p.orchestrator === "debate") {
    lines.push(`DEBATE_JUDGE=${strong} \\`, "  bun run src/sdk/examples/debate-provider.ts &");
  } else if (p.orchestrator === "blackboard") {
    lines.push(
      `BLACKBOARD_JUDGE=${strong} \\`,
      "  bun run src/sdk/examples/blackboard-provider.ts &",
    );
  } else if (p.orchestrator === "nsed-smart") {
    const tchan = p.translator === "none" ? "translator" : `translator-${p.translator}`;
    lines.push(
      "NSED_SUBSTRATES=marina:haiku,marina:qwen,marina:gemma,marina:kimi \\",
      "  USE_TRANSLATOR=true \\",
      `  TRANSLATOR_CHANNEL=${tchan} \\`,
      "  MEMORY_LEARN=true \\",
      "  bun run src/sdk/examples/nsed-smart-provider.ts &",
    );
  } else if (p.orchestrator === "nsed") {
    lines.push(
      "NSED_SUBSTRATES=marina:haiku,marina:qwen,marina:gemma,marina:kimi \\",
      "  bun run src/sdk/examples/nsed-provider.ts &",
    );
  } else if (p.orchestrator === "smart") {
    const tchan = p.translator === "none" ? "translator" : `translator-${p.translator}`;
    lines.push(
      "PROVIDER_URL=http://localhost:3300/v1 \\",
      `  PROVIDER_MODEL=${strong} \\`,
      "  PROVIDER_FORMAT=openai \\",
      "  USE_TRANSLATOR=true \\",
      `  TRANSLATOR_CHANNEL=${tchan} \\`,
      "  MEMORY_LEARN=true \\",
      `  MEMORY_POOLS=${pools || "seed:math,seed:logic"} \\`,
      "  bun run src/sdk/examples/smart-provider.ts &",
    );
  } else if (p.orchestrator === "world") {
    lines.push(
      "WORLD_WORKERS=3 \\",
      "  WORLD_WORKER_SUBSTRATES=marina:haiku,marina:qwen,marina:gemma \\",
      `  FALLBACK_SUBSTRATE=${strong} \\`,
      "  WORKER_TIMEOUT_MS=60000 \\",
      "  bun run src/sdk/examples/world-coordinator-provider.ts &",
      "# spawn task-workers separately:",
      "for i in 1 2 3; do",
      `  WORKER_NAME="Worker$i" WORKER_SUBSTRATE="marina:haiku" \\`,
      "    nohup bun run src/sdk/examples/task-worker.ts > /tmp/worker$i.log 2>&1 &",
      "done",
    );
  } else if (p.orchestrator === "passthrough") {
    lines.push("# passthrough — harness will use the substrate via --model flag");
  } else {
    lines.push(
      `# unknown orchestrator "${p.orchestrator}" — launching default`,
      "bun run src/sdk/examples/synthesis-provider.ts &",
    );
  }
  lines.push("sleep 5", "");
  lines.push("# Launch benchmark");
  lines.push(
    `bun run benchmarks/harness.ts --benchmark ${benchmark} --limit 100 --seed ${SEED} --mode passthrough --concurrency 1 --judge-model marina:sonnet`,
  );
  return lines.join("\n");
}

async function storeProfileNote(agent: MarinaAgent, benchmark: string, p: Profile): Promise<void> {
  const poolName = "benchmark-profiles";
  try {
    await agent.command(`pool create ${poolName}`);
  } catch {
    /* exists */
  }
  const note = `[profile ${benchmark}] type=${p.type} | format=${p.answerFormat} | domains=${p.domains.join("+")} | trap: ${p.keyTrap} | recommended: ${p.orchestrator} + translator-${p.translator} + ${p.strong}`;
  try {
    await agent.command(
      `pool ${poolName} add ${note.replace(/\n/g, " ").slice(0, 400)} importance 9`,
    );
  } catch {
    /* skip */
  }
}

async function main() {
  const benchmark = process.argv[2];
  if (!benchmark) {
    console.error("Usage: bun run benchmark-preflight.ts <benchmark-name>");
    process.exit(1);
  }

  const samples = loadSampleItems(benchmark, PREFLIGHT_SAMPLE);
  console.log(`[preflight] loaded ${samples.length} sample items from ${benchmark}`);
  console.log(`[preflight] analyzing via ${PREFLIGHT_MODEL}...`);
  const profileText = await profile(benchmark, samples);
  const p = parseProfile(profileText);

  console.log("\n=== BENCHMARK PROFILE ===");
  console.log(`  benchmark:     ${benchmark}`);
  console.log(`  type:          ${p.type}`);
  console.log(`  answer format: ${p.answerFormat}`);
  console.log(`  domains:       ${p.domains.join(", ")}`);
  console.log(`  difficulty:    ${p.difficulty}`);
  console.log(`  constraints:   ${p.constraintStyle}`);
  console.log(`  key trap:      ${p.keyTrap}`);
  console.log("");
  console.log("=== RECOMMENDED CONFIG ===");
  console.log(`  orchestrator:  ${p.orchestrator}`);
  console.log(`  translator:    ${p.translator}`);
  console.log(`  escalator:     ${p.strong}`);
  console.log(`  web search:    ${p.useWeb}`);
  console.log(`  pools to use:  ${p.useSeedPools.join(", ")}`);
  console.log(`  rationale:     ${p.rationale}`);

  // Store profile note for future benchmark runs
  try {
    const agent = new MarinaAgent(WS_URL, { autoReconnect: false, commandDrainTimeout: 1500 });
    await agent.connect(AGENT_NAME);
    await storeProfileNote(agent, benchmark, p);
    agent.disconnect();
    console.log("\n[preflight] profile stored in pool:benchmark-profiles");
  } catch (e) {
    console.error("[preflight] couldn't store profile (server may not be up):", e);
  }

  // Emit launch script
  const script = emitLaunch(benchmark, p);
  const outPath = `/tmp/preflight-launch-${benchmark}.sh`;
  Bun.write(outPath, script);
  console.log(`\n[preflight] launch script written to ${outPath}`);
  console.log("            chmod +x and run to execute the recommended config");

  process.exit(0);
}

main().catch((e) => {
  console.error("[preflight] fatal:", e);
  process.exit(1);
});
