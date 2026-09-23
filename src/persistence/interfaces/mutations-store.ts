// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as mutationsDb from "../db-mutations";
import type { ExactKeys } from "./exact-keys";

/** Civilization mutation lineage (`db-mutations.ts`). */
export interface MutationsStore {
  appendCivilizationMutation(
    input: Parameters<typeof mutationsDb.appendCivilizationMutation>[1],
  ): ReturnType<typeof mutationsDb.appendCivilizationMutation>;
  getCivilizationMutation(id: string): ReturnType<typeof mutationsDb.getCivilizationMutation>;
  listCivilizationMutations(
    domain?: string,
    targetRef?: string,
  ): ReturnType<typeof mutationsDb.listCivilizationMutations>;
  verifyCivilizationMutation(
    row: mutationsDb.CivilizationMutationRow,
  ): ReturnType<typeof mutationsDb.verifyCivilizationMutation>;
}

/** Runtime mirror of `MutationsStore`'s method names — the drift test compares it to the facade. */
export const MUTATIONS_STORE_METHODS = [
  "appendCivilizationMutation",
  "getCivilizationMutation",
  "listCivilizationMutations",
  "verifyCivilizationMutation",
] as const satisfies readonly (keyof MutationsStore)[];

export const MUTATIONS_STORE_COMPLETE: ExactKeys<MutationsStore, typeof MUTATIONS_STORE_METHODS> =
  true;
