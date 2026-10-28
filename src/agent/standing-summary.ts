// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standing as an agent sees it: the notice when a credit lands, the one-line
 * summary its loop shows (LIVE standing, recent live credits, retired credit
 * labelled apart), and the line naming the live ways to earn. Every number
 * and kind is read from the ledger and the credit table (`standing.ts`), so
 * the text follows the rules instead of restating them.
 */
import type { MarinaDB } from "../persistence/database";
import { deriveRankFromStanding, RANK_THRESHOLDS } from "./rank-progression";
import {
  accountKey,
  FORECAST_DAILY_CAP,
  liveStandingKinds,
  RETIRED_STANDING_KINDS,
  retiredStandingMode,
  retiredStandingOf,
  STANDING_AMOUNTS,
  type StandingKind,
  standingOf,
  TASK_STANDING_MAX,
} from "./standing";

/**
 * How each kind is earned, for the earn line. `null`: not a way to earn (a
 * debit, or a retired kind). Typed over every kind, so a new kind needs an
 * entry; whether it shows is decided by `liveStandingKinds()`.
 */
const HOW_EARNED: Record<StandingKind, (() => string) | null> = {
  task_complete: () => `task you claimed, approved by another account (≤${TASK_STANDING_MAX})`,
  code_verified: () =>
    `Code Mode attempt whose checks passed, review approved (${STANDING_AMOUNTS.code_verified})`,
  forecast_resolved: () =>
    `filed forecast an outside source resolves (≤${STANDING_AMOUNTS.forecast_resolved}, ${FORECAST_DAILY_CAP}/day)`,
  experiment_complete: () =>
    `experiment another party replicated (${STANDING_AMOUNTS.experiment_complete})`,
  assistance_adopted: () =>
    `assistance answer its requester adopts (${STANDING_AMOUNTS.assistance_adopted})`,
  assistance_abstained_confirmed: () =>
    `honest abstention the requester confirms (${STANDING_AMOUNTS.assistance_abstained_confirmed})`,
  quest_complete: () => `onboarding quest (${STANDING_AMOUNTS.quest_complete})`,
  assistance_superseded: null,
  crew_member_stalled: null,
  pool_note: null,
  reflection_recalled: null,
  chronicled: null,
  crew_complete_member: null,
  crew_complete_lead: null,
  crew_stage_completed: null,
  crew_artifact_deposited: null,
  helping_act: null,
};

/** The live kinds that pay, in credit-table order. */
export function earningKinds(): StandingKind[] {
  return liveStandingKinds().filter((kind) => HOW_EARNED[kind] !== null);
}

/** One line naming the live ways to earn standing (`task list` finds tasks). */
export function standingEarnLine(): string {
  return `earn standing: ${earningKinds()
    .map((kind) => HOW_EARNED[kind]!())
    .join(" · ")}`;
}

/** A ledger ref as an agent can address it (`task_complete` stores the bare task id). */
export function creditRef(kind: string, ref: string): string {
  return kind === "task_complete" && /^\d+$/.test(ref) ? `task:#${ref}` : ref;
}

/** Where `standing` sits on the derived rank ladder: `rank 0 by standing; rank 1 at 5`. */
export function rankStep(standing: number): string {
  const rank = deriveRankFromStanding(standing);
  const next = RANK_THRESHOLDS.find((t) => t.rank === rank + 1);
  return next
    ? `rank ${rank} by standing; rank ${next.rank} at ${next.min}`
    : `rank ${rank} by standing; top derived rank`;
}

function signed(amount: number): string {
  return `${amount >= 0 ? "+" : ""}${amount.toFixed(2)}`;
}

function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * The notice an earner gets when a credit lands:
 * `standing +1.00 task_complete task:#12 → 3.40 (rank 0 by standing; rank 1 at 5)`.
 */
export function standingCreditNotice(
  db: MarinaDB,
  credit: { entityName: string; entityId?: string; kind: string; ref: string; amount: number },
  now = Date.now(),
): string {
  const total = standingOf(db, credit.entityName, credit.entityId, now);
  return `standing ${signed(credit.amount)} ${credit.kind} ${creditRef(credit.kind, credit.ref)} → ${total.toFixed(2)} (${rankStep(total)})`;
}

/**
 * One line for an agent's own loop: live standing and its rank step, the last
 * `recent` live credits (kind, ref, age), and retired credit labelled as
 * history. Retired rows never appear among the recent credits.
 */
export function standingSummaryLine(
  db: MarinaDB,
  name: string,
  entityId?: string,
  opts: { recent?: number; now?: number; label?: string } = {},
): string {
  const now = opts.now ?? Date.now();
  const live = standingOf(db, name, entityId, now);
  const key = accountKey(db, name, entityId);
  const excluded = retiredStandingMode() === "exclude";
  const parts = [
    `${opts.label ?? "standing"} ${live.toFixed(2)}${excluded ? " live" : ""} (${rankStep(live)})`,
  ];
  if (key) {
    const rows = db.ledgerForEntity(key, opts.recent ?? 3, {
      exclude: [...RETIRED_STANDING_KINDS],
    });
    parts.push(
      rows.length
        ? `last: ${rows
            .map(
              (r) =>
                `${signed(r.amount)} ${r.kind} ${creditRef(r.kind, r.ref)} ${age(now - r.earned_at)}`,
            )
            .join(", ")}`
        : "last: none yet",
    );
    const retired = retiredStandingOf(db, key, now);
    if (retired >= 0.05)
      parts.push(
        excluded
          ? `retired ${retired.toFixed(1)} (history, not counted)`
          : `includes retired ${retired.toFixed(1)} (fading out)`,
      );
  }
  return parts.join(" · ");
}
