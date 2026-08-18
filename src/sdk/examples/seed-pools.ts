// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Seed Pools — populate domain-specific shared pools with curated principles.
 *
 * For each domain (math, law, finance, logic, science, medicine, grammar),
 * ask Sonnet to enumerate N high-signal principles and deposit each as a
 * pool note with importance 8. Agents reading these pools during benchmark
 * runs get grounded domain knowledge from turn 1 — the "vibrant world."
 *
 * One-shot run: invoke, it seeds, exits. Safe to re-run — checks for pool
 * existence before seeding, adds only new principles.
 *
 * Usage:
 *   SEED_MODEL=marina:sonnet SEED_PER_DOMAIN=100 bun run src/sdk/examples/seed-pools.ts
 *
 * Env:
 *   SEED_MODEL        — model for generating principles (default marina:sonnet)
 *   SEED_PER_DOMAIN   — target principles per domain (default 50)
 *   SEED_DOMAINS      — comma-separated domains to seed (default: full list)
 *   SEED_POOL_PREFIX  — pool name prefix (default "seed:")
 */

import { MarinaAgent } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME ?? "PoolSeeder";
const SEED_MODEL = process.env.SEED_MODEL ?? "marina:sonnet";
const SEED_PER_DOMAIN = Math.max(10, Number.parseInt(process.env.SEED_PER_DOMAIN ?? "50", 10));
const POOL_PREFIX = process.env.SEED_POOL_PREFIX ?? "seed:";

const DEFAULT_DOMAINS: Record<string, string> = {
  math: "mathematics — arithmetic, algebra, calculus, probability, statistics, number theory, linear algebra, optimization",
  law: "law — contract, tort, property, criminal, constitutional, procedural, evidence, legal doctrines and landmark principles",
  finance:
    "finance and accounting — valuation, compound/simple interest, annuities, depreciation (straight-line + accelerated), bonds, options pricing, financial statements, ratios",
  logic:
    "formal logic and critical reasoning — deductive vs inductive, syllogisms, fallacies, boolean logic, set theory, conditional reasoning, probability and inference",
  science:
    "natural science — physics (mechanics, thermodynamics, E&M, quantum), chemistry (stoichiometry, equilibria, organic), biology (cell biology, genetics, evolution, ecology), earth science",
  medicine:
    "medicine and health — anatomy, physiology, pharmacology, pathophysiology, diagnostic reasoning, common drug classes and interactions, epidemiology",
  grammar:
    "English grammar, syntax, style — parts of speech, agreement, modifier placement, active/passive voice, common errors, instruction-following constraints (word count, format, etc.)",
  business:
    "business and management — organizational structure, supply and demand, market structures, strategy, operations, HR and team dynamics, marketing fundamentals",
  history:
    "history and humanities — major eras and events, historiographic reasoning, primary vs secondary sources, common misconceptions",
  psychology:
    "psychology — cognitive, developmental, social, classical and operant conditioning, major experiments and their findings, common heuristics and biases",
};

const DOMAINS: Record<string, string> = (() => {
  const env = process.env.SEED_DOMAINS;
  if (!env) return DEFAULT_DOMAINS;
  const names = env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const subset: Record<string, string> = {};
  for (const name of names) {
    if (DEFAULT_DOMAINS[name]) subset[name] = DEFAULT_DOMAINS[name]!;
  }
  return Object.keys(subset).length > 0 ? subset : DEFAULT_DOMAINS;
})();

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
  if (!resp.ok) throw new Error(`Marina ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

async function generatePrinciples(
  _domain: string,
  description: string,
  n: number,
): Promise<string[]> {
  const prompt = `Enumerate ${n} high-signal, reusable principles/formulas/heuristics for the domain: ${description}.

Output ONE principle per line. Each principle must be:
- Self-contained and general (applies to many questions, not just one)
- Concrete and useful (formula, doctrine, rule, or heuristic — not vague)
- 1-2 sentences max
- No preamble, no numbering, no bullets — just the principle text per line

Begin now:`;
  const systemMsg =
    "You enumerate reusable domain principles with precision and density. No chatter, no preamble.";
  const raw = await callMarina(SEED_MODEL, [
    { role: "system", content: systemMsg },
    { role: "user", content: prompt },
  ]);
  // Parse lines — trim, dedupe, keep non-empty, non-preamble
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    // Strip leading bullet/number characters
    .map((l) =>
      l
        .replace(/^[-*•\d]+[.)]\s*/, "")
        .replace(/^\d+\s+/, "")
        .trim(),
    )
    .filter((l) => l.length > 20 && l.length < 500)
    // Skip preamble-like lines
    .filter(
      (l) => !/^(here|these|below|following|list|principles?|the following)/i.test(l.slice(0, 20)),
    );
  // Dedupe
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const l of lines) {
    const key = l.slice(0, 80).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(l);
    }
  }
  return unique.slice(0, n);
}

async function seedDomain(
  agent: MarinaAgent,
  domain: string,
  description: string,
  count: number,
): Promise<number> {
  const poolName = `${POOL_PREFIX}${domain}`;
  try {
    await agent.command(`pool create ${poolName}`);
  } catch {
    /* likely already exists */
  }
  console.log(`\n[seed] ${domain} → ${poolName} (target ${count} principles)`);
  const principles = await generatePrinciples(domain, description, count);
  console.log(`[seed] generated ${principles.length} principles for ${domain}`);
  let added = 0;
  for (const p of principles) {
    const safe = p.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    if (!safe) continue;
    try {
      await agent.command(`pool ${poolName} add ${safe} importance 8`);
      added++;
    } catch (e) {
      console.error(`[seed] failed to add principle: ${e}`);
    }
  }
  console.log(`[seed] ${domain}: ${added} principles added to ${poolName}`);
  return added;
}

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true, commandDrainTimeout: 2000 });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[seed-pools] logged in as ${session.name} (${session.entityId})`);
  console.log(`[seed-pools] model=${SEED_MODEL} per-domain=${SEED_PER_DOMAIN}`);
  console.log(`[seed-pools] domains: ${Object.keys(DOMAINS).join(", ")}`);

  let total = 0;
  for (const [domain, desc] of Object.entries(DOMAINS)) {
    try {
      total += await seedDomain(agent, domain, desc, SEED_PER_DOMAIN);
    } catch (e) {
      console.error(`[seed] ${domain} failed:`, e);
    }
  }
  console.log(`\n[seed-pools] TOTAL principles added: ${total}`);

  agent.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("[seed-pools] fatal:", e);
  process.exit(1);
});
