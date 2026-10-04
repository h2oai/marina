// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where FutureX work lands in Marina's own records:
 *
 *   a submission  → `external_submissions` (migration 152): batch sha, variant,
 *                   identity, file hash, counts, cost — append-only, one row per file;
 *   a scored run  → the benchmark ledger (`benchmark_runs` + `benchmark_items`),
 *                   like every other benchmark, so `benchmark compare / frontier /
 *                   leaderboard / participants` rank it with everything else.
 *
 * Item ids only — never question or answer text.
 */

import { randomUUID } from "node:crypto";
import {
  answerDigest,
  type HarnessResultFile,
  ledgerFromHarnessResult,
} from "../../src/engine/benchmark-ledger";
import type { MarinaStores } from "../../src/persistence/interfaces";
import type { BatchRun, Variant } from "./run";
import type { BatchScore } from "./score";
import type { Identity } from "./submission";

export const ONLINE_BENCHMARK = "futurex-online";
export const PAST_BENCHMARK = "futurex-past";

type Ledger = Pick<MarinaStores, "recordBenchmarkLedgerRun" | "recordExternalSubmission">;

export function recordSubmission(
  db: Ledger,
  input: {
    batchSha: string;
    variant: Variant;
    identity: Identity;
    fileName: string;
    fileSha256: string;
    run: BatchRun;
    now?: number;
  },
): { id: number; created: boolean } {
  const { run } = input;
  return db.recordExternalSubmission({
    benchmark: ONLINE_BENCHMARK,
    batch_ref: input.batchSha,
    variant: input.variant.label,
    identity_json: JSON.stringify(input.identity),
    file_name: input.fileName,
    file_sha256: input.fileSha256,
    items: run.results.length,
    answered: run.results.filter((r) => !r.fallback && r.prediction !== "").length,
    cost_usd: run.costUsd,
    meta_json: JSON.stringify({
      variant: input.variant,
      fallback: run.results.filter((r) => r.fallback).length,
      late: run.results.filter((r) => r.late).length,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    }),
    created_at: input.now ?? Date.now(),
  });
}

/** A scored run (backtest, or a live batch once resolved) into the benchmark ledger. */
export function recordScoredRun(
  db: Ledger,
  input: {
    benchmark: string;
    batchSha: string;
    variant: Variant;
    run: BatchRun;
    score: BatchScore;
    horizonDays?: number;
    /** Replicate group: runs of the same configuration pool in `benchmark compare`. */
    replicateGroup?: string;
    /** More run facts for the config and target (isolation, lessons, replicate number). */
    extra?: Record<string, unknown>;
    now?: number;
  },
): { id: string; created: boolean; benchmark: string; invalidReason?: string } {
  const { run, score } = input;
  const byId = new Map(run.results.map((r) => [r.id, r]));
  const file: HarnessResultFile = {
    config: {
      dataset: input.benchmark,
      name: input.benchmark,
      model: input.variant.model,
      batchSha: input.batchSha,
      variant: input.variant.label,
      ...(input.horizonDays !== undefined ? { horizonDays: input.horizonDays } : {}),
      overall: score.overall,
      byLevel: score.byLevel,
      ...(input.extra ?? {}),
    },
    timestamp: Date.parse(run.finishedAt),
    duration_ms: Date.parse(run.finishedAt) - Date.parse(run.startedAt),
    metadata: { usage: { costUsd: run.costUsd } },
    items: score.items.map((it) => {
      const r = byId.get(it.id);
      return {
        id: it.id,
        // An item counts as correct when it earned at least half credit.
        correct: it.score >= 0.5,
        score: it.score,
        ...(r ? { latencyMs: r.latencyMs, usage: { costUsd: r.costUsd } } : {}),
        // A row with no usable answer was filled by a fallback: past
        // MARINA_BENCHMARK_MAX_FALLBACK_RATE the run is recorded invalid.
        ...(r?.fallback ? { fallback: true } : {}),
        // The answer's digest only (stored keyed per ledger): plurality and
        // selectors across replicates can be measured without the text.
        ...(r && !r.fallback && answerDigest(r.prediction)
          ? { answerDigest: answerDigest(r.prediction) }
          : {}),
        judge: it.metric,
      };
    }),
  };
  const raw = JSON.stringify(file);
  const now = input.now ?? Date.now();
  const built = ledgerFromHarnessResult(file, {
    targetKind: "population",
    target: {
      variant: input.variant.label,
      analysts: input.variant.analysts,
      planner: input.variant.planner,
      critic: input.variant.critic,
      ...(input.variant.verifier ? { verifier: input.variant.verifier } : {}),
      ...(input.variant.verify ? { verify: true } : {}),
      runs: input.variant.runs,
      researchRounds: input.variant.researchRounds,
      critique: input.variant.critique ?? true,
      ...(input.extra?.isolation ? { isolation: input.extra.isolation } : {}),
      ...(input.extra?.lessons ? { lessons: input.extra.lessons } : {}),
    },
    ...(input.replicateGroup ? { replicateGroup: input.replicateGroup } : {}),
    label: `${input.variant.label} ${input.batchSha.slice(0, 8)}${input.extra?.replicate ? ` r${input.extra.replicate}` : ""}`,
    judge: "local mechanical scorer (published metric definitions)",
    raw,
    id: `bench_${randomUUID().slice(0, 13)}`,
    now,
  });
  const r = db.recordBenchmarkLedgerRun(built.run, built.items);
  return {
    ...r,
    benchmark: input.benchmark,
    ...(built.run.invalid_reason ? { invalidReason: built.run.invalid_reason } : {}),
  };
}
