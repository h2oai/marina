// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  AssetCursor,
  AssetFacts,
  AssetLinkRow,
  AssetOrigin,
  AssetQuery,
  AssetRow,
  CreateAssetInput,
  listAssetCanvasUsage,
} from "../db-assets";
import type { ExactKeys } from "./exact-keys";

/** Assets (`db-assets.ts`). */
export interface AssetsStore {
  createAsset(asset: CreateAssetInput): void;
  getAsset(id: string): AssetRow | undefined;
  getAssetsByEntity(entityName: string, limit?: number): AssetRow[];
  listAssets(opts?: { limit?: number; mime?: string }): AssetRow[];
  listAssetsByOrigin(origin: string, before: number, limit: number): AssetRow[];
  deleteAsset(id: string): boolean;
  updateAssetFacts(id: string, facts: AssetFacts): boolean;
  updateAssetText(id: string, text: { caption?: string | null; alt?: string | null }): boolean;
  findAssetByHash(entityName: string, sha256: string, origin: AssetOrigin): AssetRow | undefined;
  listAssetsNeedingFacts(limit: number): AssetRow[];
  setAssetMetadataKey(id: string, key: string, value: unknown, opts?: { touch?: boolean }): boolean;
  listAssetsChangedSince(after: AssetCursor | undefined, limit: number): AssetRow[];
  getAssetMemoryState(key: string): string | undefined;
  setAssetMemoryState(key: string, value: string): void;
  deleteAssetMemoryState(key: string): void;
  listAssetMemoryState(prefix: string, limit: number): { key: string; value: string }[];
  setAssetTags(id: string, add: readonly string[], remove: readonly string[]): string[];
  getAssetTags(id: string): string[];
  getAssetTagsFor(ids: readonly string[]): Map<string, string[]>;
  linkAssets(fromId: string, toId: string, kind: string): void;
  getAssetLinks(id: string): { parents: AssetLinkRow[]; children: AssetLinkRow[] };
  listDerivatives(ids: readonly string[]): (AssetRow & { kind: string })[];
  listAssetCanvasUsage(id: string): ReturnType<typeof listAssetCanvasUsage>;
  queryAssets(query: AssetQuery): AssetRow[];
}

/** Runtime mirror of `AssetsStore`'s method names — the drift test compares it to the facade. */
export const ASSETS_STORE_METHODS = [
  "createAsset",
  "getAsset",
  "getAssetsByEntity",
  "listAssets",
  "listAssetsByOrigin",
  "deleteAsset",
  "updateAssetFacts",
  "updateAssetText",
  "findAssetByHash",
  "listAssetsNeedingFacts",
  "setAssetMetadataKey",
  "listAssetsChangedSince",
  "getAssetMemoryState",
  "setAssetMemoryState",
  "deleteAssetMemoryState",
  "listAssetMemoryState",
  "setAssetTags",
  "getAssetTags",
  "getAssetTagsFor",
  "linkAssets",
  "getAssetLinks",
  "listDerivatives",
  "listAssetCanvasUsage",
  "queryAssets",
] as const satisfies readonly (keyof AssetsStore)[];

export const ASSETS_STORE_COMPLETE: ExactKeys<AssetsStore, typeof ASSETS_STORE_METHODS> = true;
