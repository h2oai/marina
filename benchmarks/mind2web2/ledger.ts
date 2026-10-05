// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where judged Mind2Web 2 answers land in Marina's own records:
 *
 *   the benchmark ledger  one run per (arm, split): items `<task>#<k>` with the
 *                         root score, `correct` = a perfect root score (the
 *                         board's success), cost and latency — ids and verdicts
 *                         only, never task or answer text;
 *   judged lessons        one general outcome per answer (`noteOutcome`, domain
 *                         `benchmark`): what kind of work it was, the score, the
 *                         citation-audit facts; the task and the answer travel
 *                         only as private context for the leak check.
 */

import { randomUUID } from "node:crypto";
import {
  answerDigest,
  type HarnessResultFile,
  ledgerFromHarnessResult,
} from "../../src/engine/benchmark-ledger";
import type { Outcome } from "../../src/learning/outcomes";
import type { MarinaStores } from "../../src/persistence/interfaces";
import type { Arm, RunRecord } from "./run";
import type { AnswerScore } from "./score";

export const BENCHMARK = "mind2web2";
export const JUDGE_LABEL = "official Mind2Web 2 agent-as-a-judge (o4-mini), run locally";

type Ledger = Pick<MarinaStores, "recordBenchmarkLedgerRun">;

export function itemId(task: string, k: number): string {
  return `${task}#${k}`;
}

/** One ledger run for an arm's judged answers on one split. */
export function recordJudgedRun(
  db: Ledger,
  input: {
    arm: Arm;
    split: string;
    scores: readonly AnswerScore[];
    records: readonly RunRecord[];
    answers?: ReadonlyMap<string, string>;
    judgeUsd?: number;
    replicateGroup?: string;
    now?: number;
  },
): { id: string; created: boolean } {
  const byItem = new Map(input.records.map((r) => [itemId(r.task, r.k), r]));
  const started = Math.min(
    ...input.records.map((r) => Date.parse(r.startedAt)).filter(Number.isFinite),
  );
  const now = input.now ?? Date.now();
  const generationUsd = input.records.reduce((s, r) => s + r.costUsd, 0);
  const file: HarnessResultFile = {
    config: {
      dataset: BENCHMARK,
      name: BENCHMARK,
      model: input.arm.lead,
      split: input.split,
      agent: input.arm.agent,
      formation: input.arm.formation.kind,
      ...(input.arm.researcher ? { researcher: input.arm.researcher } : {}),
      ...(input.arm.verifier ? { verifier: input.arm.verifier } : {}),
      maxTurns: input.arm.maxTurns,
      judge: { model: "o4-mini" },
      ...(input.judgeUsd !== undefined ? { judgeUsd: input.judgeUsd } : {}),
    },
    timestamp: now,
    ...(Number.isFinite(started) ? { duration_ms: now - started } : {}),
    metadata: { usage: { costUsd: generationUsd } },
    items: input.scores.map((s) => {
      const id = itemId(s.task, s.k);
      const r = byItem.get(id);
      const text = input.answers?.get(id);
      return {
        id,
        correct: s.score >= 1 - 1e-9,
        score: s.score,
        ...(r ? { latencyMs: r.seconds * 1000, usage: { costUsd: r.costUsd } } : {}),
        ...(s.source === "failed-run" ? { fallback: true } : {}),
        ...(text && answerDigest(text) ? { answerDigest: answerDigest(text) } : {}),
        ...(r?.budgetForced !== undefined ? { budgetForced: r.budgetForced } : {}),
        judge: s.source === "judge" ? `root ${s.score.toFixed(3)}` : "no answer",
      };
    }),
  };
  const built = ledgerFromHarnessResult(file, {
    targetKind: "population",
    target: {
      agent: input.arm.agent,
      formation: input.arm.formation,
      lead: input.arm.lead,
      ...(input.arm.researcher ? { researcher: input.arm.researcher } : {}),
      ...(input.arm.verifier ? { verifier: input.arm.verifier } : {}),
    },
    ...(input.replicateGroup ? { replicateGroup: input.replicateGroup } : {}),
    label: `${input.arm.agent} ${input.split}`,
    judge: JUDGE_LABEL,
    raw: JSON.stringify(file),
    id: `bench_${randomUUID().slice(0, 13)}`,
    now,
  });
  return db.recordBenchmarkLedgerRun(built.run, built.items);
}

/** The general outcome of one judged answer (no task or answer text is stored). */
export function answerOutcome(input: {
  arm: Arm;
  score: AnswerScore;
  record?: RunRecord;
  resolvedAt: string;
  ledgerRunId?: string;
  privateContext?: string;
}): Outcome {
  const { arm, score: s, record: r } = input;
  const audit = r?.audit;
  const signals = [
    `formation:${arm.formation.kind}`,
    `lead:${arm.lead}`,
    ...(arm.verifier ? [`verifier:${arm.verifier}`] : []),
    ...(r?.budgetForced ? ["budget-forced"] : []),
    ...(r?.repaired ? ["citation-repair"] : []),
    ...(audit
      ? [`cited:${audit.cited}`, `cited-unread:${audit.unread}`, `cited-failed:${audit.failed}`]
      : []),
    ...(r?.reads !== undefined ? [`reads:${r.reads}`, `read-failures:${r.readFailures ?? 0}`] : []),
  ];
  return {
    domain: "benchmark",
    source: `benchmark:${BENCHMARK}`,
    succeeded: s.score >= 1 - 1e-9,
    score: s.score,
    resolvedAt: input.resolvedAt,
    attempted: `answer a multi-part live-web research task with a cited markdown answer (${arm.formation.kind} formation)`,
    detail:
      s.source === "failed-run"
        ? `no answer (${r?.status ?? "failed"})`
        : `rubric root score ${s.score.toFixed(2)}; ${audit?.cited ?? "?"} URLs cited, ${audit?.unread ?? "?"} never opened`,
    signals,
    refs: [
      `bench-item:${BENCHMARK}:${itemId(s.task, s.k)}`,
      ...(input.ledgerRunId ? [`bench:${input.ledgerRunId}`] : []),
    ],
    ...(input.privateContext ? { privateContext: input.privateContext } : {}),
  };
}
