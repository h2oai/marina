// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where scored DeepResearch Bench runs land in Marina's own records:
 *
 *   - the benchmark ledger (`benchmark_runs` + `benchmark_items`): one run per
 *     (label, board), item ids and scores only — never prompt or report text;
 *     an item counts `correct` when it reaches half credit (DRB I: the report
 *     beats the reference article; DRB II: half the rubrics pass), its graded
 *     score rides alongside;
 *   - the lesson loop (`src/learning`): one general outcome per scored report
 *     in the `research` domain — language, topic area, the board's dimension
 *     scores, citation and evidence numbers — judged before it is served; the
 *     prompt text travels only as private context for the leak check.
 */

import { randomUUID } from "node:crypto";
import { type HarnessResultFile, ledgerFromHarnessResult } from "../../src/engine/benchmark-ledger";
import type { Outcome } from "../../src/learning/outcomes";
import type { MarinaStores } from "../../src/persistence/interfaces";
import { BOARDS, type Board } from "./dataset";
import type { TaskScore } from "./official";
import type { TaskRecord } from "./run";

type Ledger = Pick<MarinaStores, "recordBenchmarkLedgerRun">;

export function meanScore(scores: readonly TaskScore[]): number | undefined {
  return scores.length ? scores.reduce((s, x) => s + x.score, 0) / scores.length : undefined;
}

/** File one scored run into the benchmark ledger. */
export function recordScoredRun(
  db: Ledger,
  input: {
    board: Board;
    label: string;
    records: TaskRecord[];
    scores: TaskScore[];
    judge: string;
    judgeUsd: number;
    replicateGroup?: string;
    extra?: Record<string, unknown>;
    now?: number;
  },
): { id: string; created: boolean } {
  const byId = new Map(input.records.map((r) => [r.id, r]));
  const first = input.records[0];
  const started = Math.min(...input.records.map((r) => Date.parse(r.startedAt)));
  const finished = Math.max(...input.records.map((r) => Date.parse(r.finishedAt)));
  const target = {
    pipeline: "research-report",
    lead: first?.lead,
    ...(first?.checker ? { checker: first.checker } : {}),
  };
  const file: HarnessResultFile = {
    config: {
      dataset: BOARDS[input.board].ledger,
      name: BOARDS[input.board].ledger,
      model: first?.lead,
      label: input.label,
      commit: BOARDS[input.board].commit,
      overall: meanScore(input.scores),
      judgeUsd: input.judgeUsd,
      ...(input.extra ?? {}),
    },
    timestamp: Number.isFinite(finished) ? finished : Date.now(),
    duration_ms: Number.isFinite(finished - started) ? finished - started : 0,
    metadata: {
      usage: { costUsd: input.records.reduce((s, r) => s + r.cost.totalUsd, 0) },
    },
    items: input.scores.map((s) => {
      const r = byId.get(s.id);
      return {
        id: s.id,
        correct: s.score >= 0.5,
        score: s.score,
        ...(r ? { latencyMs: r.latencyMs, usage: { costUsd: r.cost.totalUsd } } : {}),
        judge: "official",
      };
    }),
  };
  const now = input.now ?? Date.now();
  const built = ledgerFromHarnessResult(file, {
    targetKind: "population",
    target,
    ...(input.replicateGroup ? { replicateGroup: input.replicateGroup } : {}),
    label: `${input.label} (${BOARDS[input.board].name})`,
    judge: input.judge,
    raw: JSON.stringify(file),
    id: `bench_${randomUUID().slice(0, 13)}`,
    now,
  });
  return db.recordBenchmarkLedgerRun(built.run, built.items);
}

function pct(x: number | null | undefined): string {
  return typeof x === "number" ? `${(x * 100).toFixed(0)}%` : "-";
}

/**
 * The general outcome of one scored report. No prompt, report or rubric text:
 * the topic area and language, the dimension scores, the evidence and
 * citation numbers, the configuration.
 */
export function reportOutcome(input: {
  board: Board;
  record: TaskRecord;
  score: TaskScore;
  topic?: string;
  prompt: string;
  resolvedAt: string;
  refs?: string[];
}): Outcome {
  const { record: r, score: s, board } = input;
  const rep = r.report;
  const dims = Object.entries(s.dims)
    .filter(([k]) => k !== "total")
    .map(([k, v]) => `${k} ${pct(v)}`)
    .join(", ");
  const weakest = Object.entries(s.dims)
    .filter(([k, v]) => typeof v === "number" && k !== "total" && k !== "blocked_rate")
    .sort((a, b) => (a[1] as number) - (b[1] as number))[0]?.[0];
  return {
    domain: "research",
    source: `deepresearch:${board}`,
    // DRB I: beat the expert reference; DRB II: pass at least half the rubrics.
    succeeded: s.score >= 0.5,
    score: s.score,
    resolvedAt: input.resolvedAt,
    attempted: `long-form cited research report (${r.language}${input.topic ? `, ${input.topic}` : ""}); ${BOARDS[board].name}; lead ${r.lead}${r.checker ? ` + checker ${r.checker}` : ""}`,
    detail: `${board === "drb1" ? "RACE vs reference" : "rubric pass rate"} ${pct(s.score)}${weakest ? `; weakest ${weakest}` : ""}`,
    signals: [
      dims,
      ...(rep
        ? [
            `sections ${rep.plan.sections.length}`,
            `sources cited ${rep.sources.length}`,
            `evidence passages ${rep.evidence.length}`,
            `figure precision ${pct(rep.citations.figurePrecision)}`,
            `uncited figure sentences ${rep.citations.uncitedFigures}`,
            `report chars ${rep.markdown.length}`,
          ]
        : []),
      ...(r.factPass ? [`fact pass ${r.factPass.applied}/${r.factPass.proposed} edits`] : []),
    ],
    refs: [`deepresearch:${board}:${r.id}`, ...(input.refs ?? [])],
    privateContext: input.prompt,
  };
}
