// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A formation as a declarative Score template: which steps there are, which
 * fan out K times, which step's output feeds which, and who works each one
 * as an ABSTRACT slot (`forecaster`, `referee`, `member`, `checker`, …).
 * `formationScore` instantiates a template for K members into an ordinary
 * Score (`src/sdk/score.ts`) whose assignees are whatever the caller resolved
 * each slot to — `model:<id>`, `role:<r>`, `marina:<crew>` or the in-process
 * pipeline — so the same template runs over models and over residents.
 *
 * Pure: no transport, no model calls. Execution is the Score executor
 * (`./run.ts` → `src/sdk/score-executor.ts`) with a per-surface dispatch;
 * combining is the formation's pure combiner (`./combine-*.ts`).
 *
 * Fan-out kinds:
 *   k        one instance per member (`f1 … fK`), run in parallel
 *   chain    one instance per member, each reading the one before (a pipeline)
 *   bracket  a single-elimination knockout over an entrant step's instances
 *            (`knockout`): one step per match, one per bye, scheduled
 *            match-by-match (`sequential`) or round-by-round (`rounds`)
 */

import type { Score, ScoreStep } from "../../sdk/score";

export type FanOut = "k" | "chain" | "bracket";

/** A step a template step reads. */
export interface StepAccess {
  step: string;
  /** For a fanned reader of a fanned step: only the instance with its own index. */
  each?: "same";
}

export interface TemplateStep {
  /** The step id; a fanned step's instances are `<id>1 … <id>K`. */
  id: string;
  /** The abstract assignee, resolved at run time (`InstantiateOptions.assign`). */
  slot: string;
  /** The subtask; a fanned step's text may depend on its instance (0-based) and K. */
  instruction: string | ((i: number, n: number) => string);
  fanOut?: FanOut;
  /** Bracket steps: the entrant step and how the matches are scheduled. */
  bracket?: { entrants: string; schedule: "sequential" | "rounds" };
  access: ReadonlyArray<string | StepAccess>;
}

export interface FormationTemplate {
  /** The Score's goal for n members. */
  goal: (n: number) => string;
  /** A fixed member count, whatever K is asked (the skeptic crew has two proposers). */
  k?: number;
  /**
   * The step whose instances are the formation's entrants. A surface whose
   * members can drop out runs it first, then the whole template over the
   * entrants that answered (`formationScore` with `k` = the survivors).
   */
  entrants?: string;
  steps: readonly TemplateStep[];
}

// ─── The knockout bracket ────────────────────────────────────────────────────

/** One bracket step: a match between `a` and `b`, or a bye for `a` (no `b`). */
export interface BracketSlot {
  /** The step id; its output is the winner (a bye passes `a` through). */
  id: string;
  /** 1-based. */
  round: number;
  /** The contestants, as step ids (an entrant or an earlier bracket step). */
  a: string;
  b?: string;
}

/**
 * The single-elimination bracket over `entrants` (step ids, in order): each
 * round pairs the field in order and an odd one out (the last) gets a bye.
 * Matches are `<prefix>1 … <prefix>(n-1)` in play order; byes `<prefix>-bye<round>`.
 */
export function knockout(entrants: readonly string[], prefix = "m"): BracketSlot[][] {
  const rounds: BracketSlot[][] = [];
  let field = [...entrants];
  let match = 0;
  for (let round = 1; field.length > 1; round++) {
    const slots: BracketSlot[] = [];
    for (let i = 0; i < field.length; i += 2) {
      const a = field[i]!;
      const b = field[i + 1];
      slots.push(
        b === undefined
          ? { id: `${prefix}-bye${round}`, round, a }
          : { id: `${prefix}${++match}`, round, a, b },
      );
    }
    rounds.push(slots);
    field = slots.map((s) => s.id);
  }
  return rounds;
}

// ─── Instantiation ───────────────────────────────────────────────────────────

export interface InstantiateOptions {
  /** Members (K); a template's own `k` wins. */
  k: number;
  /** The assignee a slot resolves to (`i`: a fanned step's instance, 0-based; else 0). */
  assign: (slot: string, i: number) => string;
  id: string;
  /** Default: the template's goal for K. */
  goal?: string;
  author?: string;
  /** Instantiate only these template steps (and drop access to the others). */
  only?: readonly string[];
}

const instanceId = (id: string, i: number) => `${id}${i + 1}`;

/** The member count a template runs with when asked for `k`. */
export function membersFor(template: FormationTemplate, k: number): number {
  return Math.max(1, template.k ?? Math.round(k));
}

/** The step ids of a template step's instances, in order. */
function instancesOf(
  step: TemplateStep,
  n: number,
  bracket: ReadonlyMap<string, BracketSlot[][]>,
): string[] {
  if (step.fanOut === "bracket") return (bracket.get(step.id) ?? []).flat().map((s) => s.id);
  if (step.fanOut) return Array.from({ length: n }, (_, i) => instanceId(step.id, i));
  return [step.id];
}

/**
 * Instantiate a template for K members into a Score. With `only`, the other
 * steps are left out (work done elsewhere — a surface's entrants that already
 * answered) and every access to them is dropped, so the kept steps that read
 * only them start at once.
 */
export function formationScore(template: FormationTemplate, opts: InstantiateOptions): Score {
  const n = membersFor(template, opts.k);
  const all = new Map(template.steps.map((s) => [s.id, s]));
  const kept = opts.only ? template.steps.filter((s) => opts.only!.includes(s.id)) : template.steps;
  const bracket = new Map<string, BracketSlot[][]>();
  for (const s of template.steps) {
    if (s.fanOut !== "bracket" || !s.bracket) continue;
    const entrants = all.get(s.bracket.entrants);
    bracket.set(s.id, entrants ? knockout(instancesOf(entrants, n, bracket), s.id) : []);
  }
  /** The step ids a reference names, whether or not they are in this Score. */
  const names = (ref: string | StepAccess, i: number): string[] => {
    const access = typeof ref === "string" ? { step: ref } : ref;
    const target = all.get(access.step);
    if (!target) return [];
    if (access.each === "same" && target.fanOut && target.fanOut !== "bracket")
      return [instanceId(target.id, i)];
    return instancesOf(target, n, bracket);
  };
  const present = new Set(kept.flatMap((s) => instancesOf(s, n, bracket)));
  const inScore = (ids: string[]) => [...new Set(ids)].filter((id) => present.has(id));
  const steps: ScoreStep[] = [];
  for (const s of kept) {
    const text = (i: number) =>
      typeof s.instruction === "string" ? s.instruction : s.instruction(i, n);
    if (s.fanOut === "bracket") {
      const rounds = bracket.get(s.id) ?? [];
      let previous: string[] = s.bracket ? names(s.bracket.entrants, 0) : [];
      let last: string | undefined;
      for (const round of rounds) {
        for (const slot of round) {
          const contestants = [slot.a, ...(slot.b ? [slot.b] : [])];
          const access =
            s.bracket?.schedule === "rounds" ? previous : [...contestants, ...(last ? [last] : [])];
          steps.push({
            id: slot.id,
            instruction: text(slot.round - 1),
            assignee: opts.assign(s.slot, 0),
            access: inScore([...access, ...s.access.flatMap((r) => names(r, 0))]),
          });
          last = slot.id;
        }
        previous = round.map((slot) => slot.id);
      }
      continue;
    }
    const count = s.fanOut ? n : 1;
    for (let i = 0; i < count; i++) {
      const own = s.fanOut === "chain" && i > 0 ? [instanceId(s.id, i - 1)] : [];
      steps.push({
        id: s.fanOut ? instanceId(s.id, i) : s.id,
        instruction: text(i),
        assignee: opts.assign(s.slot, i),
        access: inScore([...own, ...s.access.flatMap((r) => names(r, i))]),
      });
    }
  }
  return {
    id: opts.id,
    goal: opts.goal ?? template.goal(n),
    author: opts.author ?? "marina",
    steps,
  };
}

/** The template's steps after its entrants (what runs over the entrants that answered). */
export function afterEntrants(template: FormationTemplate): string[] {
  return template.steps.filter((s) => s.id !== template.entrants).map((s) => s.id);
}
