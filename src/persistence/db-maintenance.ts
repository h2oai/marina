// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";

// ─── Retention primitives and snapshots ────────────────────────────────────

export function tableExists(reader: Database, table: string): boolean {
  return (
    reader.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    null
  );
}

export function tableColumns(reader: Database, table: string): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return [];
  return (reader.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

/**
 * Delete at most `limit` rows of `table` matching `whereSql`, selected by
 * rowid so the statement stays bounded regardless of table size. Returns the
 * number of rows deleted. `table` and `whereSql` are trusted (policy code),
 * never user input.
 */
export function deleteBatch(
  db: Database,
  table: string,
  whereSql: string,
  params: (string | number)[],
  limit: number,
): number {
  // RETURNING rather than `.changes`: bun:sqlite reports trigger-side
  // writes in `changes` too (the memory storage-ledger triggers, for one),
  // which would overstate the count and could mis-terminate a batch loop.
  return db
    .query(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${whereSql} LIMIT ?)
         RETURNING rowid`,
    )
    .all(...params, Math.max(1, Math.trunc(limit))).length;
}

/**
 * Clone the live database into a self-contained file at `targetPath` using
 * SQLite's VACUUM INTO. The WAL is checkpointed first so the snapshot
 * reflects committed state. Returns summary counts for metadata.
 *
 * Fails if `targetPath` already exists (VACUUM INTO refuses to overwrite).
 */
export function snapshot(
  db: Database,
  reader: Database,
  targetPath: string,
): { notes: number; pools: number; benchmarkRuns: number; entities: number; bytes: number } {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const escaped = targetPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);

  const count = (sql: string): number => {
    try {
      const row = reader.query(sql).get() as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  };
  const notes = count("SELECT COUNT(*) as n FROM notes");
  const pools = count("SELECT COUNT(DISTINCT pool_id) as n FROM notes WHERE pool_id IS NOT NULL");
  const benchmarkRuns = count("SELECT COUNT(*) as n FROM benchmark_runs");
  const entities = count("SELECT COUNT(*) as n FROM entities");
  let bytes = 0;
  try {
    bytes = statSync(targetPath).size;
  } catch {
    /* stat failure is non-fatal */
  }
  return { notes, pools, benchmarkRuns, entities, bytes };
}

/**
 * Clone + prune. Produces a compacted snapshot at `targetPath` by first
 * VACUUM-ing into the target, then running safe pruning passes on the
 * target file (never touching the live DB), then VACUUM-ing again to
 * reclaim freed pages.
 *
 * Why: during the 2026-04-23 Gen-1 saturation investigation we found that
 * a warm snapshot accumulated 4945 `[compaction]` summary notes averaging
 * 150KB each — **99.8% of the DB's note content was compaction chaff**.
 * FTS5 recall had to scan that bulk on every turn. Pruning transient
 * metadata gives the snapshot a fighting chance to be faster than its
 * predecessor instead of slower. Generational memory with a compaction
 * discipline, not an accumulation race.
 *
 * What's dropped (opts control the thresholds):
 *  - `[compaction]`-prefixed notes (transient per-turn metadata written
 *    by the context manager's onBeforeCompact callback; capped at 2KB
 *    for new writes but legacy ones can be 100KB+)
 *  - Orphaned note_links (source or target note no longer exists after
 *    pruning)
 *  - entity_activity rows older than a cutoff (default 30 days)
 *
 * What's NEVER dropped:
 *  - Skills (note_type = 'skill')
 *  - Reflections (note_type = 'reflection')
 *  - High-importance notes (importance >= 7)
 *  - Pool notes with pool_id set (shared knowledge)
 *  - Core memory, agent_configs, entities, benchmark_runs,
 *    canvas/feed/session/auth data (schema-wise untouched)
 *
 * Dry-run mode (opts.dryRun=true) writes nothing — runs the counting
 * queries against a throwaway in-memory copy and returns what would
 * happen. Useful for `admin snapshot --compact --dry-run`.
 *
 * Returns a CompactionStats record: before / after / dropped counts +
 * disk-size delta.
 */
export function snapshotCompacted(
  db: Database,
  targetPath: string,
  opts?: CompactionOpts,
): CompactionStats {
  const {
    dropCompactionSummaries = true,
    compactionOlderThanDays = 0, // 0 = drop all; >0 = only older than N days
    activityOlderThanDays = 30,
    dropOrphanedLinks = true,
  } = opts ?? {};

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const escaped = targetPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);

  // Open the target as a separate connection for pruning. Never pollute
  // the live DB.
  const target = new Database(targetPath);
  target.exec("PRAGMA foreign_keys=OFF"); // allow cascades we do manually

  const before = {
    notes: target.query("SELECT COUNT(*) AS n FROM notes").get() as { n: number },
    links: target.query("SELECT COUNT(*) AS n FROM note_links").get() as { n: number },
    activity: target.query("SELECT COUNT(*) AS n FROM entity_activity").get() as { n: number },
    entities: target.query("SELECT COUNT(*) AS n FROM entities").get() as { n: number },
  };
  const beforeBytes = statSync(targetPath).size;

  const dropped = {
    compactionSummaries: 0,
    orphanedLinks: 0,
    staleActivity: 0,
  };

  // Count rows matching a predicate — used for accurate deletion reporting
  // since bun:sqlite's `res.changes` counts trigger-fired side effects too.
  const countRows = (sql: string, params: unknown[] = []): number => {
    const row = target.query(sql).get(...(params as [])) as { n: number } | null;
    return row?.n ?? 0;
  };

  // 1. Drop compaction-summary notes. Skills, reflections, high-importance
  //    notes, and pool-deposited notes are explicitly preserved even if
  //    they (somehow) start with [compaction] — paranoid belt-and-suspenders.
  if (dropCompactionSummaries) {
    const ageCutoff =
      compactionOlderThanDays > 0
        ? Date.now() - compactionOlderThanDays * 86_400_000
        : Date.now() + 1; // future → matches everything
    dropped.compactionSummaries = countRows(
      `SELECT COUNT(*) AS n FROM notes
           WHERE content LIKE '[compaction]%'
             AND created_at < ?
             AND note_type NOT IN ('skill', 'reflection')
             AND importance < 7
             AND pool_id IS NULL`,
      [ageCutoff],
    );
    target.run(
      `DELETE FROM notes
           WHERE content LIKE '[compaction]%'
             AND created_at < ?
             AND note_type NOT IN ('skill', 'reflection')
             AND importance < 7
             AND pool_id IS NULL`,
      [ageCutoff],
    );
  }

  // 2. Drop orphaned note_links (source or target vanished — common
  //    after compaction-summary pruning above).
  if (dropOrphanedLinks) {
    dropped.orphanedLinks = countRows(
      `SELECT COUNT(*) AS n FROM note_links
           WHERE source_id NOT IN (SELECT id FROM notes)
              OR target_id NOT IN (SELECT id FROM notes)`,
    );
    target.run(
      `DELETE FROM note_links
           WHERE source_id NOT IN (SELECT id FROM notes)
              OR target_id NOT IN (SELECT id FROM notes)`,
    );
  }

  // 3. Drop stale entity_activity rows.
  if (activityOlderThanDays > 0) {
    const activityCutoff = Date.now() - activityOlderThanDays * 86_400_000;
    dropped.staleActivity = countRows(
      "SELECT COUNT(*) AS n FROM entity_activity WHERE last_seen < ?",
      [activityCutoff],
    );
    target.run("DELETE FROM entity_activity WHERE last_seen < ?", [activityCutoff]);
  }

  // 4. Reclaim space. The FTS5 triggers fire on note DELETE and keep the
  //    virtual index in sync automatically.
  target.exec("VACUUM");

  const after = {
    notes: target.query("SELECT COUNT(*) AS n FROM notes").get() as { n: number },
    links: target.query("SELECT COUNT(*) AS n FROM note_links").get() as { n: number },
    activity: target.query("SELECT COUNT(*) AS n FROM entity_activity").get() as { n: number },
    entities: target.query("SELECT COUNT(*) AS n FROM entities").get() as { n: number },
  };
  target.close();
  const afterBytes = statSync(targetPath).size;

  return {
    before: {
      notes: before.notes.n,
      links: before.links.n,
      activity: before.activity.n,
      entities: before.entities.n,
      bytes: beforeBytes,
    },
    after: {
      notes: after.notes.n,
      links: after.links.n,
      activity: after.activity.n,
      entities: after.entities.n,
      bytes: afterBytes,
    },
    dropped,
  };
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface CompactionOpts {
  /** Drop `[compaction]`-prefixed transient summary notes. Default true. */
  dropCompactionSummaries?: boolean;
  /** Only drop compaction notes older than this many days. 0 = drop all. Default 0. */
  compactionOlderThanDays?: number;
  /** Drop entity_activity rows older than this many days. Default 30. */
  activityOlderThanDays?: number;
  /** Drop note_links whose source or target no longer exists. Default true. */
  dropOrphanedLinks?: boolean;
}

export interface CompactionStats {
  before: { notes: number; links: number; activity: number; entities: number; bytes: number };
  after: { notes: number; links: number; activity: number; entities: number; bytes: number };
  dropped: { compactionSummaries: number; orphanedLinks: number; staleActivity: number };
}
