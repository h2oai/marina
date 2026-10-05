// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the obligations ledger teaches the learning loop (`src/learning`). Only
 * a nudge that led the model to act is an outcome: the draft was about to leave
 * a requested state change undone, and one reminder recovered it. The outcome
 * is written in general terms; the obligation text rides only as
 * `privateContext` (the leak check's reference, never stored).
 */

import type { Outcome } from "../learning/outcomes";
import type { Obligation } from "./ledger";

export function recoveredObligationOutcome(input: {
  /** Producer surface, e.g. `passthru`, `agent`. */
  surface: string;
  owed: Obligation[];
  /** Tool the model called after the nudge. */
  tool?: string;
  now: number;
  refs?: string[];
}): Outcome {
  return {
    domain: "tools",
    source: `obligations:${input.surface}`,
    succeeded: false,
    resolvedAt: new Date(input.now).toISOString(),
    attempted:
      "finishing a multi-step tool conversation with every requested state change carried out or explicitly declined",
    signals: ["final reply drafted with no tool call", "open request with no matching action"],
    detail:
      `the drafted final reply left ${input.owed.length} requested state change(s) with no matching successful tool call; ` +
      `one reminder listing them led the model to call ${input.tool ? "a state-changing tool" : "a tool"} before replying`,
    scope: "method",
    ...(input.refs?.length ? { refs: input.refs } : {}),
    privateContext: input.owed
      .map((o) => `${o.what} ${o.target ?? ""} ${o.constraints ?? ""}`)
      .join("\n"),
  };
}
