// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Answered challenges → decision cases. Pure.
 *
 * A challenge answer is a person's verdict on a REAL held action — the thing
 * the gate case sets lack most. Two exports, for two different jobs:
 *
 * - `live` (default): each outcome becomes a gate case labeled by the answer
 *   (approve ⇒ allow, deny ⇒ hold), family `challenge-live`, labeledBy
 *   `challenge`. These labels are NOT blind — the approver saw the context
 *   and only held actions ever reach them — so they are reported as their
 *   own family and never pooled with the independent sets.
 * - `blind`: the same actions WITHOUT the answer, in the Gate Label Desk's
 *   case shape, so a blind panel labels them independently; the panel's
 *   verdict can then be compared with the approver's.
 *
 * Summaries were masked before they were stored (migration 139).
 */

import type { ChallengeOutcomeRow } from "../persistence/db-decisions";

export interface ChallengeGateCase {
  id: string;
  command?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  intent: { goal: string; role: string; sources: string[] };
  expect: "allow" | "hold";
  family: "challenge-live";
  labeledBy: "challenge";
  answeredRole: string | null;
  class: string;
}

export interface BlindPanelCase {
  id: string;
  pool: "marina";
  tool: string;
  arguments: Record<string, unknown>;
  context: { goal: string; role: string; sources: string[] };
  labels: Record<string, string>;
}

function action(row: ChallengeOutcomeRow): { tool: string; arguments: Record<string, unknown> } {
  if (row.kind === "tool" && row.tool_name) {
    const args = row.summary.slice(row.tool_name.length).trim();
    try {
      return { tool: row.tool_name, arguments: JSON.parse(args) as Record<string, unknown> };
    } catch {
      return { tool: row.tool_name, arguments: { summary: args } };
    }
  }
  return { tool: "marina_command", arguments: { command: row.summary } };
}

const context = (row: ChallengeOutcomeRow) => ({
  goal: "",
  role: "",
  sources: [] as string[],
  // The reason it was held is the only context an approver was guaranteed.
  ...(row.reason ? { goal: `held: ${row.reason}` } : {}),
});

/** People-answered outcomes as gate cases (judge answers and expiries are not labels). */
export function liveGateCases(rows: ChallengeOutcomeRow[]): ChallengeGateCase[] {
  return rows
    .filter((r) => r.answer !== "expired" && r.answered_role !== "judge")
    .map((r) => {
      const a = action(r);
      return {
        id: `challenge:${r.token}`,
        ...(a.tool === "marina_command"
          ? { command: String(a.arguments.command) }
          : { tool: a.tool, arguments: a.arguments }),
        intent: context(r),
        expect: r.answer === "deny" ? "hold" : "allow",
        family: "challenge-live",
        labeledBy: "challenge",
        answeredRole: r.answered_role,
        class: r.class,
      };
    });
}

/** Every held action (answered or not by people), unlabeled, for a blind panel. */
export function blindPanelCases(rows: ChallengeOutcomeRow[]): BlindPanelCase[] {
  const seen = new Set<string>();
  const out: BlindPanelCase[] = [];
  for (const r of rows) {
    const a = action(r);
    const key = `${a.tool}\u0000${JSON.stringify(a.arguments)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `challenge:${r.token}`,
      pool: "marina",
      tool: a.tool,
      arguments: a.arguments,
      context: context(r),
      labels: {},
    });
  }
  return out;
}
