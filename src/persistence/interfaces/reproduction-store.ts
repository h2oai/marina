// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as reproductionDb from "../db-reproduction";
import type { ExactKeys } from "./exact-keys";

/** Cognitive and Marina reproduction (`db-reproduction.ts`). */
export interface ReproductionStore {
  recordCognitiveReproduction(
    input: Parameters<typeof reproductionDb.recordCognitiveReproduction>[1],
  ): ReturnType<typeof reproductionDb.recordCognitiveReproduction>;
  getCognitiveReproduction(id: string): ReturnType<typeof reproductionDb.getCognitiveReproduction>;
  listCognitiveReproductions(): ReturnType<typeof reproductionDb.listCognitiveReproductions>;
  listReproductionComponents(
    id: string,
  ): ReturnType<typeof reproductionDb.listReproductionComponents>;
  verifyCognitiveReproduction(
    row: reproductionDb.CognitiveReproductionRow,
  ): ReturnType<typeof reproductionDb.verifyCognitiveReproduction>;
  verifyMarinaGenome(
    row: reproductionDb.MarinaGenomeRow,
  ): ReturnType<typeof reproductionDb.verifyMarinaGenome>;
  createMarinaGenome(
    input: Parameters<typeof reproductionDb.createMarinaGenome>[1],
  ): ReturnType<typeof reproductionDb.createMarinaGenome>;
  getMarinaGenome(hash: string): ReturnType<typeof reproductionDb.getMarinaGenome>;
  listMarinaGenomes(): ReturnType<typeof reproductionDb.listMarinaGenomes>;
  createMarinaDescendant(
    input: Parameters<typeof reproductionDb.createMarinaDescendant>[1],
  ): ReturnType<typeof reproductionDb.createMarinaDescendant>;
  getMarinaDescendant(id: string): ReturnType<typeof reproductionDb.getMarinaDescendant>;
  listMarinaDescendants(): ReturnType<typeof reproductionDb.listMarinaDescendants>;
}

/** Runtime mirror of `ReproductionStore`'s method names — the drift test compares it to the facade. */
export const REPRODUCTION_STORE_METHODS = [
  "recordCognitiveReproduction",
  "getCognitiveReproduction",
  "listCognitiveReproductions",
  "listReproductionComponents",
  "verifyCognitiveReproduction",
  "verifyMarinaGenome",
  "createMarinaGenome",
  "getMarinaGenome",
  "listMarinaGenomes",
  "createMarinaDescendant",
  "getMarinaDescendant",
  "listMarinaDescendants",
] as const satisfies readonly (keyof ReproductionStore)[];

export const REPRODUCTION_STORE_COMPLETE: ExactKeys<
  ReproductionStore,
  typeof REPRODUCTION_STORE_METHODS
> = true;
