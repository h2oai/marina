// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ProductivitySummary } from "../persistence/db-telemetry";
import type { BenchmarkExecution } from "./benchmark-execution";

export interface NoveltyCapability {
  name: string;
  help?: string;
  category?: string;
  minRank?: number;
}
export interface NoveltyActivity {
  key: string;
  count: number;
  successCount: number;
  failCount: number;
  lastSeen: number;
}
export interface NoveltyOpportunity {
  id: string;
  kind: "recover" | "verify" | "explore" | "continue" | "experiment";
  /** Ordinal heuristic priority, never a probability, reward, or intelligence score. */
  priority: number;
  suggestion: string;
  evidence: string;
  next: string;
}

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "have",
  "into",
  "using",
  "your",
]);
function words(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)),
  );
}
function relevance(goal: Set<string>, text: string): number {
  const terms = words(text);
  return Math.min(3, [...goal].filter((w) => terms.has(w)).length);
}
function rotation(seed: string, value: string): number {
  let hash = 2166136261;
  for (const c of `${seed}:${value}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return hash >>> 0;
}
export function rankNoveltyOpportunities(
  items: readonly NoveltyOpportunity[],
  limit = 4,
): NoveltyOpportunity[] {
  return [...new Map(items.map((it) => [it.id, it])).values()]
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Math.min(limit, 8)));
}

/** No writes, model calls, spawning, goals, or standing changes. The participant chooses. */
export function noveltyOpportunities(input: {
  now: number;
  participant: string;
  rank: number;
  goal?: string;
  capabilities: readonly NoveltyCapability[];
  activity: readonly NoveltyActivity[];
  outcomes: Pick<ProductivitySummary, "outcomes" | "successes" | "failures" | "successRate">;
  unexploredRooms: number;
}): NoveltyOpportunity[] {
  const goal = words(input.goal?.slice(0, 2000) ?? "");
  const capabilities = input.capabilities.filter((c) => (c.minRank ?? 0) <= input.rank);
  const eligible = new Map(capabilities.map((c) => [c.name, c]));
  const used = new Set(input.activity.map((a) => a.key));
  const recent = input.activity.filter(
    (a) => a.lastSeen <= input.now && input.now - a.lastSeen < 7 * 86_400_000,
  );
  const items: NoveltyOpportunity[] = [];
  const failures = recent.filter(
    (a) =>
      a.successCount + a.failCount >= 3 &&
      a.failCount / (a.successCount + a.failCount) > 0.4 &&
      eligible.has(a.key),
  );
  for (const a of failures) {
    const c = eligible.get(a.key)!;
    items.push({
      id: `recover:${a.key}`,
      kind: "recover",
      priority: 80 + relevance(goal, `${c.name} ${c.help ?? ""}`) * 5,
      suggestion: `Inspect the failed assumption behind ${a.key}; change one input or approach before retrying.`,
      evidence: `${a.failCount}/${a.successCount + a.failCount} recorded attempts failed; activity seen within 7 days (counts are lifetime).`,
      next: `help ${a.key}`,
    });
  }
  const o = input.outcomes;
  if (o.failures >= 3 && o.successRate < 0.6)
    items.push({
      id: "outcome:recover",
      kind: "recover",
      priority: 85,
      suggestion:
        "Review terminal task failures; try one bounded alternative, requesting a specific peer's evidence only if useful.",
      evidence: `${o.failures}/${o.outcomes} task outcomes failed; interaction volume does not identify a helpful peer.`,
      next: "help productivity",
    });
  if (o.outcomes === 0 && recent.reduce((n, a) => n + a.count, 0) >= 10)
    items.push({
      id: "outcome:verify",
      kind: "verify",
      priority: 75,
      suggestion: "Establish a task acceptance check before calling activity progress.",
      evidence:
        "Activity exists, but no terminal task outcome is recorded; this is missing evidence, not proven failure.",
      next: "help task",
    });
  if (goal.size && o.successes >= 3 && o.successRate >= 0.8 && failures.length === 0)
    items.push({
      id: "outcome:continue",
      kind: "continue",
      priority: 90,
      suggestion: "Continue effective work; explore only a relevant unresolved uncertainty.",
      evidence: `${o.successes}/${o.outcomes} terminal tasks succeeded; this is an aggregate, not proof about the current task.`,
      next: "help productivity",
    });
  if (goal.size && (failures.length || o.outcomes === 0))
    items.push({
      id: "knowledge:context",
      kind: "verify",
      priority: 70,
      suggestion:
        "Check your authorized context for a missing assumption, source, or conflicting fact before another attempt.",
      evidence: "A current goal is available; whether its evidence is sufficient is untested.",
      next: "context",
    });
  const seed = `${input.participant}:${Math.floor(input.now / 86_400_000)}`;
  const unexplored = capabilities
    .filter((c) => !used.has(c.name))
    .sort(
      (a, b) =>
        relevance(goal, `${b.name} ${b.category} ${b.help}`) -
          relevance(goal, `${a.name} ${a.category} ${a.help}`) ||
        rotation(seed, a.name) - rotation(seed, b.name) ||
        a.name.localeCompare(b.name),
    );
  for (const [index, c] of unexplored.slice(0, 3).entries()) {
    const relevant = relevance(goal, `${c.name} ${c.category} ${c.help}`);
    items.push({
      id: `capability:${c.name}`,
      kind: "explore",
      priority: 35 + relevant * 8 - index,
      suggestion: `Inspect ${c.name}; try it only if it advances your goal or an intentional experiment.`,
      evidence: `No recorded use; ${relevant ? "lexical match to current goal" : "rotating discovery candidate, relevance unproven"}. Permission gates still apply.`,
      next: `help ${c.name}`,
    });
  }
  if (!goal.size && input.unexploredRooms > 0)
    items.push({
      id: "world:explore",
      kind: "explore",
      priority: 30,
      suggestion:
        "Explore a nearby room or conversation if it offers a useful question to investigate.",
      evidence: `${input.unexploredRooms} rooms have no recorded visit; novelty alone is not an outcome.`,
      next: "look",
    });
  return rankNoveltyOpportunities(items);
}

/** Explicit experiment view; expensive benchmark inspection stays out of the resident hot loop. */
export function benchmarkNoveltyOpportunities(
  runs: readonly {
    id: string;
    benchmark: string;
    score: number | null;
    slice: string | null;
    judge: string | null;
    execution: BenchmarkExecution;
  }[],
): NoveltyOpportunity[] {
  const items: NoveltyOpportunity[] = [];
  for (const run of runs) {
    const e = run.execution;
    if (e.unknownItems || e.unverifiedItems || e.windowOnlyItems)
      items.push({
        id: `evidence:${run.id}`,
        kind: "verify",
        priority: 90,
        suggestion:
          "Resolve missing execution evidence before attributing this result to a team or model.",
        evidence: `${run.id}: ${e.tracedItems}/${e.items} items traced, ${e.unknownItems} unknown, ${e.windowOnlyItems} window-only, ${e.unverifiedItems} unverified.`,
        next: `benchmark result ${run.id}`,
      });
    if (!e.tracedItems || e.unknownItems || e.unverifiedItems || e.windowOnlyItems || !run.slice)
      continue;
    const peers = runs.filter(
      (p) =>
        p.id !== run.id &&
        p.benchmark === run.benchmark &&
        p.slice === run.slice &&
        p.judge === run.judge &&
        p.execution.tracedItems === p.execution.items &&
        p.execution.items > 0,
    );
    const simpler =
      e.multipleResidentItems > 0
        ? peers.find((p) => p.execution.multipleResidentItems === 0)
        : undefined;
    items.push({
      id: `experiment:${run.id}`,
      kind: "experiment",
      priority: simpler ? 75 : 60,
      suggestion: simpler
        ? "Compare the observed team with the simpler observed execution, then replicate on held-out work before changing defaults."
        : "Design a bounded paired experiment: current method versus one changed source, tool, or optional collaborator; keep the same acceptance check.",
      evidence: `${run.id}: ${e.tracedItems} trace-linked items; ${simpler ? `${simpler.id} is a same-slice/judge comparison candidate, not a causal control` : "no simpler same-slice/judge comparison established"}.`,
      next: simpler ? `benchmark compare ${run.id} ${simpler.id}` : `benchmark result ${run.id}`,
    });
  }
  return rankNoveltyOpportunities(items, 8);
}
