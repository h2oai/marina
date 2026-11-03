// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Procedures from work (agent-swarm's ≥ 2 evidences rule): the gather stage
 * looks for the same command sequence — command NAMES from the usage ledger,
 * never arguments or text — inside the claim windows of at least
 * PROCEDURE_MIN_TASKS distinct tasks the owner resolved as successes in the
 * dream's window. One such sequence that no existing skill or macro already
 * covers is a procedure candidate; a dream may `propose-skill` over it (the
 * model names and describes it; the steps are the ledger's), and the owner
 * adopts it as a skill DRAFT that a validation run or a person's verify makes
 * servable (`src/memory/skill-draft.ts`).
 */

import { createHash } from "node:crypto";
import type { MarinaDB } from "../../persistence/database";
import { coversProcedure } from "../skill-draft";
import { outcomeWorkWindow } from "../usefulness";

/** Distinct successful tasks a sequence must recur in. */
export const PROCEDURE_MIN_TASKS = 2;
/** A procedure's length, in commands. */
export const PROCEDURE_MIN_STEPS = 2;
export const PROCEDURE_MAX_STEPS = 12;
/** Tasks considered per dream, at most. */
export const PROCEDURE_MAX_TASKS = 50;
/** Candidates shown to the model, at most. */
export const PROCEDURE_MAX_CANDIDATES = 8;

export interface ProcedureCandidate {
  /** sha256 prefix of the steps joined — the op names it by this key. */
  key: string;
  /** Command labels in order (`recall`, `pool recall`, `task submit`, …). */
  steps: string[];
  /** Distinct task ids the sequence ran in, ascending. */
  tasks: number[];
  /** The outcome rows those tasks resolved as. */
  outcomes: number[];
}

export const procedureKey = (steps: readonly string[]) =>
  createHash("sha256").update(steps.join(" ; "), "utf8").digest("hex").slice(0, 16);

/** The owner's meaningful, successful command labels inside a window, consecutive repeats folded. */
export function commandSequence(
  db: MarinaDB,
  entityName: string,
  since: number,
  until: number,
): string[] {
  const rows = db
    .memoryRepository()
    .raw.query<{ safe_label: string }, [string, number, number]>(
      `SELECT safe_label FROM primitive_usage
       WHERE actor_name = ? AND source = 'command' AND meaningful = 1 AND success = 1
         AND created_at BETWEEN ? AND ?
       ORDER BY created_at, id LIMIT 500`,
    )
    .all(entityName, since, until);
  const steps: string[] = [];
  for (const row of rows) {
    const label = row.safe_label.trim();
    if (!label || steps[steps.length - 1] === label) continue;
    steps.push(label);
  }
  return steps;
}

const taskIdOf = (o: { refs_json: string | null }): number | undefined => {
  try {
    const refs = JSON.parse(o.refs_json ?? "[]") as unknown[];
    const ref = refs.find((r): r is string => typeof r === "string" && /^task:\d+$/.test(r));
    return ref ? Number(ref.slice(5)) : undefined;
  } catch {
    return undefined;
  }
};

export function gatherProcedures(
  db: MarinaDB,
  entityName: string,
  since: number,
  until: number,
): ProcedureCandidate[] {
  const outcomes = db
    .listOutcomes({ owner: entityName, since, source: "task:", limit: 500 })
    .filter((o) => o.succeeded === 1 && o.resolved_at <= until);
  // One window per task: the newest successful verdict on it.
  const byTask = new Map<number, (typeof outcomes)[number]>();
  for (const o of outcomes) {
    const taskId = taskIdOf(o);
    if (taskId === undefined) continue;
    const prior = byTask.get(taskId);
    if (!prior || prior.resolved_at < o.resolved_at) byTask.set(taskId, o);
  }
  const tasks = [...byTask.entries()].sort((a, b) => a[0] - b[0]).slice(0, PROCEDURE_MAX_TASKS);
  const groups = new Map<string, ProcedureCandidate>();
  for (const [taskId, o] of tasks) {
    const window = outcomeWorkWindow(db, o);
    const steps = commandSequence(db, entityName, window.since, window.until);
    if (steps.length < PROCEDURE_MIN_STEPS || steps.length > PROCEDURE_MAX_STEPS) continue;
    const key = procedureKey(steps);
    const group = groups.get(key) ?? { key, steps, tasks: [], outcomes: [] };
    group.tasks.push(taskId);
    group.outcomes.push(o.id);
    groups.set(key, group);
  }
  const existing = [
    ...db.getNotesByType(entityName, "skill", 500).map((n) => n.content),
    ...db.listMacros().map((m) => m.command),
  ];
  return [...groups.values()]
    .filter((g) => g.tasks.length >= PROCEDURE_MIN_TASKS)
    .filter((g) => !existing.some((text) => coversProcedure(text, g.steps)))
    .sort((a, b) => b.tasks.length - a.tasks.length || a.key.localeCompare(b.key))
    .slice(0, PROCEDURE_MAX_CANDIDATES);
}
