// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The agent's idle turn, split by kind of write.
 *
 * An idle agent used to be handed a curation menu: resolve a contradiction,
 * link evidence, evolve a stale belief, store a procedure. That is the agent
 * rewriting its own store with no transition check, no grouping and no
 * rollback — the pattern the 2026 memory studies measure as harmful. Every
 * write that REWRITES the store belongs to a checked consolidation pass.
 *
 * What the agent alone can do at idle is APPEND: say what it now believes and
 * what changed its mind, while it still has the context. So the idle ask is
 * one reflection (a new record, never an edit), a goal update if the goal
 * moved, then rest.
 *
 * `MARINA_IDLE_REFLECTION`:
 *   - `append` (default): the append-only ask above.
 *   - `rest`: keep the idle detection; offer only rest.
 * The two are measured against each other on task success; neither rewrites
 * the store. The old curation menu is not an arm.
 */

export type IdleReflectionMode = "append" | "rest";

export function idleReflectionMode(env: NodeJS.ProcessEnv = process.env): IdleReflectionMode {
  const v = env.MARINA_IDLE_REFLECTION?.trim().toLowerCase();
  return v === "rest" || v === "off" || v === "none" ? "rest" : "append";
}

/** The section header the adapter and its tests key on. */
export const QUIET_HEADER = "[Quiet — nothing needs your attention]";
export const REFLECTION_DUE_HEADER = "[Reflection Due]";

/** The one append-only ask, shared by `[Quiet]` and `[Reflection Due]`. */
export const APPEND_ASK =
  "If this stretch of work changed what you believe, write ONE reflection — your current hypothesis for your focus and what changed it, citing the notes, tasks or outcomes that moved you (`#12`, `task:4`): `memory note <text> type reflection`. " +
  "If your goal moved, update it (`memory set goal <objective>`). " +
  "Do not resolve, link, evolve, merge or delete notes: that is consolidation, and it belongs to a checked pass, not an idle turn. " +
  "A note that only records quiet or repeats a status adds noise.";

export const REST_ASK =
  "Rest (`memory set rest <why>`) and end the turn: new requests and work reach you as World Events.";

/** The body under `[Quiet — nothing needs your attention]`. */
export function quietBody(mode: IdleReflectionMode): string {
  return mode === "append"
    ? `${APPEND_ASK} Then rest (\`memory set rest <why>\`) and end the turn: new requests and work reach you as World Events.`
    : REST_ASK;
}

/**
 * The body under `[Reflection Due]` — the same ask, with the count that
 * triggered it; `undefined` in `rest` mode, where there is nothing to ask that
 * `[Quiet]` does not already say.
 */
export function reflectionDueBody(
  mode: IdleReflectionMode,
  notesSince: number,
): string | undefined {
  if (mode !== "append") return undefined;
  return `${notesSince} new note${notesSince === 1 ? "" : "s"} since your last reflection. ${APPEND_ASK} \`skill builtin consolidate-memory\` has the steps.`;
}

/** A saved note of the reflection tier (`memory note … type reflection`) counts as a reflection. */
export function savedReflection(toolResultText: string): boolean {
  return /Note #\d+ saved\b.*\btype=reflection\b/.test(toolResultText);
}
