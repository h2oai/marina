// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Score — a generated, executable workflow DAG.
 *
 * Marina's native form of the "Conductor" grammar (arXiv:2512.04388): the
 * paper's three synchronized lists (subtasks / model_id / access_list) folded
 * into one structure. A Score is a DAG of steps; each step carries an
 * instruction, an assignee, and the ids of prior steps whose outputs it may
 * read. Topology (best-of-N, chain, tree) is whatever shape the steps describe
 * — not a fixed mode.
 *
 * A Score is an artifact any sufficiently-standing agent can author, run, fork,
 * and mutate (see docs/conductor-design.md, Phase 4). The grammar here is pure
 * and transport-free: validation and topological layering only. Execution lives
 * in score-executor.ts with the worker-dispatch function injected, so the same
 * Score runs over tellAndAwait in production and over a mock in tests.
 */

/** How a step's assignee is addressed. */
export type AssigneeKind = "entity" | "role" | "model" | "conduct";

export interface ScoreStep {
  /** Unique within the Score. */
  id: string;
  /** Natural-language subtask handed to the worker. */
  instruction: string;
  /**
   * Who performs the step. One of:
   *   "<name>"            — a specific agent by name
   *   "role:<role>"       — resolved at run time to the best-standing live member
   *   "model:<prov/id>"   — a direct model worker
   *   "conduct"           — recursion: this step is itself conducted (sub-Score)
   */
  assignee: string;
  /** Ids of prior steps whose outputs feed this step's context. */
  access: string[];
}

export interface Score {
  id: string;
  goal: string;
  author: string;
  steps: ScoreStep[];
}

export interface ParsedAssignee {
  kind: AssigneeKind;
  /** entity name, role name, or model id; empty for "conduct". */
  value: string;
}

/** Classify an assignee string into its kind + value. */
export function parseAssignee(assignee: string): ParsedAssignee {
  const a = assignee.trim();
  if (a === "conduct") return { kind: "conduct", value: "" };
  if (a.startsWith("role:")) return { kind: "role", value: a.slice(5).trim() };
  if (a.startsWith("model:")) return { kind: "model", value: a.slice(6).trim() };
  return { kind: "entity", value: a };
}

export class ScoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ScoreError";
  }
}

/**
 * Parse a Score from a JSON object/string. Fills defaults (generated id,
 * empty access lists) and normalizes shapes. Throws ScoreError on malformed
 * input. Does NOT validate the DAG — call validateScore for that.
 */
export function parseScore(
  input: string | Record<string, unknown>,
  defaults: { author?: string } = {},
): Score {
  let obj: Record<string, unknown>;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input) as Record<string, unknown>;
    } catch (e) {
      throw new ScoreError(`Score is not valid JSON: ${(e as Error).message}`, "bad_json");
    }
  } else {
    obj = input;
  }

  const rawSteps = obj.steps;
  if (!Array.isArray(rawSteps)) {
    throw new ScoreError("Score must have a 'steps' array", "no_steps");
  }

  const steps: ScoreStep[] = rawSteps.map((s, i) => {
    const step = s as Record<string, unknown>;
    const id = typeof step.id === "string" && step.id.trim() ? step.id.trim() : `s${i + 1}`;
    const instruction = typeof step.instruction === "string" ? step.instruction : "";
    const assignee = typeof step.assignee === "string" ? step.assignee.trim() : "";
    const access = Array.isArray(step.access)
      ? step.access.filter((x): x is string => typeof x === "string")
      : [];
    return { id, instruction, assignee, access };
  });

  return {
    id: typeof obj.id === "string" && obj.id ? obj.id : `score_${Date.now().toString(36)}`,
    goal: typeof obj.goal === "string" ? obj.goal : "",
    author: typeof obj.author === "string" ? obj.author : (defaults.author ?? "unknown"),
    steps,
  };
}

export function serializeScore(score: Score): string {
  return JSON.stringify(score, null, 2);
}

/**
 * The step whose output is the Score's result. Per the paper, the final step
 * in sequence is the response; we take the last authored step.
 */
export function terminalStepId(score: Score): string | undefined {
  return score.steps[score.steps.length - 1]?.id;
}

/**
 * Validate a Score's structure. Returns an error message, or null if valid.
 * Checks: at least one step; unique non-empty ids; every step has an
 * instruction and assignee; access ids reference real steps and not self;
 * the dependency graph is acyclic.
 */
export function validateScore(score: Score): string | null {
  if (score.steps.length === 0) return "Score has no steps.";

  const ids = new Set<string>();
  for (const step of score.steps) {
    if (!step.id) return "Every step needs a non-empty id.";
    if (ids.has(step.id)) return `Duplicate step id "${step.id}".`;
    ids.add(step.id);
  }

  for (const step of score.steps) {
    if (!step.instruction.trim()) return `Step "${step.id}" has no instruction.`;
    if (!step.assignee) return `Step "${step.id}" has no assignee.`;
    for (const dep of step.access) {
      if (dep === step.id) return `Step "${step.id}" cannot access its own output.`;
      if (!ids.has(dep)) return `Step "${step.id}" accesses unknown step "${dep}".`;
    }
  }

  // Acyclic check via topological layering — if it can't layer every step, a
  // cycle exists.
  if (topoLayersOrNull(score) === null) {
    return "Score has a dependency cycle.";
  }
  return null;
}

/**
 * Group steps into execution layers: each layer holds steps whose access deps
 * are all satisfied by earlier layers, so a layer's steps can run
 * concurrently. Returns null if the graph has a cycle. Assumes ids are unique
 * and access refs are valid (validateScore enforces both).
 */
function topoLayersOrNull(score: Score): ScoreStep[][] | null {
  const byId = new Map(score.steps.map((s) => [s.id, s]));
  const remaining = new Set(score.steps.map((s) => s.id));
  const done = new Set<string>();
  const layers: ScoreStep[][] = [];

  while (remaining.size > 0) {
    const layer: ScoreStep[] = [];
    for (const id of remaining) {
      const step = byId.get(id)!;
      if (step.access.every((dep) => done.has(dep))) layer.push(step);
    }
    if (layer.length === 0) return null; // cycle — nothing newly satisfiable
    for (const step of layer) {
      remaining.delete(step.id);
    }
    // Mark this layer done only after building it, so intra-layer deps (none
    // by construction) can't sneak in.
    for (const step of layer) done.add(step.id);
    layers.push(layer);
  }
  return layers;
}

/** Public layering — throws if the Score has a cycle (validate first). */
export function topoLayers(score: Score): ScoreStep[][] {
  const layers = topoLayersOrNull(score);
  if (layers === null) throw new ScoreError("Score has a dependency cycle.", "cycle");
  return layers;
}
