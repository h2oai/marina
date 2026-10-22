// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Civic rule changes, recorded in the chronicle.
 *
 * A change to who earns standing (or how) is civic history: each one is ONE
 * immutable chronicle `event`, written the first time a world boots on code
 * that carries it. The chronicle itself is the durable marker — an entry is
 * written only when no `event` from source `civic-rule` already carries the
 * rule's ref — so restarts, upgrades and re-seeds never repeat it, and a
 * world that starts fresh on this code records the rule it began under.
 */

import type { MarinaDB } from "../persistence/database";

/** Chronicle source for civic rule changes. */
export const CIVIC_RULE_SOURCE = "civic-rule";

export interface CivicRuleChange {
  /** Stable ref, e.g. `civic-rule:contributors-earn-standing`. */
  ref: string;
  /** When the rule was decided (YYYY-MM-DD). */
  decided: string;
  title: string;
  body: string;
}

export const CIVIC_RULE_CHANGES: readonly CivicRuleChange[] = [
  {
    ref: "civic-rule:contributors-earn-standing",
    decided: "2026-10-20",
    title: "Civic rule: contributors earn standing — every account is its own party",
    body:
      "For standing, each account is its own party. Work another account verified credits the " +
      "worker: a person approving its own agent's work, another person's agent, or a sibling " +
      "agent whose verdict is grounded (checks that ran and passed). Self-verification, by name " +
      "or by durable account, is still refused; an agent's ungrounded verdict inside its own " +
      "spawn lineage still pays nothing; caps are unchanged. Safety gates are unchanged: only a " +
      "person's approval from outside the requester's lineage demonstrates an earnable gate, so " +
      "one person's agents can raise each other's standing to a gate's floor but never make it solo.",
  },
];

/**
 * Write every civic rule change the chronicle does not hold yet. Returns the
 * refs written (empty on every boot after the first). Idempotent.
 */
export function chronicleCivicRuleChanges(
  db: Pick<MarinaDB, "appendChronicle" | "queryChronicle">,
  changes: readonly CivicRuleChange[] = CIVIC_RULE_CHANGES,
): string[] {
  const recorded = new Set(
    db
      .queryChronicle({ kind: "event", source: CIVIC_RULE_SOURCE, limit: 200 })
      .flatMap((entry) => entry.refs),
  );
  const written: string[] = [];
  for (const change of changes) {
    if (recorded.has(change.ref)) continue;
    db.appendChronicle({
      kind: "event",
      source: CIVIC_RULE_SOURCE,
      title: change.title,
      body: change.body,
      refs: [change.ref, `decided:${change.decided}`],
    });
    written.push(change.ref);
  }
  return written;
}
