// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BenchmarkRunRow } from "../db-benchmarks";
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
  "traceNoteGraph",
  "countNoteLinks",
  "countLinksForNote",
] as const satisfies readonly (keyof BenchmarksStore)[];

export const BENCHMARKS_STORE_COMPLETE: ExactKeys<
  BenchmarksStore,
  typeof BENCHMARKS_STORE_METHODS
> = true;
