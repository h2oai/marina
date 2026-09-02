// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live execution of a Score over the agent transport.
 *
 * Wires the transport-free executor (src/coordination/score-executor.ts) to a
 * real worker-dispatch primitive: `tellAndAwait`. An organizer agent (or an
 * external SDK script) hands each step's instruction — plus the outputs of the
 * steps it accesses — to the resolved worker and awaits the reply. This is the
 * concrete realization of the Conductor: a Score becomes a running organization.
 *
 * Kept separate from client.ts so the dispatch wiring is unit-testable with a
 * fake `tellAndAwait`. See the conductor design (private archive: marina-internal design/conductor-design.md), Phase 4.
 */

import type { ParsedAssignee, Score } from "../coordination/score";
import {
  type DispatchContext,
  executeScore,
  type ScoreRun,
  type ScoreStepEvent,
} from "../coordination/score-executor";

export interface RunScoreDeps {
  /** Dispatch one worker request and await its reply (one round trip). */
  tellAndAwait: (target: string, message: string, timeoutMs?: number) => Promise<string>;
  /**
   * Resolve a `role:`/`model:` assignee to a concrete target name. Entity
   * assignees resolve to their value automatically. Return null to fall back to
   * the default (which errors for unresolved `role:`).
   */
  resolveAssignee?: (a: ParsedAssignee) => string | null;
  /** Per-step reply timeout, forwarded to tellAndAwait. */
  timeoutMs?: number;
  /** Recursion cap for conduct steps. */
  maxDepth?: number;
  onStep?: (ev: ScoreStepEvent) => void;
}

/** Compose the message handed to a worker: instruction + threaded inputs. */
export function composeStepMessage(ctx: DispatchContext): string {
  const parts = [ctx.step.instruction.trim()];
  if (ctx.inputs.length > 0) {
    parts.push("", "Context from prior steps:");
    for (const inp of ctx.inputs) parts.push(`[${inp.fromStepId}] ${inp.output}`);
  }
  parts.push("", "Reply with your result only.");
  return parts.join("\n");
}

/** Default assignee → target: entity and model address by their value; role
 * needs an injected resolver (returns null here). */
function defaultResolve(a: ParsedAssignee): string | null {
  if (a.kind === "entity" || a.kind === "model") return a.value || null;
  return null;
}

/**
 * Run a Score live, dispatching each step via `tellAndAwait`. `conduct` steps
 * have no handler here, so they surface the executor's clear error — recursive
 * sub-Score synthesis is a separate capability.
 */
export async function runScore(score: Score, deps: RunScoreDeps): Promise<ScoreRun> {
  const dispatch = async (ctx: DispatchContext): Promise<string> => {
    const target = deps.resolveAssignee?.(ctx.assignee) ?? defaultResolve(ctx.assignee);
    if (!target) {
      throw new Error(
        `Cannot resolve assignee "${ctx.step.assignee}" for step "${ctx.step.id}" — supply a resolver for role:/model: workers.`,
      );
    }
    return deps.tellAndAwait(target, composeStepMessage(ctx), deps.timeoutMs);
  };
  return executeScore(score, dispatch, { onStep: deps.onStep, maxDepth: deps.maxDepth });
}
