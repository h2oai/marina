// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AssetRow } from "../db-assets";
import type { ExactKeys } from "./exact-keys";

/** Assets (`db-assets.ts`). */
export interface AssetsStore {
  createAsset(asset: {
    id: string;
    entityName: string;
    filename: string;
    mimeType: string;
    size: number;
    storageKey: string;
    metadata?: Record<string, unknown>;
  }): void;
  getAsset(id: string): AssetRow | undefined;
  getAssetsByEntity(entityName: string, limit?: number): AssetRow[];
  listAssets(opts?: { limit?: number; mime?: string }): AssetRow[];
  deleteAsset(id: string): boolean;
}

/** Runtime mirror of `AssetsStore`'s method names — the drift test compares it to the facade. */
export const ASSETS_STORE_METHODS = [
  "createAsset",
  "getAsset",
  "getAssetsByEntity",
  "listAssets",
  "deleteAsset",
] as const satisfies readonly (keyof AssetsStore)[];

export const ASSETS_STORE_COMPLETE: ExactKeys<AssetsStore, typeof ASSETS_STORE_METHODS> = true;
