// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as logsDb from "../db-logs";
import type { ExactKeys } from "./exact-keys";

/** Structured log persistence (`db-logs.ts`). */
export interface LogsStore {
  appendStructuredLog(entry: logsDb.StoredLogEntry | Omit<logsDb.StoredLogEntry, "id">): number;
  queryStructuredLogs(query?: logsDb.LogQuery): logsDb.LogPage;
  pruneStructuredLogs(keepLast: number): number;
  pruneEvents(keepLast: number): number;
}

/** Runtime mirror of `LogsStore`'s method names — the drift test compares it to the facade. */
export const LOGS_STORE_METHODS = [
  "appendStructuredLog",
  "queryStructuredLogs",
  "pruneStructuredLogs",
  "pruneEvents",
] as const satisfies readonly (keyof LogsStore)[];

export const LOGS_STORE_COMPLETE: ExactKeys<LogsStore, typeof LOGS_STORE_METHODS> = true;
