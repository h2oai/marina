// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Split-key constraint problem (private information).
 *
 * A meeting-scheduling CSP with a planted solution. Constraints true under
 * the planted assignment are added until the solution is unique, then the set
 * is minimised (every constraint is necessary), so a member missing any share
 * cannot pin the answer. Shares are dealt round-robin as private tells.
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
  parseIntStrict,
  privateMap,
  resolveMembers,
  type SetupStep,
} from "./shared";

export type CspConstraint =
  | { t: "ne"; a: number; b: number }
  | { t: "lt"; a: number; b: number }
  | { t: "notin"; a: number; s: number }
  | { t: "gap"; a: number; b: number; k: number };

export interface CspOracle {
  tag: string;
  meetings: number;
  slots: number;
  constraints: CspConstraint[];
  /** The unique solution, slot per meeting (index 0 = M1). */
  solution: number[];
  /** Constraint indices held by each member. */
  shares: Record<string, number[]>;
}

const name = (i: number) => `M${i + 1}`;

export function renderConstraint(c: CspConstraint): string {
  switch (c.t) {
    case "ne":
      return `${name(c.a)} and ${name(c.b)} in different slots`;
    case "lt":
      return `${name(c.a)} in an earlier slot than ${name(c.b)}`;
    case "notin":
      return `${name(c.a)} not in slot ${c.s}`;
    case "gap":
      return `${name(c.a)} and ${name(c.b)} at least ${c.k} slots apart`;
  }
}

/** True when `c` holds; unassigned (undefined) variables make it false. */
export function holds(c: CspConstraint, slot: (number | undefined)[]): boolean {
  const a = slot[c.a];
  if (a === undefined) return false;
  if (c.t === "notin") return a !== c.s;
  const b = slot[c.b];
  if (b === undefined) return false;
  if (c.t === "ne") return a !== b;
  if (c.t === "lt") return a < b;
  return Math.abs(a - b) >= c.k;
}

/** Number of complete assignments satisfying every constraint, counted up to `limit`. */
export function countSolutions(
  meetings: number,
  slots: number,
  constraints: CspConstraint[],
  limit = 2,
): number {
  // Constraints indexed by their highest variable: checked once that variable is assigned.
  const byVar: CspConstraint[][] = Array.from({ length: meetings }, () => []);
  for (const c of constraints) byVar[c.t === "notin" ? c.a : Math.max(c.a, c.b)]!.push(c);
  const slot: (number | undefined)[] = new Array(meetings).fill(undefined);
  let count = 0;
  const rec = (i: number): void => {
    if (count >= limit) return;
    if (i === meetings) {
      count++;
      return;
    }
    for (let s = 1; s <= slots; s++) {
      slot[i] = s;
      if (byVar[i]!.every((c) => holds(c, slot))) rec(i + 1);
      if (count >= limit) break;
    }
    slot[i] = undefined;
  };
  rec(0);
  return count;
}

function candidate(
  rng: ReturnType<typeof makeRng>,
  m: number,
  slots: number,
  sol: number[],
): CspConstraint | null {
  const a = rng.int(0, m - 1);
  let b = rng.int(0, m - 2);
  if (b >= a) b++;
  const r = rng.next();
  let c: CspConstraint;
  if (r < 0.3) c = { t: "ne", a, b };
  else if (r < 0.6) c = sol[a]! < sol[b]! ? { t: "lt", a, b } : { t: "lt", a: b, b: a };
  else if (r < 0.85) c = { t: "notin", a, s: rng.int(1, slots) };
  else c = { t: "gap", a, b, k: rng.int(2, 3) };
  return holds(c, sol) ? c : null;
}

export function generateCsp(seed: number, opts?: GenerateOptions): NativeInstance<CspOracle> {
  const members = resolveMembers(opts);
  const pool = opts?.pool ?? DEFAULT_POOL;
  const tag = `CSP${seed}`;
  for (let attempt = 0; ; attempt++) {
    const rng = makeRng(seed, `csp:${attempt}`);
    const meetings = rng.int(6, 8);
    const slots = rng.int(4, 5);
    const sol = Array.from({ length: meetings }, () => rng.int(1, slots));
    let cs: CspConstraint[] = [];
    for (let tries = 0; tries < 2000 && countSolutions(meetings, slots, cs) > 1; tries++) {
      const c = candidate(rng, meetings, slots, sol);
      if (c) cs.push(c);
    }
    if (countSolutions(meetings, slots, cs) !== 1) continue;
    // Minimise: drop any constraint whose removal keeps the solution unique.
    for (let i = cs.length - 1; i >= 0; i--) {
      const without = cs.filter((_, j) => j !== i);
      if (countSolutions(meetings, slots, without) === 1) cs = without;
    }
    if (members.length > 1 && cs.length < members.length) continue;
    const order = rng.shuffle(cs.map((_, i) => i));
    const shares: Record<string, number[]> = {};
    members.forEach((mem, k) => {
      shares[mem] = order.filter((_, j) => j % members.length === k).sort((x, y) => x - y);
    });
    const range = `M1–${name(meetings - 1)}`;
    const setup: SetupStep[] = members.map((mem) => ({
      kind: "private",
      member: mem,
      text: `PRIVATE ${tag} constraints (yours only; others hold the rest): ${shares[mem]!.map((i) => renderConstraint(cs[i]!)).join("; ")}.`,
    }));
    const format = `${tag} SCHEDULE: ${Array.from({ length: meetings }, (_, i) => `${name(i)}=<slot>`).join("; ")}.`;
    const text =
      `TASK ${tag} (split constraints): Schedule meetings ${range} into slots 1–${slots}, one slot each; slots may hold several meetings. ` +
      `The constraints are split across crew members' private Operator tells headed PRIVATE ${tag}; no member holds them all. ` +
      `Pool every share, then find the assignment satisfying ALL constraints (it is unique). ${depositClause(pool, format)}`;
    return {
      task: "csp",
      seed,
      tag,
      shape: "private information",
      text,
      privateMaterial: privateMap(setup),
      setup,
      pool,
      deliverableRe: deliverableRe(tag, "SCHEDULE"),
      answer: `${tag} SCHEDULE: ${sol.map((s, i) => `${name(i)}=${s}`).join("; ")}`,
      oracle: { tag, meetings, slots, constraints: cs, solution: sol, shares },
    };
  }
}

export function scoreCsp(deliverable: string, o: CspOracle): NativeScore {
  const fields = parseFields(deliverable, o.tag, "SCHEDULE");
  if (!fields) return { correct: false, score: 0, details: { error: "no SCHEDULE line" } };
  const slot: (number | undefined)[] = [];
  const invalid: string[] = [];
  for (let i = 0; i < o.meetings; i++) {
    const v = parseIntStrict(fields.get(name(i).toLowerCase()));
    if (v === null || v < 1 || v > o.slots) invalid.push(name(i));
    else slot[i] = v;
  }
  const violated = o.constraints
    .map((c, i) => ({ i, c }))
    .filter(({ c }) => !holds(c, slot))
    .map(({ i, c }) => `#${i} ${renderConstraint(c)}`);
  const satisfied = o.constraints.length - violated.length;
  const correct = invalid.length === 0 && violated.length === 0;
  return {
    correct,
    score: o.constraints.length === 0 ? (correct ? 1 : 0) : satisfied / o.constraints.length,
    details: {
      satisfied,
      total: o.constraints.length,
      violated,
      invalid,
      matchesSolution: o.solution.every((s, i) => slot[i] === s),
    },
  };
}

export const cspGenerator: NativeGenerator<CspOracle> = {
  id: "csp",
  title: "Split-key constraint problem",
  shape: "private information",
  generate: generateCsp,
  score: scoreCsp,
};
