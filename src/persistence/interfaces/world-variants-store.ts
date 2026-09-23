// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as worldVariantsDb from "../db-world-variants";
import type { ExactKeys } from "./exact-keys";

/** World variants (`db-world-variants.ts`). */
export interface WorldVariantsStore {
  createWorldVariant(
    input: Parameters<typeof worldVariantsDb.createWorldVariant>[1],
  ): worldVariantsDb.WorldVariantRow;
  getWorldVariant(id: string): worldVariantsDb.WorldVariantRow | undefined;
  listWorldVariants(): worldVariantsDb.WorldVariantRow[];
  updateWorldVariant(
    id: string,
    patch: Parameters<typeof worldVariantsDb.updateWorldVariant>[2],
  ): worldVariantsDb.WorldVariantRow | undefined;
  promoteWorldVariant(
    id: string,
    input: Parameters<typeof worldVariantsDb.promoteWorldVariant>[2],
  ): worldVariantsDb.WorldVariantRow | undefined;
}

/** Runtime mirror of `WorldVariantsStore`'s method names — the drift test compares it to the facade. */
export const WORLD_VARIANTS_STORE_METHODS = [
  "createWorldVariant",
  "getWorldVariant",
  "listWorldVariants",
  "updateWorldVariant",
  "promoteWorldVariant",
] as const satisfies readonly (keyof WorldVariantsStore)[];

export const WORLD_VARIANTS_STORE_COMPLETE: ExactKeys<
  WorldVariantsStore,
  typeof WORLD_VARIANTS_STORE_METHODS
> = true;
