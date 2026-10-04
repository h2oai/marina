// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Budget-terminal answering: every bounded loop ends in an answer, never in
 * silence. One mechanism for every loop with a turn, step or time budget —
 * the lean agent's per-run caps, the benchmark/research tool loops, crew
 * request deadlines and typed forecasts:
 *
 *   work   — below the steer point: nothing changes;
 *   steer  — from about three quarters of the budget (the same point as the
 *            lean agent's 75 % run-cap warning): tell the loop how much is
 *            left and to converge on an answer from what it already has;
 *   final  — at the cap: no more tools; ask for the best final answer from
 *            what the loop has gathered, and label it `budget_forced`.
 *
 * A forced answer is a labelled best effort, not a failure and not a free
 * answer: callers record `BudgetForced` in the trace and in benchmark items
 * (`budget_forced`, migration 155) so it is never counted as either silently.
 *
 * Pure: no I/O. Each loop owns how it injects the note and the final request.
 */

/** Share of the budget after which the loop is steered toward answering. */
export const BUDGET_STEER_FRACTION = 0.75;

export type BudgetPhase = "work" | "steer" | "final";

/** What a budget counts. */
export type BudgetUnit = "turns" | "steps" | "tool calls" | "ms";

/** Why an answer was forced (recorded with it). */
export type BudgetForcedReason =
  | "turns"
  | "steps"
  | "tool calls"
  | "time"
  | "deadline"
  | "upstream_error";

/** The label a forced answer carries in traces and results. */
export interface BudgetForced {
  reason: BudgetForcedReason;
  /** Budget used when the answer was forced. */
  used: number;
  /** The cap. */
  cap: number;
  /** Where the answer came from, e.g. `final-request`, `lead-draft`, `member-plurality`, `runs-so-far`. */
  source?: string;
}

/** The first use count at which a loop with `cap` is steered (≥ 1, < cap when cap > 1). */
export function budgetSteerAt(cap: number, fraction = BUDGET_STEER_FRACTION): number {
  return Math.max(1, Math.ceil(cap * fraction));
}

/** The phase after `used` of `cap` have been spent. */
export function budgetPhase(
  used: number,
  cap: number,
  fraction = BUDGET_STEER_FRACTION,
): BudgetPhase {
  if (!(cap > 0) || used >= cap) return "final";
  return used >= budgetSteerAt(cap, fraction) ? "steer" : "work";
}

function amount(n: number, unit: BudgetUnit): string {
  if (unit === "ms") return `${Math.max(0, Math.round(n / 1000))}s`;
  const singular = unit === "tool calls" ? "tool call" : unit.slice(0, -1);
  return `${n} ${n === 1 ? singular : unit}`;
}

/**
 * The steer note: what is left and what to do with it. Short and factual —
 * the loop decides how to inject it (a user message, a steer, a reminder).
 */
export function budgetSteerNote(used: number, cap: number, unit: BudgetUnit): string {
  const left = Math.max(0, cap - used);
  return (
    `[Budget] ${amount(left, unit)} left of ${amount(cap, unit)}. ` +
    "Converge now: check the most promising lead you already have, then give your final answer. " +
    "An answer from the evidence in hand beats no answer."
  );
}

/** The request made at the cap: no more tools, the best answer from what the loop has. */
export function budgetFinalRequest(cap: number, unit: BudgetUnit, format?: string): string {
  return (
    `[Budget reached] The ${amount(cap, unit)} budget is spent: no more tool calls. ` +
    "Give your final answer now from what you have already found. " +
    "If you are unsure, give your best guess and say how confident you are." +
    (format ? ` ${format}` : "")
  );
}

/**
 * What makes two drafts the same answer: the labelled final answer line when
 * there is one (`Exact Answer:`, `Final Answer:`, `Answer:`), else the whole
 * text — lower-cased, whitespace collapsed, surrounding punctuation trimmed.
 */
export function draftAnswerKey(text: string): string {
  const labelled = [
    ...text.matchAll(
      /^[\s*#>-]*(?:exact answer|final answer|answer)\s*\**\s*[:：]\s*\**\s*(.+)$/gim,
    ),
  ].at(-1)?.[1];
  return (labelled ?? text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`.,;:!?()[\]*]+|[\s"'`.,;:!?()[\]*]+$/g, "");
}

/**
 * The most-agreed draft among several members' drafts (by `draftAnswerKey`):
 * the plurality answer, ties to the latest draft. `support` is the share of
 * drafts that agree with it. Undefined when there is no non-empty draft.
 */
export function mostAgreedDraft(
  drafts: readonly string[],
): { text: string; support: number } | undefined {
  const usable = drafts.map((d) => d.trim()).filter(Boolean);
  if (usable.length === 0) return undefined;
  const tally = new Map<string, { count: number; last: number }>();
  usable.forEach((d, i) => {
    const key = draftAnswerKey(d);
    const had = tally.get(key) ?? { count: 0, last: -1 };
    tally.set(key, { count: had.count + 1, last: i });
  });
  const [, best] = [...tally.entries()].sort(
    (a, b) => b[1].count - a[1].count || b[1].last - a[1].last,
  )[0]!;
  return { text: usable[best.last]!, support: best.count / usable.length };
}

/**
 * HTTP header Marina sets on a reply forced at a budget (a crew deadline, an
 * upstream refusal while a draft exists): the reason, e.g. `deadline`.
 */
export const BUDGET_FORCED_HEADER = "x-marina-budget-forced";

/**
 * Request header a harness sends with its own per-item deadline (milliseconds
 * from now): Marina answers with the best draft before it, instead of the
 * client aborting with nothing.
 */
export const DEADLINE_HEADER = "x-marina-deadline-ms";
