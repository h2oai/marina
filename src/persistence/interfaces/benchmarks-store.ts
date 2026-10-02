// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  BenchmarkDefaultRow,
  BenchmarkItemInput,
  BenchmarkItemRow,
  BenchmarkLedgerRunInput,
  BenchmarkPromotionInput,
  BenchmarkPromotionRow,
  BenchmarkRunRow,
} from "../db-benchmarks";
import type { NoteLinkRow, NoteRow } from "../db-notes";
import type { ExactKeys } from "./exact-keys";

/** Benchmark runs (`db-benchmarks.ts`). */
export interface BenchmarksStore {
  insertBenchmarkRun(row: {
    id: string;
    benchmark: string;
    config_hash: string;
    config_json: string;
    status: string;
    agent_id?: string;
    started_at: number;
  }): void;
  completeBenchmarkRun(
    id: string,
    data: {
      score: number | null;
      breakdown_json: string | null;
      answered: number;
      total: number;
      status: string;
      completed_at: number;
      duration_ms: number;
    },
  ): void;
  getBenchmarkRun(id: string): BenchmarkRunRow | undefined;
  queryBenchmarkRuns(q: {
    benchmark?: string;
    status?: string;
    agentId?: string;
    limit?: number;
  }): BenchmarkRunRow[];
  leaderboardBenchmark(benchmark: string, limit?: number): BenchmarkRunRow[];
  /** Record a completed run + its item outcomes (idempotent on `content_hash`). */
  recordBenchmarkLedgerRun(
    run: BenchmarkLedgerRunInput,
    items: readonly BenchmarkItemInput[],
  ): { id: string; created: boolean };
  /** Put runs into one replicate group (migration 148); returns rows changed. */
  setBenchmarkReplicateGroup(runIds: readonly string[], group: string): number;
  getBenchmarkItems(runId: string): BenchmarkItemRow[];
  getBenchmarkItemsForBenchmark(benchmark: string, limit?: number): BenchmarkItemRow[];
  /** The slot's promoted default (migration 147), if one was ever seeded. */
  getBenchmarkDefault(slot: string): BenchmarkDefaultRow | undefined;
  listBenchmarkDefaults(): BenchmarkDefaultRow[];
  /** A slot's append-only promotion history, oldest first. */
  listBenchmarkPromotions(slot: string): BenchmarkPromotionRow[];
  /** Append a history row; `seeded`/`promoted` also moves the slot's incumbent. */
  recordBenchmarkPromotion(row: BenchmarkPromotionInput): number;
  traceNoteGraph(
    noteId: number,
    depth?: number,
    include?: (note: NoteRow) => boolean,
  ): { note: NoteRow; links: NoteLinkRow[]; depth: number }[];
  /** Count total note links for an entity's notes */
  countNoteLinks(entityName: string): number;
  /** Count links for a specific note */
  countLinksForNote(noteId: number): number;
}

/** Runtime mirror of `BenchmarksStore`'s method names — the drift test compares it to the facade. */
export const BENCHMARKS_STORE_METHODS = [
  "insertBenchmarkRun",
  "completeBenchmarkRun",
  "getBenchmarkRun",
  "queryBenchmarkRuns",
  "leaderboardBenchmark",
  "recordBenchmarkLedgerRun",
  "setBenchmarkReplicateGroup",
  "getBenchmarkItems",
  "getBenchmarkItemsForBenchmark",
  "getBenchmarkDefault",
  "listBenchmarkDefaults",
  "listBenchmarkPromotions",
  "recordBenchmarkPromotion",
  "traceNoteGraph",
  "countNoteLinks",
  "countLinksForNote",
] as const satisfies readonly (keyof BenchmarksStore)[];

export const BENCHMARKS_STORE_COMPLETE: ExactKeys<
  BenchmarksStore,
  typeof BENCHMARKS_STORE_METHODS
> = true;
