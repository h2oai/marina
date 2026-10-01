// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Private-cost task auction.
 *
 * N subtasks (4–6); each member privately knows only its own integer cost per
 * subtask. Each subtask goes to exactly one member, a member takes at most
 * ceil(N / members). The optimum is found by exact search (≤ 6^6 states) and
 * is unique by construction (cost matrices with a tied optimum are redrawn).
 * Score = optimal cost / achieved cost for a valid assignment, else 0.
 */

import {
  DEFAULT_POOL,
  deliverableRe,
  depositClause,
  type GenerateOptions,
  makeRng,
  type NativeGenerator,
  type NativeInstance,
  type NativeScore,
  parseFields,
  privateMap,
  resolveMembers,
  type SetupStep,
} from "./shared";

export interface AuctionOracle {
  tag: string;
  members: string[];
  subtasks: string[];
  /** cost[member][subtask]. */
  cost: number[][];
  capacity: number;
  /** Optimal member index per subtask. */
  optimal: number[];
  optimalCost: number;
  secondBestCost: number;
}

/** Exact minimum-cost capacitated assignment by exhaustive search. */
export function solveAssignment(
  cost: number[][],
  capacity: number,
): { best: number[]; bestCost: number; secondCost: number } {
  const m = cost.length;
  const n = cost[0]?.length ?? 0;
  const load = new Array(m).fill(0);
  const cur: number[] = [];
  let best: number[] = [];
  let bestCost = Number.POSITIVE_INFINITY;
  let secondCost = Number.POSITIVE_INFINITY;
  const rec = (t: number, acc: number) => {
    if (t === n) {
      if (acc < bestCost) {
        secondCost = bestCost;
        bestCost = acc;
        best = cur.slice();
      } else if (acc < secondCost) secondCost = acc;
      return;
    }
    for (let i = 0; i < m; i++) {
      if (load[i] >= capacity) continue;
      load[i]++;
      cur[t] = i;
      rec(t + 1, acc + cost[i]![t]!);
      load[i]--;
    }
  };
  rec(0, 0);
  return { best, bestCost, secondCost };
}

export function generateAuction(
  seed: number,
  opts?: GenerateOptions,
): NativeInstance<AuctionOracle> {
  const members = resolveMembers(opts);
  const pool = opts?.pool ?? DEFAULT_POOL;
  const tag = `AUC${seed}`;
  for (let attempt = 0; ; attempt++) {
    const rng = makeRng(seed, `auction:${attempt}`);
    const n = rng.int(4, 6);
    const subtasks = Array.from({ length: n }, (_, i) => `S${i + 1}`);
    const capacity = Math.ceil(n / members.length);
    const cost = members.map(() => subtasks.map(() => rng.int(1, 30)));
    const { best, bestCost, secondCost } = solveAssignment(cost, capacity);
    if (!(secondCost > bestCost)) continue;
    const setup: SetupStep[] = members.map((mem, i) => ({
      kind: "private",
      member: mem,
      text: `PRIVATE ${tag} your costs (yours only): ${subtasks.map((s, t) => `${s}=${cost[i]![t]}`).join(", ")}.`,
    }));
    const format = `${tag} ASSIGN: ${subtasks.map((s) => `${s}=<member>`).join("; ")}.`;
    const text =
      `TASK ${tag} (private-cost auction): Assign subtasks ${subtasks[0]}–${subtasks[n - 1]} to crew members ${members.join(", ")}. ` +
      `Each member knows only its own cost per subtask (private Operator tell headed PRIVATE ${tag}). ` +
      `Each subtask goes to exactly one member; a member takes at most ${capacity}. Minimise total cost. ${depositClause(pool, format)}`;
    return {
      task: "auction",
      seed,
      tag,
      shape: "auction",
      text,
      privateMaterial: privateMap(setup),
      setup,
      pool,
      deliverableRe: deliverableRe(tag, "ASSIGN"),
      answer: `${tag} ASSIGN: ${subtasks.map((s, t) => `${s}=${members[best[t]!]}`).join("; ")}`,
      oracle: {
        tag,
        members,
        subtasks,
        cost,
        capacity,
        optimal: best,
        optimalCost: bestCost,
        secondBestCost: secondCost,
      },
    };
  }
}

export function scoreAuction(deliverable: string, o: AuctionOracle): NativeScore {
  const fields = parseFields(deliverable, o.tag, "ASSIGN");
  if (!fields) return { correct: false, score: 0, details: { error: "no ASSIGN line" } };
  const byName = new Map(o.members.map((m, i) => [m.toLowerCase(), i]));
  const assign: number[] = [];
  const problems: string[] = [];
  o.subtasks.forEach((s, t) => {
    const v = fields.get(s.toLowerCase());
    const i = v === undefined ? undefined : byName.get(v.trim().toLowerCase());
    if (i === undefined)
      problems.push(`${s}: ${v === undefined ? "missing" : `unknown member "${v}"`}`);
    else assign[t] = i;
  });
  const load = new Map<number, number>();
  for (const i of assign) if (i !== undefined) load.set(i, (load.get(i) ?? 0) + 1);
  for (const [i, k] of load)
    if (k > o.capacity) problems.push(`${o.members[i]} over capacity (${k} > ${o.capacity})`);
  if (problems.length > 0) return { correct: false, score: 0, details: { valid: false, problems } };
  const achieved = assign.reduce((a, i, t) => a + o.cost[i]![t]!, 0);
  return {
    correct: achieved === o.optimalCost,
    score: o.optimalCost / achieved,
    details: { valid: true, achievedCost: achieved, optimalCost: o.optimalCost },
  };
}

export const auctionGenerator: NativeGenerator<AuctionOracle> = {
  id: "auction",
  title: "Private-cost task auction",
  shape: "auction",
  generate: generateAuction,
  score: scoreAuction,
};
