// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Meta-Agent — Marina self-improvement loop.
 *
 * Reads the outcomes of a recent benchmark run, diagnoses failure patterns,
 * and proposes a NEW Marina configuration (AL-{n+1}) that should do
 * better. The proposed config is a structured JSON — also written as a
 * markdown analysis and a shell script that launches AL-{n+1}.
 *
 * This is the closed loop: Marina reads its own benchmark results,
 * Marina proposes the next Marina, Marina can spawn that next
 * version. Over iterations, the system evolves under benchmark pressure.
 *
 * Usage:
 *   bun run src/sdk/examples/meta-agent.ts <result-json> [parent-version]
 *
 * Inputs:
 *   <result-json>     — benchmark result file (benchmarks/results/*.json)
 *   [parent-version]  — label of the config that produced it (e.g. AL-1)
 *
 * Outputs (written to /tmp/):
 *   al-N-proposal.json   — structured config for AL-N
 *   al-N-analysis.md     — human-readable failure analysis and rationale
 *   al-N-launch.sh       — shell script that spawns AL-N
 *
 * Env:
 *   META_MODEL           — strong reasoner (default marina:gemini)
 *   META_MODEL_FALLBACK  — alternative if primary fails (default marina:sonnet)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const META_MODEL = process.env.META_MODEL ?? "marina:gemini";
const META_FALLBACK = process.env.META_MODEL_FALLBACK ?? "marina:sonnet";

interface ResultItem {
  id: string;
  question: string;
  expected: string;
  actual: string;
  correct: boolean;
  category?: string;
  latencyMs?: number;
}

interface BenchmarkResult {
  config: {
    name?: string;
    dataset?: string;
    adapter?: string;
    scoring?: string;
    model?: string;
    limit?: number;
    seed?: number;
  };
  scores: { overall: number; breakdown: Record<string, number> };
  metadata: {
    total: number;
    answered: number;
    errors: number;
    timeouts: number;
    avgLatencyMs: number;
  };
  items: ResultItem[];
}

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

async function callWithFallback(
  messages: Array<{ role: string; content: string }>,
  temperature = 0,
): Promise<string> {
  try {
    return await callMarina(META_MODEL, messages, temperature);
  } catch (e) {
    console.warn(`[meta] ${META_MODEL} failed, falling back to ${META_FALLBACK}:`, e);
    return callMarina(META_FALLBACK, messages, temperature);
  }
}

function summarizeFailures(items: ResultItem[]): {
  total: number;
  wrong: number;
  errored: number;
  perCategory: Record<string, { total: number; correct: number }>;
} {
  const wrongItems = items.filter((i) => !i.correct && !i.actual.startsWith("ERROR:"));
  const errorItems = items.filter((i) => i.actual.startsWith("ERROR:"));
  const perCategory: Record<string, { total: number; correct: number }> = {};
  for (const i of items) {
    const c = i.category ?? "uncategorized";
    if (!perCategory[c]) perCategory[c] = { total: 0, correct: 0 };
    perCategory[c].total++;
    if (i.correct) perCategory[c].correct++;
  }
  return {
    total: items.length,
    wrong: wrongItems.length,
    errored: errorItems.length,
    perCategory,
  };
}

async function analyzeAndPropose(
  benchmark: string,
  result: BenchmarkResult,
  parentVersion: string,
): Promise<{ analysis: string; proposalJson: string }> {
  const failures = summarizeFailures(result.items);
  // Sample worst failures (max 15 for token budget)
  const wrongSample = result.items
    .filter((i) => !i.correct && !i.actual.startsWith("ERROR:"))
    .slice(0, 15)
    .map(
      (i, idx) =>
        `[Wrong ${idx + 1}] category=${i.category ?? "?"} id=${i.id}\n  Q: ${i.question.slice(0, 300).replace(/\n/g, " ")}\n  expected: ${i.expected}\n  got: ${i.actual.slice(0, 120).replace(/\n/g, " ")}`,
    )
    .join("\n\n");

  const categoryLines = Object.entries(failures.perCategory)
    .map(
      ([c, { total, correct }]) =>
        `  ${c}: ${correct}/${total} (${((correct / total) * 100).toFixed(0)}%)`,
    )
    .join("\n");

  const prompt = `You are the meta-agent of Marina, a self-improving agentic system. You study the last run's outcomes and propose a BETTER Marina configuration for the next run (AL-${nextVersionOf(parentVersion)}).

PARENT CONFIG: ${parentVersion}
BENCHMARK: ${benchmark}
OVERALL: ${(result.scores.overall * 100).toFixed(1)}% (${failures.total - failures.wrong - failures.errored}/${failures.total})
ERRORS: ${failures.errored}
BREAKDOWN BY CATEGORY:
${categoryLines}

FAILURE SAMPLES:
${wrongSample}

## ORCHESTRATORS YOU MAY PROPOSE (pick one)

- passthrough    — bare substrate, no Marina added. use as diagnostic control.
- smart          — single substrate + translator + recall + pool injection. uses: memory, translator, pools.
- nsed           — N-substrate ensemble with majority vote on extracted letter. homogeneous temperature spread.
- nsed-smart     — heterogeneous ensemble + translator + recall + pool. council substrates drawn from diverse vendors.
- debate         — 2 proposers argue; judge decides when they disagree. params: proposerA, proposerB, judge.
- pipeline       — parse(council-member) → reason(escalator) → verify(council-member). best for multi-step reasoning.
- foundry       — worker writes, Gate reviewer approves/rejects with retry. params: worker, reviewer, maxRounds.
- adaptive       — N council members vote; escalate to a stronger substrate if consensus < threshold. params: council[], strong, threshold.
- blackboard     — N role-personas write analyses into per-question pool; pairwise graph-classifier; graph-weight winner with judge tiebreak. params: roles (substrate@role).
- world          — creates task in project:benchmark-pursuit, waits for in-world workers to claim/submit, approves. params: workers, workerSubstrates, fallbackSubstrate, workerTimeoutMs.
- synthesis      — classify type → gather evidence (web + pool + memory) → council ensemble → escalate on low consensus. params: council[], strong, translator, pools[], useWeb, threshold.

## SUBSTRATES AVAILABLE
Anthropic (direct): marina:sonnet, marina:haiku
OpenRouter (14 vendors): marina:qwen, marina:gemma, marina:kimi, marina:deepseek, marina:llama, marina:nemotron, marina:glm, marina:mistral, marina:gpt, marina:gemini, marina:grok, marina:minimax
Translator channels: translator-haiku, translator-gemini, translator-qwen, translator-nemotron, translator-sonnet

## REASONING CONSTRAINTS
- Don't silently re-use parent config. Every proposal must differ in ≥1 meaningful dimension (orchestrator, substrate mix, threshold, pools, etc.).
- If failures cluster in one category (e.g., law 40%), prefer changes that target that category (domain pool, specialist agent, translator swap).
- If failures are scattered, consider structural shift (e.g., adaptive→synthesis, or add web).
- If overall score is already saturated, propose harder-benchmarks tests or focus on failed buckets.

Answer in TWO sections:

## ANALYSIS (markdown, ~200 words)
- Which orchestrator (parent) was used?
- What types/categories failed most?
- What's the likely root cause (model bias, missing knowledge, wrong tool, extraction artifact, threshold mis-set)?
- Could one of the UNUSED orchestrators be better-fit?

## PROPOSAL (valid JSON only — this block must be parseable)
\`\`\`json
{
  "version": "AL-${nextVersionOf(parentVersion)}",
  "parentVersion": "${parentVersion}",
  "changeSet": ["specific changes vs parent"],
  "rationale": "one-sentence why this should score higher",
  "orchestrator": "one of: passthrough|smart|nsed|nsed-smart|debate|pipeline|foundry|adaptive|blackboard|world|synthesis",
  "orchestratorParams": {
    "council": ["marina:haiku"],
    "strong": "marina:gemini",
    "proposerA": "marina:haiku",
    "proposerB": "marina:qwen",
    "judge": "marina:sonnet",
    "worker": "marina:sonnet",
    "reviewer": "marina:haiku",
    "maxRounds": 2,
    "parse": "marina:haiku",
    "reason": "marina:sonnet",
    "verify": "marina:haiku",
    "roles": ["marina:haiku@scholar", "marina:qwen@skeptic"],
    "workerSubstrates": ["marina:haiku", "marina:qwen"],
    "workerCount": 3,
    "fallbackSubstrate": "marina:sonnet",
    "workerTimeoutMs": 60000,
    "translator": "translator-haiku",
    "reflector": "marina:haiku",
    "threshold": 0.75,
    "useWeb": true,
    "pools": ["seed:math", "seed:law"]
  },
  "routing": {
    "factual": { "useWeb": true, "strong": "marina:gemini" },
    "math":    { "translator": "translator-nemotron", "useWeb": false }
  },
  "addPools": [{ "name": "seed:<new-pool>", "rationale": "why this pool would help" }],
  "addAgents": [{ "name": "Specialist", "role": "scholar", "substrate": "marina:<model>", "goal": "..." }]
}
\`\`\`

Only include orchestratorParams fields RELEVANT to the chosen orchestrator. Be specific. The proposal must be directly executable.`;

  const response = await callWithFallback([
    {
      role: "system",
      content:
        "You are Marina's meta-agent. You propose the next Marina version based on the last run's failures. Your proposals must be concrete, specific, and executable.",
    },
    { role: "user", content: prompt },
  ]);

  // Parse out analysis + JSON
  const analysisMatch = response.match(/##\s*ANALYSIS[\s\S]*?(?=##\s*PROPOSAL|$)/i);
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
  const analysis = analysisMatch?.[0].trim() ?? response.slice(0, 1000);
  const proposalJson = jsonMatch?.[1]?.trim() ?? "{}";
  return { analysis, proposalJson };
}

function nextVersionOf(parent: string): string {
  const m = parent.match(/AL-(\d+)/);
  if (m) return String(Number.parseInt(m[1]!, 10) + 1);
  return "2";
}

function emitLaunchScript(proposal: Record<string, unknown>, benchmark: string): string {
  const p = proposal as {
    version?: string;
    orchestrator?: string;
    orchestratorParams?: {
      council?: string[];
      strong?: string;
      translator?: string;
      reflector?: string;
      threshold?: number;
      useWeb?: boolean;
      pools?: string[];
    };
    addPools?: Array<{ name?: string; rationale?: string }>;
    addAgents?: Array<{ name?: string; role?: string; substrate?: string; goal?: string }>;
    rationale?: string;
  };
  const op = p.orchestratorParams ?? {};
  const lines: string[] = [
    "#!/usr/bin/env bash",
    `# Launch script for ${p.version} — proposed by meta-agent`,
    `# Rationale: ${p.rationale ?? "(none)"}`,
    "set -e",
    'cd "$(dirname "$0")/../../.."',
    "",
    "# 1. (If needed) seed new pools suggested by meta-agent",
  ];
  if (p.addPools && p.addPools.length > 0) {
    lines.push("# New pools proposed:");
    for (const pool of p.addPools) {
      lines.push(`#   ${pool.name} — ${pool.rationale}`);
    }
    lines.push("# (actual seeding would require running an extended seed-pools script)");
  }
  if (p.addAgents && p.addAgents.length > 0) {
    lines.push("", "# 2. Spawn additional in-world agents proposed by meta-agent");
    for (const a of p.addAgents) {
      lines.push(`#   agent spawn ${a.name} model ${a.substrate} role ${a.role} goal "${a.goal}"`);
    }
  }
  lines.push("", "# 3. Kill previous orchestrator, launch proposed one");
  lines.push(
    'pkill -f "sdk/examples/(synthesis|adaptive|debate|pipeline|foundry|blackboard|world-coordinator|nsed)-provider" 2>/dev/null || true',
    "sleep 3",
    "sqlite3 marina.db \"DELETE FROM channel_members WHERE channel_id='ch:model'\"",
    "",
  );
  const orch = p.orchestrator ?? "synthesis";
  const op2 = op as Record<string, unknown>;
  const tchan = (op2.translator as string) ?? "translator";

  if (orch === "synthesis") {
    const council = (
      (op2.council as string[]) ?? ["marina:haiku", "marina:qwen", "marina:gemma"]
    ).join(",");
    const strong = (op2.strong as string) ?? "marina:gemini";
    const pools = ((op2.pools as string[]) ?? []).join(",");
    const useWeb = (op2.useWeb as boolean) ?? true;
    const thr = (op2.threshold as number) ?? 0.75;
    lines.push(
      `SYNTH_COUNCIL="${council}" \\`,
      `  SYNTH_STRONG="${strong}" \\`,
      `  SYNTH_POOLS="${pools}" \\`,
      `  SYNTH_USE_WEB=${useWeb} \\`,
      `  SYNTH_ESCALATE_T=${thr} \\`,
      `  TRANSLATOR_CHANNEL="${tchan}" \\`,
      "  bun run src/sdk/examples/synthesis-provider.ts &",
    );
  } else if (orch === "adaptive") {
    const council = ((op2.council as string[]) ?? []).join(",");
    const strong = (op2.strong as string) ?? "marina:sonnet";
    const thr = (op2.threshold as number) ?? 0.75;
    lines.push(
      `ADAPTIVE_COUNCIL="${council}" \\`,
      `  ADAPTIVE_STRONG="${strong}" \\`,
      `  ADAPTIVE_THRESHOLD=${thr} \\`,
      "  bun run src/sdk/examples/adaptive-provider.ts &",
    );
  } else if (orch === "debate") {
    lines.push(
      `DEBATE_PROPOSER_A="${(op2.proposerA as string) ?? "marina:haiku"}" \\`,
      `  DEBATE_PROPOSER_B="${(op2.proposerB as string) ?? "marina:qwen"}" \\`,
      `  DEBATE_JUDGE="${(op2.judge as string) ?? "marina:sonnet"}" \\`,
      "  bun run src/sdk/examples/debate-provider.ts &",
    );
  } else if (orch === "pipeline") {
    lines.push(
      `PIPELINE_PARSE="${(op2.parse as string) ?? "marina:haiku"}" \\`,
      `  PIPELINE_REASON="${(op2.reason as string) ?? "marina:sonnet"}" \\`,
      `  PIPELINE_VERIFY="${(op2.verify as string) ?? "marina:haiku"}" \\`,
      "  bun run src/sdk/examples/pipeline-provider.ts &",
    );
  } else if (orch === "foundry") {
    lines.push(
      `FOUNDRY_WORKER="${(op2.worker as string) ?? "marina:sonnet"}" \\`,
      `  FOUNDRY_REVIEWER="${(op2.reviewer as string) ?? "marina:haiku"}" \\`,
      `  FOUNDRY_MAX_ROUNDS="${(op2.maxRounds as number) ?? 2}" \\`,
      "  bun run src/sdk/examples/foundry-provider.ts &",
    );
  } else if (orch === "blackboard") {
    const roles = (
      (op2.roles as string[]) ?? [
        "marina:haiku@scholar",
        "marina:qwen@skeptic",
        "marina:gemma@calculator",
        "marina:kimi@domain",
      ]
    ).join(",");
    lines.push(
      `BLACKBOARD_ROLES="${roles}" \\`,
      `  BLACKBOARD_JUDGE="${(op2.judge as string) ?? "marina:sonnet"}" \\`,
      "  bun run src/sdk/examples/blackboard-provider.ts &",
    );
  } else if (orch === "nsed" || orch === "nsed-smart") {
    const subs = (
      (op2.council as string[]) ?? ["marina:haiku", "marina:qwen", "marina:gemma", "marina:kimi"]
    ).join(",");
    const file = orch === "nsed-smart" ? "nsed-smart-provider.ts" : "nsed-provider.ts";
    const reflector = (op2.reflector as string) ?? "marina:haiku";
    lines.push(
      `NSED_SUBSTRATES="${subs}" \\`,
      orch === "nsed-smart"
        ? `  USE_TRANSLATOR=true \\\n  TRANSLATOR_CHANNEL="${tchan}" \\\n  MEMORY_LEARN=true \\\n  REFLECTION_PROVIDER_MODEL="${reflector}" \\`
        : "",
      `  bun run src/sdk/examples/${file} &`,
    );
  } else if (orch === "smart") {
    const reflector = (op2.reflector as string) ?? "marina:haiku";
    const strong = (op2.strong as string) ?? "marina:sonnet";
    const pools = ((op2.pools as string[]) ?? []).join(",");
    lines.push(
      "PROVIDER_URL=http://localhost:3300/v1 \\",
      `  PROVIDER_MODEL="${strong}" \\`,
      "  PROVIDER_FORMAT=openai \\",
      "  USE_TRANSLATOR=true \\",
      `  TRANSLATOR_CHANNEL="${tchan}" \\`,
      "  MEMORY_LEARN=true \\",
      `  REFLECTION_PROVIDER_MODEL="${reflector}" \\`,
      `  MEMORY_POOLS="${pools}" \\`,
      "  bun run src/sdk/examples/smart-provider.ts &",
    );
  } else if (orch === "world") {
    const workers = (
      (op2.workerSubstrates as string[]) ?? ["marina:haiku", "marina:qwen", "marina:gemma"]
    ).join(",");
    lines.push(
      `WORLD_WORKERS="${(op2.workerCount as number) ?? 3}" \\`,
      `  WORLD_WORKER_SUBSTRATES="${workers}" \\`,
      `  FALLBACK_SUBSTRATE="${(op2.fallbackSubstrate as string) ?? "marina:sonnet"}" \\`,
      `  WORKER_TIMEOUT_MS="${(op2.workerTimeoutMs as number) ?? 60000}" \\`,
      "  bun run src/sdk/examples/world-coordinator-provider.ts &",
    );
    // Spawn task workers too
    lines.push("# Also spawn the matching task-workers:");
    const arr = (op2.workerSubstrates as string[]) ?? [
      "marina:haiku",
      "marina:qwen",
      "marina:gemma",
    ];
    for (let i = 0; i < arr.length; i++) {
      lines.push(
        `WORKER_NAME="Worker${i + 1}" WORKER_SUBSTRATE="${arr[i]}" \\`,
        `  nohup bun run src/sdk/examples/task-worker.ts > /tmp/worker${i + 1}.log 2>&1 &`,
      );
    }
  } else if (orch === "passthrough") {
    lines.push(
      "# passthrough — no orchestrator, harness will use --model flag directly",
      "# set MODEL below to test the chosen substrate:",
      `export PASSTHROUGH_MODEL="${(op2.strong as string) ?? "marina:gemini"}"`,
    );
  } else {
    lines.push(`# unknown orchestrator "${orch}" — launching default synthesis`);
    lines.push("bun run src/sdk/examples/synthesis-provider.ts &");
  }
  lines.push("sleep 5", "", "# 4. Run benchmark");
  if (orch === "passthrough") {
    lines.push(
      `bun run benchmarks/harness.ts --benchmark ${benchmark} --limit 100 --seed 42 --mode passthrough --concurrency 1 --judge-model marina:sonnet --model "$PASSTHROUGH_MODEL"`,
    );
  } else {
    lines.push(
      `bun run benchmarks/harness.ts --benchmark ${benchmark} --limit 100 --seed 42 --mode passthrough --concurrency 1 --judge-model marina:sonnet`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const resultPath = process.argv[2];
  const parentVersion = process.argv[3] ?? "AL-1";
  if (!resultPath) {
    console.error("Usage: bun run meta-agent.ts <result-json> [parent-version]");
    process.exit(1);
  }
  const result = JSON.parse(readFileSync(resultPath, "utf-8")) as BenchmarkResult;
  const benchmark = result.config?.dataset ?? result.config?.name ?? "unknown";
  console.log(`[meta] analyzing ${basename(resultPath)} — ${benchmark} — parent=${parentVersion}`);

  const { analysis, proposalJson } = await analyzeAndPropose(benchmark, result, parentVersion);
  const nextV = `AL-${nextVersionOf(parentVersion)}`;

  let proposal: Record<string, unknown> = {};
  try {
    proposal = JSON.parse(proposalJson);
  } catch {
    console.warn("[meta] proposal JSON did not parse cleanly; dumping raw");
  }

  const proposalPath = `/tmp/${nextV.toLowerCase()}-proposal.json`;
  const analysisPath = `/tmp/${nextV.toLowerCase()}-analysis.md`;
  const launchPath = `/tmp/${nextV.toLowerCase()}-launch.sh`;

  writeFileSync(proposalPath, JSON.stringify(proposal, null, 2));
  writeFileSync(
    analysisPath,
    `# ${nextV} — proposed from ${parentVersion} (benchmark: ${benchmark})\n\n${analysis}\n\n## Raw proposal\n\`\`\`json\n${proposalJson}\n\`\`\`\n`,
  );
  writeFileSync(launchPath, emitLaunchScript(proposal, benchmark));

  console.log(`\n=== ${nextV} PROPOSED ===`);
  console.log(`analysis:  ${analysisPath}`);
  console.log(`proposal:  ${proposalPath}`);
  console.log(`launch:    ${launchPath}`);
  console.log("\n--- Analysis ---");
  console.log(analysis.slice(0, 1200));
  console.log("\n--- Proposed changes ---");
  const changes = (proposal as { changeSet?: string[] }).changeSet;
  if (changes && Array.isArray(changes)) {
    for (const c of changes) console.log(`  • ${c}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[meta] fatal:", e);
  process.exit(1);
});
