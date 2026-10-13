// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { NewSchedule, ScheduleRow, ScheduleRunRow } from "../db-schedules";
import type { ExactKeys } from "./exact-keys";

/** Schedules and their run history (`db-schedules.ts`, migration 165). */
export interface SchedulesStore {
  createSchedule(s: NewSchedule): ScheduleRow;
  getSchedule(id: number): ScheduleRow | undefined;
  getScheduleByName(ownerKey: string, name: string): ScheduleRow | undefined;
  listSchedules(ownerKey?: string, limit?: number): ScheduleRow[];
  countSchedules(ownerKey: string): number;
  dueSchedules(now: number, limit?: number): ScheduleRow[];
  updateScheduleState(
    id: number,
    state: {
      nextRunAt: number | null;
      enabled?: boolean;
      ran?: boolean;
      lastStatus?: string;
      lastRunAt?: number;
      consecutiveFailures?: number;
    },
  ): void;
  setScheduleEnabled(id: number, enabled: boolean, nextRunAt: number | null): void;
  updateScheduleTrigger(id: number, triggerJson: string, nextRunAt: number | null): void;
  deleteSchedule(id: number): boolean;
  recordScheduleRun(run: Omit<ScheduleRunRow, "id">): ScheduleRunRow;
  listScheduleRuns(scheduleId: number, limit?: number): ScheduleRunRow[];
}

/** Runtime mirror of `SchedulesStore`'s method names — the drift test compares it to the facade. */
export const SCHEDULES_STORE_METHODS = [
  "createSchedule",
  "getSchedule",
  "getScheduleByName",
  "listSchedules",
  "countSchedules",
  "dueSchedules",
  "updateScheduleState",
  "setScheduleEnabled",
  "updateScheduleTrigger",
  "deleteSchedule",
  "recordScheduleRun",
  "listScheduleRuns",
] as const satisfies readonly (keyof SchedulesStore)[];

export const SCHEDULES_STORE_COMPLETE: ExactKeys<SchedulesStore, typeof SCHEDULES_STORE_METHODS> =
  true;
