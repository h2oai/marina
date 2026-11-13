// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * SQL behind the storage budget (`src/engine/storage-budget.ts`): how big the
 * database is, pruning the oldest resident continuity journal under pressure,
 * and giving freed pages back to the file system.
 */

import type { Database } from "bun:sqlite";

export interface DatabasePages {
  /** The main database file on disk ("" for an in-memory database). */
  file: string;
  pageSize: number;
  pageCount: number;
  freePages: number;
  /** 0 none, 1 full, 2 incremental. */
  autoVacuum: number;
}

export function databasePages(db: Database): DatabasePages {
  const one = (pragma: string) =>
    Number(Object.values(db.query(`PRAGMA ${pragma}`).get() as Record<string, unknown>)[0] ?? 0);
  const main = (db.query("PRAGMA database_list").all() as { name: string; file: string }[]).find(
    (d) => d.name === "main",
  );
  return {
    file: main?.file ?? "",
    pageSize: one("page_size"),
    pageCount: one("page_count"),
    freePages: one("freelist_count"),
    autoVacuum: one("auto_vacuum"),
  };
}

/**
 * A resident journal or archive manifest (`src/agent/durable-memory.ts`): it
 * lists the message parts of one capture in `source_ids` and links to the one
 * before it. Parts are reused by later captures of the same conversation.
 */
const MANIFEST =
  // The prefix test is cheap and skips the JSON parse for every message part.
  "instr(substr(body,1,64),'json-utf8-parts-v1') > 0 AND json_valid(body) AND json_extract(body,'$.format')='json-utf8-parts-v1' AND json_extract(body,'$.kind') IN ('journal','archive')";

export interface JournalPruneResult {
  manifests: number;
  parts: number;
  /** Bytes of source bodies removed (their text copy and index go with them). */
  bytes: number;
}

export interface JournalPruneOptions {
  /** Sources deleted per transaction. */
  batch?: number;
  /** Checked between batches with the running totals: true stops (target met, or time up). */
  stop?: (sofar: JournalPruneResult) => boolean;
}

/**
 * Delete resident journal and archive captures older than `before`, oldest
 * first, in batches until none is left or `stop()` says so. Kept, always: the
 * newest manifest of each space and kind, every part a kept manifest lists,
 * anything a memory record was derived from, an assistance job's input, any
 * source a checkpoint names, and every part a manifest not yet pruned lists. Only sources proven to be journal parts (listed by
 * a pruned manifest) are removed; facts, lessons and other sources are never
 * touched. The text copy, its full-text index and the storage ledger follow by
 * cascade and trigger. A reader following `previous_manifest_source_id` reaches
 * the end of the chain sooner.
 *
 * Synchronous on purpose: the keep set is computed once, and no capture can
 * land between its batches.
 */
export function pruneJournalSources(
  db: Database,
  before: number,
  opts: JournalPruneOptions = {},
): JournalPruneResult {
  const batch = Math.max(1, opts.batch ?? 5_000);
  const result: JournalPruneResult = { manifests: 0, parts: 0, bytes: 0 };
  const drop = () => {
    db.run("DROP TABLE IF EXISTS temp.storage_manifests");
    db.run("DROP TABLE IF EXISTS temp.storage_keep");
    db.run("DROP TABLE IF EXISTS temp.storage_drop");
    db.run("DROP TABLE IF EXISTS temp.storage_count");
    db.run("DROP TABLE IF EXISTS temp.storage_batch");
  };
  drop();
  try {
    db.run(
      `CREATE TEMP TABLE storage_manifests(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
         space_id TEXT, kind TEXT, created_at INTEGER, body TEXT)`,
    );
    db.run(
      `INSERT INTO storage_manifests SELECT seq, id, space_id, json_extract(body,'$.kind'),
         created_at, body FROM memory_sources WHERE ${MANIFEST}`,
    );
    db.run(`CREATE TEMP TABLE storage_keep(id TEXT PRIMARY KEY) WITHOUT ROWID`);
    // Kept manifests: recent ones and the newest of each space and kind.
    db.run(
      `INSERT OR IGNORE INTO storage_keep SELECT id FROM storage_manifests
       WHERE created_at >= ? OR seq IN (SELECT max(seq) FROM storage_manifests GROUP BY space_id, kind)`,
      [before],
    );
    // How many manifests list each part. A batch subtracts what its dropped
    // manifests list, and a part goes only at zero: kept manifests are never
    // dropped, and an old one only with its batch, so a run stopped between
    // batches never leaves a manifest pointing at a missing part. (A part of a
    // long conversation is listed by thousands of captures: counting keeps each
    // batch proportional to its own manifests.)
    db.run(
      "CREATE TEMP TABLE storage_count(part TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID",
    );
    db.run(
      `INSERT INTO storage_count SELECT j.value, count(*) FROM storage_manifests m,
         json_each(m.body,'$.source_ids') j WHERE j.type = 'text' GROUP BY j.value`,
    );
    db.run(
      "CREATE TEMP TABLE storage_batch(part TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID",
    );
    db.run("INSERT OR IGNORE INTO storage_keep SELECT source_id FROM memory_derivations");
    if (
      db
        .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_assistance_jobs'")
        .get()
    )
      db.run(
        "INSERT OR IGNORE INTO storage_keep SELECT input_source_id FROM memory_assistance_jobs",
      );
    db.run(
      `INSERT OR IGNORE INTO storage_keep SELECT t.value FROM memory_checkpoints c, json_tree(c.data) t
       WHERE json_valid(c.data) AND t.type = 'text' AND length(t.value) <= 64`,
    );
    db.run(
      "CREATE TEMP TABLE storage_drop(seq INTEGER PRIMARY KEY, id TEXT NOT NULL, manifest INTEGER NOT NULL)",
    );
    const next = db.transaction(() => {
      db.run("DELETE FROM storage_drop");
      // The oldest manifests left to drop, then the old parts they list.
      db.run(
        `INSERT INTO storage_drop SELECT m.seq, m.id, 1 FROM storage_manifests m
         WHERE NOT EXISTS (SELECT 1 FROM storage_keep k WHERE k.id = m.id) ORDER BY m.seq LIMIT ?`,
        [batch],
      );
      db.run("DELETE FROM storage_batch");
      db.run(
        `INSERT INTO storage_batch SELECT j.value, count(*) FROM storage_drop d
         JOIN storage_manifests m ON m.seq = d.seq, json_each(m.body,'$.source_ids') j
         WHERE j.type = 'text' GROUP BY j.value`,
      );
      db.run(
        `UPDATE storage_count SET n = n - (SELECT b.n FROM storage_batch b WHERE b.part = storage_count.part)
         WHERE part IN (SELECT part FROM storage_batch)`,
      );
      db.run(
        `INSERT OR IGNORE INTO storage_drop SELECT s.seq, s.id, 0 FROM storage_batch b
         JOIN storage_count c ON c.part = b.part JOIN memory_sources s ON s.id = b.part
         WHERE c.n <= 0 AND s.created_at < ?
           AND NOT EXISTS (SELECT 1 FROM storage_keep k WHERE k.id = s.id)
           AND NOT EXISTS (SELECT 1 FROM storage_manifests x WHERE x.id = s.id)`,
        [before],
      );
      const counted = db
        .query(
          `SELECT coalesce(sum(d.manifest),0) AS manifests, coalesce(sum(1-d.manifest),0) AS parts,
             coalesce(sum(length(CAST(s.body AS BLOB))),0) AS bytes
           FROM storage_drop d JOIN memory_sources s ON s.seq = d.seq`,
        )
        .get() as JournalPruneResult;
      db.run("DELETE FROM memory_sources WHERE seq IN (SELECT seq FROM storage_drop)");
      // Done with these manifests: the next batch starts after them.
      db.run(
        "DELETE FROM storage_manifests WHERE seq IN (SELECT seq FROM storage_drop WHERE manifest = 1)",
      );
      return counted;
    });
    for (;;) {
      const counted = next();
      result.manifests += counted.manifests;
      result.parts += counted.parts;
      result.bytes += counted.bytes;
      if (counted.manifests === 0 || opts.stop?.(result)) break;
    }
  } finally {
    drop();
  }
  return result;
}

/**
 * Give free pages back to the file system. With incremental auto-vacuum that is
 * `PRAGMA incremental_vacuum` (quick, any time). Otherwise only a full
 * `VACUUM` shrinks the file, which rewrites the database and briefly needs
 * room for a second copy: run it only when `allowVacuum` (at startup, before
 * anything else uses the database) and it also switches the file to
 * incremental auto-vacuum so later passes never need it again. Returns the
 * bytes the file shrank by.
 */
export function reclaimFreePages(
  db: Database,
  opts: { allowVacuum: boolean },
): {
  reclaimed: number;
  vacuumed: boolean;
} {
  const before = databasePages(db);
  if (!before.file || before.freePages === 0) return { reclaimed: 0, vacuumed: false };
  let vacuumed = false;
  if (before.autoVacuum === 2) {
    db.run("PRAGMA incremental_vacuum");
  } else if (opts.allowVacuum) {
    db.run("PRAGMA auto_vacuum=INCREMENTAL");
    db.run("VACUUM");
    vacuumed = true;
  } else {
    return { reclaimed: 0, vacuumed: false };
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const after = databasePages(db);
  return {
    reclaimed: Math.max(0, (before.pageCount - after.pageCount) * before.pageSize),
    vacuumed,
  };
}
