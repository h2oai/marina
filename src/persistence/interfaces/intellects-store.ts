// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as intellectsDb from "../db-intellects";
import type { ExactKeys } from "./exact-keys";

/** Intellect identity and lifecycle (`db-intellects.ts`). */
export interface IntellectsStore {
  createIntellect(
    input: Parameters<typeof intellectsDb.createIntellect>[1],
  ): ReturnType<typeof intellectsDb.createIntellect>;
  getIntellect(id: string): ReturnType<typeof intellectsDb.getIntellect>;
  listIntellects(limit?: number): ReturnType<typeof intellectsDb.listIntellects>;
  findIntellectsByIdPrefix(
    selector: string,
  ): ReturnType<typeof intellectsDb.findIntellectsByIdPrefix>;
  getLatestIntellectLifecycleKind(
    intellectId: string,
  ): ReturnType<typeof intellectsDb.getLatestIntellectLifecycleKind>;
  createIntellectInstance(
    input: Parameters<typeof intellectsDb.createIntellectInstance>[1],
  ): ReturnType<typeof intellectsDb.createIntellectInstance>;
  listIntellectInstances(
    intellectId: string,
  ): ReturnType<typeof intellectsDb.listIntellectInstances>;
  appendIntellectEvent(
    input: Parameters<typeof intellectsDb.appendIntellectEvent>[1],
  ): ReturnType<typeof intellectsDb.appendIntellectEvent>;
  listIntellectEvents(
    intellectId: string,
    limit?: number,
  ): ReturnType<typeof intellectsDb.listIntellectEvents>;
  verifyIntellectEvent(
    row: intellectsDb.IntellectEventRow,
  ): ReturnType<typeof intellectsDb.verifyIntellectEvent>;
}

/** Runtime mirror of `IntellectsStore`'s method names — the drift test compares it to the facade. */
export const INTELLECTS_STORE_METHODS = [
  "createIntellect",
  "getIntellect",
  "listIntellects",
  "findIntellectsByIdPrefix",
  "getLatestIntellectLifecycleKind",
  "createIntellectInstance",
  "listIntellectInstances",
  "appendIntellectEvent",
  "listIntellectEvents",
  "verifyIntellectEvent",
] as const satisfies readonly (keyof IntellectsStore)[];

export const INTELLECTS_STORE_COMPLETE: ExactKeys<
  IntellectsStore,
  typeof INTELLECTS_STORE_METHODS
> = true;
