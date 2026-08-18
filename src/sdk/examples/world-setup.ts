// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * World Setup — establish the vibrant Marina.
 *
 * One-shot script that composes every primitive into a living benchmark-
 * pursuit organism:
 *
 *   1. Seed domain pools with LLM-generated principles (math, law, finance,
 *      logic, science, medicine, grammar, business, history, psychology)
 *   2. Create benchmark-pursuit project with orchestration=plan-execute-verify
 *      and decomposition=plan-execute-verify
 *   3. Seed the project pool with orientation notes for workers
 *   4. Spawn N in-world agents via `agent spawn` with role + goal + substrate
 *      — scholar, skeptic, calculator, domain-specialist, researcher, verifier
 *   5. Create the benchmark-arena room if absent
 *
 * After this runs, the world has: domain knowledge, a project with tasks
 * ready to receive bounties, and autonomous agents cognizing in the world
 * with tick-based continuation prompts, memory, reflection, and tools.
 *
 * Env:
 *   SKIP_POOLS     — "true" to skip pool seeding (if already done)
 *   SKIP_AGENTS    — "true" to skip spawning in-world agents
 *   AGENT_COUNT    — how many agents to spawn (default 5)
 *   AGENT_MODELS   — comma-separated substrates, one per agent round-robin
 *                    (default: marina:haiku,marina:qwen,marina:deepseek,marina:gemini,marina:sonnet)
 *   PROJECT_NAME   — default benchmark-pursuit
 */

import { MarinaAgent } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME ?? "WorldSetup";
const PROJECT_NAME = process.env.PROJECT_NAME ?? "benchmark-pursuit";
const SKIP_POOLS = process.env.SKIP_POOLS === "true";
const SKIP_AGENTS = process.env.SKIP_AGENTS === "true";
const AGENT_COUNT = Math.max(1, Number.parseInt(process.env.AGENT_COUNT ?? "5", 10));
const AGENT_MODELS = (
  process.env.AGENT_MODELS ?? "marina:haiku,marina:qwen,marina:deepseek,marina:gemini,marina:sonnet"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const AGENT_ROLES: Array<{ name: string; role: string; goal: string }> = [
  {
    name: "Scholar",
    role: "scholar",
    goal: "Claim bounty tasks in project benchmark-pursuit. Consult pool:seed:<domain> pools before answering. Submit concise, well-reasoned answers.",
  },
  {
    name: "Skeptic",
    role: "scholar",
    goal: "Claim bounty tasks. Be skeptical of obvious answers. Check for plausible-looking traps. Submit with your reasoning.",
  },
  {
    name: "Calculator",
    role: "scholar",
    goal: "Claim bounty tasks. When quantitative, show work with formulas. Consult pool:seed:math. Submit.",
  },
  {
    name: "Researcher",
    role: "researcher",
    goal: "Claim bounty tasks. Use `web search` and `web fetch` for factual questions. Cite sources. Submit.",
  },
  {
    name: "Verifier",
    role: "scholar",
    goal: "Review submitted tasks. If submission looks correct, use `task approve <id> <claimant>`. Else reject with reason.",
  },
  {
    name: "DomainExpert",
    role: "scholar",
    goal: "Claim bounty tasks matching a domain you recognize. Consult the matching seed pool. Submit with the domain principle applied.",
  },
];

const ORIENT_NOTES = [
  "This project runs continuous benchmark-pursuit. Every open task is a question; claim one via `task claim <id>`.",
  "Before answering, consult: `recall <keywords>`, `pool seed:<domain> recall <keywords>`. For factual: `web search <keywords>`.",
  "Submit your final answer via `task submit <id> <answer>`. Keep it concise — the scoring extractor looks for a clean letter (A-J) for MC or a boxed number for math.",
  "Multiple agents may be claiming in parallel. First-to-claim wins the bounty. Don't hoard — finish and move on.",
  "After answering, `note <principle>` to store a learning. Link your note to pool notes you used via `note link <yourId> <poolNoteId> supports` to grow the knowledge graph.",
];

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

async function seedPoolsInline(agent: MarinaAgent): Promise<number> {
  const DOMAINS: Record<string, string> = {
    math: "mathematics — arithmetic, algebra, calculus, probability, statistics, number theory, linear algebra, optimization",
    law: "law — contract, tort, property, criminal, constitutional, procedural, evidence, legal doctrines",
    finance:
      "finance and accounting — valuation, interest (simple+compound), annuities, depreciation, bonds, options, ratios",
    logic:
      "formal logic — syllogisms, fallacies, boolean logic, set theory, conditional reasoning, probability",
    science: "natural science — physics, chemistry, biology, earth science major principles",
    medicine: "medicine — anatomy, physiology, pharmacology, diagnostic reasoning, drug classes",
    grammar: "English grammar — parts of speech, agreement, active/passive, format constraints",
    business:
      "business — organizational structure, supply and demand, strategy, operations, HR, marketing",
    history:
      "history — major eras, events, historiographic reasoning, primary vs secondary sources",
    psychology:
      "psychology — cognitive, developmental, social, classical/operant conditioning, heuristics and biases",
  };
  let total = 0;
  for (const [dom, desc] of Object.entries(DOMAINS)) {
    const poolName = `seed:${dom}`;
    try {
      await agent.command(`pool create ${poolName}`);
    } catch {
      /* exists */
    }
    console.log(`[setup] seeding ${poolName}...`);
    const prompt = `Enumerate 50 high-signal, reusable principles/formulas/heuristics for: ${desc}. Output ONE per line, no preamble, no numbering. Each principle 1-2 sentences, concrete and general.`;
    try {
      const raw = await callMarina("marina:sonnet", [
        {
          role: "system",
          content: "You enumerate reusable domain principles with precision. Terse.",
        },
        { role: "user", content: prompt },
      ]);
      const lines = raw
        .split("\n")
        .map((l) =>
          l
            .trim()
            .replace(/^[-*•\d]+[.)]\s*/, "")
            .trim(),
        )
        .filter((l) => l.length > 20 && l.length < 400);
      for (const l of lines.slice(0, 50)) {
        try {
          await agent.command(`pool ${poolName} add ${l.replace(/\n/g, " ")} importance 8`);
          total++;
        } catch {
          /* skip */
        }
      }
      console.log(`[setup]   ${poolName}: ${lines.slice(0, 50).length} principles`);
    } catch (e) {
      console.error(`[setup]   ${poolName} failed:`, e);
    }
  }
  return total;
}

async function ensureProject(agent: MarinaAgent): Promise<void> {
  try {
    await agent.command(`project create ${PROJECT_NAME}`);
    console.log(`[setup] created project ${PROJECT_NAME}`);
  } catch {
    /* exists */
  }
  try {
    await agent.command(`project orchestrate ${PROJECT_NAME} plan-execute-verify`);
    console.log(`[setup] orchestrate ${PROJECT_NAME} = plan-execute-verify`);
  } catch {
    /* already set */
  }
  // Project pool — for orientation notes visible to agents on join
  const poolName = `project:${PROJECT_NAME}`;
  for (const note of ORIENT_NOTES) {
    try {
      await agent.command(`pool ${poolName} add ${note} importance 9`);
    } catch {
      /* maybe duplicate */
    }
  }
  console.log(`[setup] seeded ${ORIENT_NOTES.length} orientation notes in ${poolName}`);
}

async function spawnInWorldAgents(agent: MarinaAgent): Promise<number> {
  let spawned = 0;
  for (let i = 0; i < AGENT_COUNT; i++) {
    const def = AGENT_ROLES[i % AGENT_ROLES.length]!;
    const sub = AGENT_MODELS[i % AGENT_MODELS.length]!;
    const name = `${def.name}${i < AGENT_ROLES.length ? "" : i}`;
    const cmd = `agent spawn ${name} model ${sub} role ${def.role} goal ${def.goal}`;
    try {
      await agent.command(cmd);
      console.log(`[setup] spawned ${name} (role=${def.role}, model=${sub})`);
      spawned++;
    } catch (e) {
      console.error(`[setup] spawn failed for ${name}:`, e);
    }
  }
  return spawned;
}

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: false, commandDrainTimeout: 2000 });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[setup] connected as ${session.name} (${session.entityId})`);

  if (!SKIP_POOLS) {
    console.log("\n=== SEEDING DOMAIN POOLS ===");
    const n = await seedPoolsInline(agent);
    console.log(`[setup] total principles: ${n}`);
  } else {
    console.log("[setup] skipping pool seeding (SKIP_POOLS=true)");
  }

  console.log("\n=== ESTABLISHING PROJECT ===");
  await ensureProject(agent);

  if (!SKIP_AGENTS) {
    console.log("\n=== SPAWNING IN-WORLD AGENTS ===");
    const n = await spawnInWorldAgents(agent);
    console.log(`[setup] spawned ${n} agents`);
  } else {
    console.log("[setup] skipping agent spawn (SKIP_AGENTS=true)");
  }

  console.log("\n=== WORLD READY ===");
  console.log(
    "Launch the coordinator next:  bun run src/sdk/examples/world-coordinator-provider.ts",
  );
  console.log("Or the synthesis provider:    bun run src/sdk/examples/synthesis-provider.ts");

  agent.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("[setup] fatal:", e);
  process.exit(1);
});
