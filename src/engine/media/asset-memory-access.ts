// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Who may read an asset's memory: exactly who may read the asset
 * (src/engine/canvas-access.ts → `mayReadAsset`). A light module (no vision or
 * model imports) so the memory read path can apply the check to every
 * `asset:<id>` record it serves.
 *
 * The check is the HTTP-principal form (no local-ungated lift, no creator
 * relation, no in-memory node grants): memory is one surface for commands,
 * REST, MCP and model injection, so every surface must answer alike, and the
 * strict form is the one that holds on all of them.
 */

import type { MarinaDB } from "../../persistence/database";
import type { AssetRow } from "../../persistence/db-assets";
import type { EntityId } from "../../types";
import { type CanvasAccessHost, canvasReaderFor, mayReadAsset } from "../canvas-access";

/** `metadata.kind` of every memory record made from an asset's text. */
export const ASSET_MEMORY_KIND = "asset-text";

/** The memory record subject of an asset's text records. */
export function assetMemorySubject(assetId: string): string {
  return `asset:${assetId}`;
}

/** A canvas-access host over the database alone (entities loaded from storage). */
export function dbCanvasHost(db: MarinaDB): CanvasAccessHost {
  return {
    db,
    entities: { get: (id: never) => db.loadEntity(id as EntityId) },
  };
}

/**
 * May the entity named `name` (or with id `entityId`) read this asset?
 * Unknown names read only public assets.
 */
export function assetReadableBy(
  db: MarinaDB,
  who: { name?: string; id?: string },
  asset: Pick<AssetRow, "id" | "metadata" | "derived_from">,
  host: CanvasAccessHost = dbCanvasHost(db),
): boolean {
  const id = who.id ?? (who.name ? db.findEntityIdByName(who.name) : undefined);
  const reader = id ? canvasReaderFor(host, id) : {};
  return mayReadAsset(host, asset, reader, "asset memory", { log: false });
}
