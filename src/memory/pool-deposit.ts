// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../persistence/database";

/**
 * Deposit a note into a pool and report whether a row was actually written.
 *
 * `MarinaDB.addPoolNote` dedups exact same-author content inside a pool (see
 * `findActivePoolNote` in db-notes) and returns the surviving id either way.
 * Command surfaces want to tell the depositor which case they hit, so this
 * helper compares the pool's row count around the write — SQLite access is
 * synchronous, so the comparison is exact.
 */
export function depositPoolNote(
  db: MarinaDB,
  poolId: string,
  entityName: string,
  content: string,
  importance?: number,
  noteType?: string,
): { id: number; existing: boolean } {
  const before = db.countPoolNotes(poolId);
  const id = db.addPoolNote(poolId, entityName, content, importance, noteType);
  return { id, existing: db.countPoolNotes(poolId) === before };
}
