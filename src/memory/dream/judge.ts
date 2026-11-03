// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Learn from last night: the dreamer is a judge, and the owner's later acts
 * are its ground truth. Every op an APPLIED dream carried is one opinion in
 * the one judge ledger (surface `dream`, question = the op kind, judge
 * `dream:<model>`, subject `dream:<id>:<n>`), settled mechanically:
 *
 *   - an adopted proposal           → pass (the owner agreed: a restatement, a skill draft)
 *   - a dismissed proposal          → fail (the owner disagreed)
 *   - a rolled-back dream           → fail for every op it applied
 *   - an applied op left standing   → pass after DREAM_SETTLE_MS (the owner
 *                                     kept it; the hourly job settles it)
 *   - a stale restatement           → no truth (its sources moved on)
 *
 * `judgeEarned("dream", …, { question: "supersede" })` is then the ONE rule
 * (≥ 25 comparisons, Wilson lower bound ≥ 0.85) under which — with
 * `MARINA_DREAM_JUDGE=on` — a dream applies a restatement at once instead of
 * filing it, still with a footprint and `memory dream rollback`.
 */

import {
  judgeEarned,
  judgeModeFor,
  recordJudgeOpinion,
  settleJudgedTruth,
} from "../../decisions/judges";
import type { MarinaDB } from "../../persistence/database";
import type { StoredDreamOp } from "./types";

export const DREAM_JUDGE_SURFACE = "dream";
/** An applied op nobody rolled back for this long is a pass. */
export const DREAM_SETTLE_MS = 7 * 24 * 60 * 60 * 1000;
/** Dreams settled per hourly job, at most. */
export const DREAM_SETTLE_BATCH = 50;

export const dreamJudgeName = (model: string | null | undefined) => `dream:${model ?? "unknown"}`;
export const dreamOpSubject = (dreamId: number, n: number) => `dream:${dreamId}:${n}`;

/** One opinion per op the dream carried (applied or proposed). Observe-mode dreams record nothing: nothing can settle them. */
export function recordDreamOpinions(
  db: MarinaDB,
  dreamId: number,
  model: string | null | undefined,
  ops: readonly StoredDreamOp[],
  at: number,
): number {
  let n = 0;
  ops.forEach((op, i) => {
    const proposed = (op.op === "supersede" || op.op === "propose-skill") && op.proposal;
    if (!op.applied && !proposed) return;
    recordJudgeOpinion(db, {
      surface: DREAM_JUDGE_SURFACE,
      question: op.op,
      judge: dreamJudgeName(model),
      subject: dreamOpSubject(dreamId, i),
      truthKey: dreamOpSubject(dreamId, i),
      opinion: "pass",
      opinedAt: at,
    });
    n++;
  });
  return n;
}

/** The owner's act (or its absence) settles one op's opinion. Idempotent. */
export function settleDreamOp(
  db: MarinaDB,
  dreamId: number,
  n: number,
  succeeded: boolean,
  at = Date.now(),
): void {
  settleJudgedTruth(db, { subject: dreamOpSubject(dreamId, n), succeeded, resolvedAt: at });
}

/** Every applied op of a rolled-back dream is a fail; pending proposals carry no truth. */
export function settleRolledBack(
  db: MarinaDB,
  dreamId: number,
  ops: readonly StoredDreamOp[],
  at = Date.now(),
): void {
  ops.forEach((op, i) => {
    if (op.applied) settleDreamOp(db, dreamId, i, false, at);
  });
}

/**
 * Applied dreams older than DREAM_SETTLE_MS that nobody rolled back: every
 * applied op is a pass. Reads the ledger's open `dream:` opinions, so a
 * settled dream costs nothing next time.
 */
export function settleQuietDreams(db: MarinaDB, now = Date.now()): number {
  const open = db
    .listJudgeLedger({ surface: DREAM_JUDGE_SURFACE, limit: 2000 })
    .filter((row) => row.truth === null);
  const byDream = new Map<number, number[]>();
  for (const row of open) {
    const m = /^dream:(\d+):(\d+)$/.exec(row.subject);
    if (!m) continue;
    const id = Number(m[1]);
    byDream.set(id, [...(byDream.get(id) ?? []), Number(m[2])]);
  }
  let settled = 0;
  let dreams = 0;
  for (const [id, ns] of byDream) {
    if (dreams >= DREAM_SETTLE_BATCH) break;
    const row = db.getDream(id);
    if (row?.state !== "applied" || !row.applied_at) continue;
    if (now - row.applied_at < DREAM_SETTLE_MS) continue;
    const ops = JSON.parse(row.ops_json) as StoredDreamOp[];
    for (const n of ns) {
      const op = ops[n];
      if (!op?.applied) continue; // a proposal still pending settles by the owner's act alone
      settleDreamOp(db, id, n, true, now);
      settled++;
    }
    dreams++;
  }
  return settled;
}

/** Whether this installation lets an earned dreamer apply `opKind` at once. */
export function dreamJudgeApplies(
  db: MarinaDB,
  model: string | null | undefined,
  opKind: StoredDreamOp["op"],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (judgeModeFor("dream", env).mode !== "on") return false;
  return judgeEarned(db, DREAM_JUDGE_SURFACE, dreamJudgeName(model), { question: opKind, env });
}
