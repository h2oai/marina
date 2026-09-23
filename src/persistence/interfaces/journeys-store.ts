// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as journeysDb from "../db-journeys";
import type { ExactKeys } from "./exact-keys";

/** Journeys (`db-journeys.ts`). */
export interface JourneysStore {
  createJourney(input: Parameters<typeof journeysDb.createJourney>[1]): journeysDb.JourneyRow;
  getJourney(id: string): journeysDb.JourneyRow | undefined;
  getLatestJourneyForRequester(requesterId: string): journeysDb.JourneyRow | undefined;
  listJourneys(input?: Parameters<typeof journeysDb.listJourneys>[1]): journeysDb.JourneyRow[];
  addJourneyLink(input: Parameters<typeof journeysDb.addJourneyLink>[1]): journeysDb.JourneyLinkRow;
  listJourneyLinks(journeyId: string): journeysDb.JourneyLinkRow[];
  appendJourneyEvent(
    input: Parameters<typeof journeysDb.appendJourneyEvent>[1],
  ): journeysDb.JourneyEventRow;
  listJourneyEvents(journeyId: string, limit?: number): journeysDb.JourneyEventRow[];
  getJourneyWitness(journeyId: string, viewerId: string): journeysDb.JourneyWitnessRow | undefined;
  witnessJourney(
    journeyId: string,
    viewerId: string,
    eventId: number,
  ): journeysDb.JourneyWitnessRow;
}

/** Runtime mirror of `JourneysStore`'s method names — the drift test compares it to the facade. */
export const JOURNEYS_STORE_METHODS = [
  "createJourney",
  "getJourney",
  "getLatestJourneyForRequester",
  "listJourneys",
  "addJourneyLink",
  "listJourneyLinks",
  "appendJourneyEvent",
  "listJourneyEvents",
  "getJourneyWitness",
  "witnessJourney",
] as const satisfies readonly (keyof JourneysStore)[];

export const JOURNEYS_STORE_COMPLETE: ExactKeys<JourneysStore, typeof JOURNEYS_STORE_METHODS> =
  true;
