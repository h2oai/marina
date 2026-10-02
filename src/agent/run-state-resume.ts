// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure resume decision over a persisted `run_state` row. Every crash-safe
// resume path (agent boot, supervisor recovery) funnels through this instead
// of re-implementing the replay contract.
//
// The contract mirrors Pi Durable's `replay` tool annotation, expressed on
// Marina's own `ToolReplay` union (stamped onto read-only tools by
// `applyToolReplayPolicy` in src/agent/tools/profiles.ts):
//   - `safe`  → the effect only observed, so a resume may re-run it.
//   - `never` → re-running could double a world mutation; report the
//               interruption to the model and let it decide instead.

import type { RunState, ToolReplay } from "../persistence/db-run-state";

export type RunStateResumeAction =
  /** The effect is safe to repeat; re-drive it from the stored intent. */
  | { kind: "rerun" }
  /** The effect must not repeat; tell the model it was interrupted. */
  | { kind: "report_interrupted" }
  /** Nothing in flight; boot proceeds with the normal summary-resume path. */
  | { kind: "none" };

export function resumeActionForRunState(state: RunState | undefined): RunStateResumeAction {
  if (!state) return { kind: "none" };
  if (state.phase === "tool_call") {
    return state.replay === "safe" ? { kind: "rerun" } : { kind: "report_interrupted" };
  }
  return { kind: "none" };
}

/** Human-facing summary of what a resume will do with an in-flight state. */
export function describeResumeAction(state: RunState | undefined): string {
  const action = resumeActionForRunState(state);
  switch (action.kind) {
    case "rerun":
      return `re-run tool ${state?.toolName ?? "(unknown)"} (replay: safe)`;
    case "report_interrupted":
      return `tool ${state?.toolName ?? "(unknown)"} was interrupted and will not be repeated`;
    case "none":
      return "no in-flight effect to resume";
  }
}

/** Exported for schema-driven checks; a valid replay policy is never invalid. */
export function isToolReplay(value: unknown): value is ToolReplay {
  return value === "safe" || value === "never";
}
