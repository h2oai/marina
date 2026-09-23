// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Assets ────────────────────────────────────────────────────────────────

export function createAsset(
  db: Database,
  asset: {
    id: string;
    entityName: string;
    filename: string;
    mimeType: string;
    size: number;
    storageKey: string;
    metadata?: Record<string, unknown>;
  },
): void {
  db.run(
    `INSERT INTO assets (id, entity_name, filename, mime_type, size, storage_key, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      asset.id,
      asset.entityName,
      asset.filename,
      asset.mimeType,
      asset.size,
      asset.storageKey,
      JSON.stringify(asset.metadata ?? {}),
      Date.now(),
    ],
  );
}

export function getAsset(db: Database, id: string): AssetRow | undefined {
  return (db.query("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow | null) ?? undefined;
}

export function getAssetsByEntity(db: Database, entityName: string, limit = 50): AssetRow[] {
  return db
    .query("SELECT * FROM assets WHERE entity_name = ? ORDER BY created_at DESC LIMIT ?")
    .all(entityName, limit) as AssetRow[];
}

export function listAssets(db: Database, opts?: { limit?: number; mime?: string }): AssetRow[] {
  if (opts?.mime) {
    return db
      .query("SELECT * FROM assets WHERE mime_type LIKE ? ORDER BY created_at DESC LIMIT ?")
      .all(`${opts.mime}%`, opts?.limit ?? 50) as AssetRow[];
  }
  return db
    .query("SELECT * FROM assets ORDER BY created_at DESC LIMIT ?")
    .all(opts?.limit ?? 50) as AssetRow[];
}

export function deleteAsset(db: Database, id: string): boolean {
  const result = db.run("DELETE FROM assets WHERE id = ?", [id]);
  return result.changes > 0;
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface AssetRow {
  id: string;
  entity_name: string;
  filename: string;
  mime_type: string;
  size: number;
  storage_key: string;
  metadata: string;
  created_at: number;
}
