// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistence for Score artifacts — a thin layer over the `scores` memory pool.
 *
 * Shared by the `conduct` command (author/inspect) and the calibration finder
 * (Phase 5 automatic closure), so both agree on how a stored Score is tagged
 * and parsed. Storage is intentionally pool-notes, not a table: Scores are
 * artifacts agents author, fork, and mutate (see docs/conductor-design.md).
 */

import type { MarinaDB } from "../persistence/database";
import { parseScore, type Score } from "./score";

export const SCORES_POOL = "scores";

/** `[score:<name>] <compact-json>` — the storage form of a Score. */
export function scoreTag(name: string): string {
  return `[score:${name}]`;
}

function ensurePool(db: MarinaDB): { id: string } | undefined {
  let pool = db.getMemoryPool(SCORES_POOL);
  if (!pool) {
    db.createMemoryPool(`pool-${SCORES_POOL}`, SCORES_POOL, "conduct");
    pool = db.getMemoryPool(SCORES_POOL);
  }
  return pool ? { id: pool.id } : undefined;
}

/** Most-recent stored Score for a name, or undefined. */
export function loadScore(db: MarinaDB, name: string): Score | undefined {
  const pool = db.getMemoryPool(SCORES_POOL);
  if (!pool) return undefined;
  const tag = scoreTag(name);
  const match = db.getPoolNotes(pool.id, 500).find((n) => n.content.startsWith(tag));
  if (!match) return undefined;
  try {
    return parseScore(match.content.slice(tag.length).trim());
  } catch {
    return undefined;
  }
}

export function storeScore(db: MarinaDB, author: string, name: string, score: Score): boolean {
  const pool = ensurePool(db);
  if (!pool) return false;
  db.addPoolNote(pool.id, author, `${scoreTag(name)} ${JSON.stringify(score)}`, 6);
  return true;
}

/** Distinct stored Score names. */
export function listScoreNames(db: MarinaDB): string[] {
  const pool = db.getMemoryPool(SCORES_POOL);
  if (!pool) return [];
  const names = new Set<string>();
  for (const n of db.getPoolNotes(pool.id, 500)) {
    const m = n.content.match(/^\[score:([^\]]+)\]/);
    if (m) names.add(m[1]!);
  }
  return [...names];
}
