// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BenchmarkItemRow } from "../persistence/db-benchmarks";
import { parseParticipants } from "./benchmark-ledger";
import type { ResolvedParticipant } from "./benchmark-participants";

/** Observations, never inferred from a declared roster, price, or successful score. */
export interface BenchmarkExecution {
  items: number;
  tracedItems: number;
  windowOnlyItems: number;
  unverifiedItems: number;
  unknownItems: number;
  multipleResidentItems: number;
  sharedTraceItems: number;
  agents: { name: string; items: number }[];
  models: { name: string; items: number }[];
}

/** A participant record is evidence of involvement, not proof of marginal benefit. */
export function benchmarkExecution(
  items: readonly Pick<BenchmarkItemRow, "participants_json">[],
): BenchmarkExecution {
  const result: BenchmarkExecution = {
    items: items.length,
    tracedItems: 0,
    windowOnlyItems: 0,
    unverifiedItems: 0,
    unknownItems: 0,
    multipleResidentItems: 0,
    sharedTraceItems: 0,
    agents: [],
    models: [],
  };
  const agents = new Map<string, number>();
  const models = new Map<string, number>();
  for (const item of items) {
    const participants = parseParticipants(
      item.participants_json,
    ) as Partial<ResolvedParticipant>[];
    const traced = participants.filter(
      (p) => p.via === "trace" && Number.isSafeInteger(p.turns) && (p.turns ?? 0) > 0,
    );
    if (traced.length > 0) result.tracedItems++;
    else if (
      participants.some(
        (p) => p.via === "window" && Number.isSafeInteger(p.turns) && (p.turns ?? 0) > 0,
      )
    )
      result.windowOnlyItems++;
    else if (participants.length > 0) result.unverifiedItems++;
    else result.unknownItems++;
    const names = new Set(traced.flatMap((p) => (p.agent ? [p.agent] : [])));
    if (names.size > 1) result.multipleResidentItems++;
    if (traced.some((p) => p.tracedShared === true)) result.sharedTraceItems++;
    for (const name of names) agents.set(name, (agents.get(name) ?? 0) + 1);
    for (const name of new Set(traced.flatMap((p) => (p.model ? [p.model] : [])))) {
      models.set(name, (models.get(name) ?? 0) + 1);
    }
  }
  const sorted = (counts: Map<string, number>) =>
    [...counts]
      .map(([name, n]) => ({ name, items: n }))
      .sort((a, b) => b.items - a.items || a.name.localeCompare(b.name));
  result.agents = sorted(agents);
  result.models = sorted(models);
  return result;
}

export function formatBenchmarkExecution(result: BenchmarkExecution): string[] {
  return [
    `Execution evidence: ${result.tracedItems}/${result.items} items trace-linked; ${result.windowOnlyItems} window-only; ${result.unverifiedItems} unverified; ${result.unknownItems} unknown.`,
    `Multiple residents traced on ${result.multipleResidentItems} items; ${result.sharedTraceItems} items include turns shared across requests.`,
    `Observed residents: ${result.agents.map((a) => `${a.name} (${a.items})`).join(", ") || "unproven"}.`,
    `Observed models: ${result.models.map((a) => `${a.name} (${a.items})`).join(", ") || "unproven"}.`,
    "Counts are unique items, not calls. Missing evidence is not zero activity; participation is not proof of benefit or an acknowledged handoff.",
  ];
}
