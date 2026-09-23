// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as cognitiveEventsDb from "../db-cognitive-events";
import type { ExactKeys } from "./exact-keys";

/** Cognitive provenance events (`db-cognitive-events.ts`). */
export interface CognitiveEventsStore {
  appendCognitiveEvent(
    input: Parameters<typeof cognitiveEventsDb.appendCognitiveEvent>[1],
  ): cognitiveEventsDb.CognitiveEventRow;
  listCognitiveEvents(
    input?: Parameters<typeof cognitiveEventsDb.listCognitiveEvents>[1],
  ): cognitiveEventsDb.CognitiveEventRow[];
  countCognitiveEvents(
    input?: Parameters<typeof cognitiveEventsDb.countCognitiveEvents>[1],
  ): number;
  verifyCognitiveEvent(
    row: cognitiveEventsDb.CognitiveEventRow,
  ): ReturnType<typeof cognitiveEventsDb.verifyCognitiveEvent>;
}

/** Runtime mirror of `CognitiveEventsStore`'s method names — the drift test compares it to the facade. */
export const COGNITIVE_EVENTS_STORE_METHODS = [
  "appendCognitiveEvent",
  "listCognitiveEvents",
  "countCognitiveEvents",
  "verifyCognitiveEvent",
] as const satisfies readonly (keyof CognitiveEventsStore)[];

export const COGNITIVE_EVENTS_STORE_COMPLETE: ExactKeys<
  CognitiveEventsStore,
  typeof COGNITIVE_EVENTS_STORE_METHODS
> = true;
