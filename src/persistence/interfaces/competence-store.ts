// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as competenceDb from "../db-competence";
import type { ExactKeys } from "./exact-keys";

/** Per-gate competence (`db-competence.ts`); entity ids resolve to durable keys at the facade. */
export interface CompetenceStore {
  getCompetence(entityId: string, gate: string): ReturnType<typeof competenceDb.getCompetence>;
  listCompetenceForEntity(
    entityId: string,
  ): ReturnType<typeof competenceDb.listCompetenceForEntity>;
  recordDemonstration(entityId: string, gate: string, unlockAt: number, now: number): void;
  grantCompetence(entityId: string, gate: string): void;
}

/** Runtime mirror of `CompetenceStore`'s method names — the drift test compares it to the facade. */
export const COMPETENCE_STORE_METHODS = [
  "getCompetence",
  "listCompetenceForEntity",
  "recordDemonstration",
  "grantCompetence",
] as const satisfies readonly (keyof CompetenceStore)[];

export const COMPETENCE_STORE_COMPLETE: ExactKeys<
  CompetenceStore,
  typeof COMPETENCE_STORE_METHODS
> = true;
