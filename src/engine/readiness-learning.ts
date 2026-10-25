// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Readiness lines for two things a world can carry silently:
 *
 *   learning-loop   whether outcomes are reaching the consumers that learn
 *                   from them, how far the judges are from earning, and
 *                   whether any default has ever moved by earned promotion.
 *                   A backlog or a loop that never changed anything is shown,
 *                   not hidden behind an `off` default.
 *   gate-sentinels  operator-grant sentinel rows (`GRANTED_DEMONSTRATIONS`,
 *                   999) held by AGENT accounts: each one bypasses the gate it
 *                   names, so any is critical (`gate audit` lists them).
 *
 *   capability-posture  techniques shipped off or observe-only, each with a
 *                   decide-by date (`src/config/capability-posture.ts`):
 *                   degraded while any date has passed undecided.
 *
 * All are read-only and bounded; none calls a model.
 */

import { availableModels } from "../agent/available-models";
import { daysUntil, overduePosture, postureEntries } from "../config/capability-posture";
import { judgeStandings } from "../decisions/judges";
import { lessonsMode } from "../learning/modes";
import { lessonsFromWorkMode } from "../learning/work";
import { EARNED_MIN_COMPARED } from "../outcomes/agreement";
import { QUALITY_GRACE_MS } from "../outcomes/judge-quality";
import { judgeableEnd, judgeResolutionMode } from "../outcomes/judge-resolution";
import type { MarinaDB } from "../persistence/database";
import { auditGateGrants } from "./gate-audit";
import type { ReadinessCheck } from "./readiness";

/** An outcome waiting longer than this marks the loop degraded. */
export const LEARNING_LOOP_STALE_MS = 14 * 86_400_000;
/** Rows read per question (readiness is polled; counts above this read as "≥"). */
const SCAN = 1_000;

const DAY = 86_400_000;
const age = (ms: number) =>
  ms >= DAY ? `${Math.floor(ms / DAY)}d` : `${Math.floor(ms / 3_600_000)}h`;

export interface LearningLoopState {
  outcomes: boolean;
  undelivered: number;
  oldestUndeliveredAt?: number;
  unjudged: number;
  oldestUnjudgedAt?: number;
  /** The judge closest to earning on the outcome path. */
  bestJudge?: { judge: string; compared: number; earned: boolean };
  earnedJudges: number;
  /** Task-verifier opinions on record (`judge_observations`). */
  verifierOpinions: number;
  /** `promoted` rows in the benchmark promotion history. */
  promotions: number;
}

/** What the learning loop has waiting and what it has ever changed. Read-only. */
export function learningLoopState(db: MarinaDB, now = Date.now()): LearningLoopState {
  const state: LearningLoopState = {
    outcomes: db.listOutcomes({ limit: 1 }).length > 0,
    undelivered: 0,
    unjudged: 0,
    earnedJudges: 0,
    verifierOpinions: 0,
    promotions: 0,
  };
  const oldest = (a: number | undefined, b: number | undefined) =>
    a === undefined ? b : b === undefined ? a : Math.min(a, b);

  for (const c of db.outcomeDeliveryCounts()) if (c.state === "pending") state.undelivered += c.n;
  for (const consumer of ["lessons", "history"]) {
    // Oldest first (by outcome id); the row's creation time is when it waited from.
    const row = db.pendingOutcomes(consumer, 1)[0];
    if (row) state.oldestUndeliveredAt = oldest(state.oldestUndeliveredAt, row.created_at);
  }

  // Unjudged: task submissions their creator never decided, past the grace a
  // judge waits; saved answers past their end that nothing mechanical settles.
  const waiting = db.waitingSubmissions(now - QUALITY_GRACE_MS, SCAN);
  state.unjudged += waiting.length;
  if (waiting[0]?.submitted_at) state.oldestUnjudgedAt = waiting[0].submitted_at;
  for (const row of db.openUnlinkedForecasts(SCAN)) {
    const end = judgeableEnd(row, now);
    if (end === undefined) continue;
    state.unjudged++;
    state.oldestUnjudgedAt = oldest(state.oldestUnjudgedAt, end);
  }

  // Every judge surface, from the one ledger (`judge stats` reads the same).
  for (const j of judgeStandings(db)) {
    if (j.surface === "verify") state.verifierOpinions += j.opinions;
    if (j.earned) state.earnedJudges++;
    if (!state.bestJudge || j.compared > state.bestJudge.compared)
      state.bestJudge = {
        judge: `${j.surface}:${j.judge}`,
        compared: j.compared,
        earned: j.earned,
      };
  }
  for (const d of db.listBenchmarkDefaults())
    state.promotions += db
      .listBenchmarkPromotions(d.slot)
      .filter((p) => p.outcome === "promoted").length;
  return state;
}

/** The `learning-loop` readiness line. */
export function learningLoopCheck(
  db: MarinaDB | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): ReadinessCheck {
  const id = "learning-loop";
  const label = "Learning loop";
  if (!db)
    return { id, label, status: "off", optional: true, detail: "no database: nothing is recorded" };
  const s = learningLoopState(db, now);
  const modes = `lessons from work ${lessonsFromWorkMode(env)}, outcome judge ${judgeResolutionMode(env)}`;
  const oldestWait = Math.min(
    s.oldestUndeliveredAt ?? Number.POSITIVE_INFINITY,
    s.oldestUnjudgedAt ?? Number.POSITIVE_INFINITY,
  );
  const parts = [
    `undelivered ${s.undelivered}${s.oldestUndeliveredAt !== undefined ? ` (oldest ${age(now - s.oldestUndeliveredAt)})` : ""}`,
    `unjudged ${s.unjudged}${s.oldestUnjudgedAt !== undefined ? ` (oldest ${age(now - s.oldestUnjudgedAt)})` : ""}`,
    s.bestJudge
      ? `judges: ${s.earnedJudges} earned, closest ${s.bestJudge.judge} ${s.bestJudge.compared}/${EARNED_MIN_COMPARED} comparisons`
      : `judges: none has a comparison yet (0/${EARNED_MIN_COMPARED})`,
    `verifier opinions ${s.verifierOpinions}`,
    `promotions ever filed ${s.promotions}`,
    modes,
  ];
  const detail = parts.join(" · ");
  if (lessonsMode(env) === "off")
    return {
      id,
      label,
      status: "off",
      optional: true,
      detail: `MARINA_LESSONS=off — outcomes teach nothing · ${detail}`,
      remediation: "Unset MARINA_LESSONS (default on) and restart.",
    };
  if (availableModels(env).length === 0)
    return {
      id,
      label,
      status: "off",
      optional: true,
      detail: `no model provider: outcomes are recorded but no lesson is written or judged · ${detail}`,
      remediation:
        "Configure a model provider; lessons from work and the outcome judge then default on.",
    };
  if (!s.outcomes && s.unjudged === 0)
    return { id, label, status: "ok", detail: `no outcome recorded yet · ${detail}` };
  const stale = Number.isFinite(oldestWait) && now - oldestWait > LEARNING_LOOP_STALE_MS;
  const neverChanged = s.outcomes && s.promotions === 0;
  if (!stale && !neverChanged) return { id, label, status: "ok", detail };
  const why = [
    ...(stale ? [`an outcome has waited over ${LEARNING_LOOP_STALE_MS / DAY} days`] : []),
    ...(neverChanged ? ["outcomes exist but no default has ever changed by promotion"] : []),
  ].join("; ");
  return {
    id,
    label,
    status: "degraded",
    detail: `${why} · ${detail}`,
    remediation: stale
      ? "`outcome` shows the backlog; check the `outcome-delivery` and `outcome-judge` jobs (`readiness` tick-jobs) and the daily spend cap."
      : "Defaults move only by an earned promotion: run a held-out comparison (`benchmark compare-run`, `benchmark promote`) or read `competence` for what the evidence already ranks.",
  };
}

/** The `gate-sentinels` readiness line: critical while any agent holds a sentinel grant. */
export function gateSentinelsCheck(db: MarinaDB | undefined): ReadinessCheck {
  const id = "gate-sentinels";
  const label = "Gate sentinels";
  if (!db) return { id, label, status: "ok", detail: "no database" };
  const audit = auditGateGrants(db);
  const agents = audit.holders.filter((h) => h.kind === "agent");
  if (agents.length === 0)
    return {
      id,
      label,
      status: "ok",
      detail: `no agent account holds an operator-grant sentinel (${audit.totalRows} operator grant row(s) held by people)`,
    };
  const names = agents
    .slice(0, 5)
    .map((h) => `${h.name} (${h.gates.length})`)
    .join(", ");
  return {
    id,
    label,
    status: "off",
    critical: true,
    detail: `CRITICAL: ${audit.agentRows} sentinel (999) gate row(s) held by ${agents.length} agent account(s) — ${names}${agents.length > 5 ? ", …" : ""}; each bypasses the gate it names (\`gate audit\`)`,
    remediation:
      "As an operator in an interactive person session (`marina connect` on a terminal, or the dashboard): `gate reset agents all` to review, then `gate reset agents all apply`. A one-shot `marina connect -c` counts as an agent and is refused.",
  };
}

/**
 * The `capability-posture` readiness line: degraded while any decide-by date
 * has passed. Always optional: the dates are Marina's own development
 * deadlines, so an install on an older release is never degraded (no ops
 * alert, no header warning) because a date went by.
 */
export function capabilityPostureCheck(now = Date.now()): ReadinessCheck {
  const id = "capability-posture";
  const label = "Capability posture";
  const entries = postureEntries();
  const waiting = entries.filter((e) => e.posture.class === "measure").length;
  const overdue = overduePosture(now, entries);
  const oldest = overdue[0];
  if (oldest?.posture.class !== "measure")
    return {
      id,
      label,
      status: "ok",
      optional: true,
      detail: `${waiting} technique(s) waiting on evidence, none past its decide-by date (\`posture\`)`,
    };
  return {
    id,
    label,
    status: "degraded",
    optional: true,
    detail: `development deadlines; informational on installs · ${overdue.length} of ${waiting} technique(s) past their decide-by date; oldest ${oldest.subject} (due ${oldest.posture.decideBy}, ${-daysUntil(oldest.posture.decideBy, now)}d ago)`,
    remediation:
      "`posture due` lists them with their evidence: promote what won, or record a new date or a by-design reason in src/config/capability-posture.ts.",
  };
}
