// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import { FORWARD_MIGRATIONS } from "../src/persistence/schema";
import { cleanupDb } from "./helpers";

// Migration 144: `markets_fts` is keyed by the INTEGER PRIMARY KEY `seq`, so
// VACUUM / VACUUM INTO (which may renumber an implicit rowid) cannot desync
// the external-content index from its rows.
describe("markets_fts survives VACUUM", () => {
  const live = `/tmp/marina-markets-fts-${crypto.randomUUID()}.db`;
  const compacted = `/tmp/marina-markets-fts-compact-${crypto.randomUUID()}.db`;
  const plain = `/tmp/marina-markets-fts-plain-${crypto.randomUUID()}.db`;

  afterEach(() => {
    cleanupDb(live);
    cleanupDb(compacted);
    cleanupDb(plain);
  });

  it("finds every market in a compacted snapshot after deletes leave rowid gaps", () => {
    const db = new MarinaDB(live);
    const topics = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    for (const [i, topic] of topics.entries()) {
      db.createMarket({ id: `m_${i}`, roomId: `r/${i}`, question: `Will ${topic} happen?` });
    }
    // Delete from the front and middle so a renumbering VACUUM would shift rows.
    const raw = new Database(live);
    raw.run("PRAGMA foreign_keys=ON");
    raw.run("DELETE FROM markets WHERE id IN ('m_0', 'm_2')");
    raw.close();

    db.snapshotCompacted(compacted);
    db.snapshot(plain);
    db.close();

    for (const path of [compacted, plain]) {
      const snap = new MarinaDB(path);
      for (const [i, topic] of topics.entries()) {
        const hits = snap.searchMarkets(topic).map((m) => m.id);
        expect(hits).toEqual(i === 0 || i === 2 ? [] : [`m_${i}`]);
      }
      // The index integrity check agrees with the content table.
      const check = new Database(path);
      expect(() =>
        check.run("INSERT INTO markets_fts(markets_fts, rank) VALUES ('integrity-check', 1)"),
      ).not.toThrow();
      check.close();
      snap.close();
    }
  });

  it("migration 144 carries markets, positions and scores over and re-indexes them", () => {
    new MarinaDB(live).close();
    // Recreate the pre-144 shape (implicit rowid, rowid-keyed FTS) with data in it.
    const raw = new Database(live);
    raw.run("PRAGMA foreign_keys=OFF");
    raw.exec(`
      DROP TRIGGER markets_fts_ai; DROP TRIGGER markets_fts_ad; DROP TRIGGER markets_fts_au;
      DROP TABLE markets_fts; DROP TABLE markets;
      CREATE TABLE markets (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, question TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', outcome TEXT,
        resolved_at INTEGER, resolved_by TEXT, created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE markets_fts USING fts5(question, category, content=markets, content_rowid=rowid);
      CREATE TRIGGER markets_fts_ai AFTER INSERT ON markets BEGIN
        INSERT INTO markets_fts(rowid, question, category) VALUES (new.rowid, new.question, new.category);
      END;
      INSERT INTO markets (id, room_id, question, created_at) VALUES
        ('m_a', 'r/a', 'Will it rain?', 1), ('m_b', 'r/b', 'Will it snow?', 2);
      INSERT INTO market_positions (market_id, entity_name, direction, confidence, created_at, updated_at)
        VALUES ('m_a', 'Alice', 'yes', 70, 1, 1);
      INSERT INTO market_scores (market_id, entity_name, brier_score, scored_at)
        VALUES ('m_b', 'Bob', 0.2, 3);
    `);
    // Apply migration 144's SQL as the upgrade runner does: one transaction,
    // foreign keys ON (so a careless parent DROP would cascade).
    const migration = FORWARD_MIGRATIONS.find((m) => m.version === 144)!;
    raw.run("PRAGMA foreign_keys=ON");
    raw.transaction(() => raw.exec(migration.sql))();
    raw.close();

    const db = new MarinaDB(live);
    const check = new Database(live);
    const pk = (check.query("PRAGMA table_info(markets)").all() as { name: string; pk: number }[])
      .filter((c) => c.pk > 0)
      .map((c) => c.name);
    expect(pk).toEqual(["seq"]);
    expect(db.searchMarkets("rain").map((m) => m.id)).toEqual(["m_a"]);
    expect(db.searchMarkets("snow").map((m) => m.id)).toEqual(["m_b"]);
    expect(db.getMarketPositions("m_a").map((p) => p.entity_name)).toEqual(["Alice"]);
    expect(
      (
        check.query("SELECT COUNT(*) AS n FROM market_scores WHERE market_id = 'm_b'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    // The FK still cascades from the rebuilt parent.
    check.close();
    const writer = new Database(live);
    writer.run("PRAGMA foreign_keys=ON");
    writer.run("DELETE FROM markets WHERE id = 'm_a'");
    writer.close();
    expect(db.getMarketPositions("m_a")).toEqual([]);
    db.close();
  });
});
