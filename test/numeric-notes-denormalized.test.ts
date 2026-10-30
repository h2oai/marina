// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { createTestEngine } from "./engine-fixture";

/**
 * Migration 187 stores the two facts `numeric_notes` used to derive per row
 * (`notes.content_id`, `notes.version_note`) and maintains them by trigger. The
 * view must read exactly what the original five-probe definition read, after
 * every write path that can move them — so the original is recreated here as
 * a second view and the two are compared row for row after each step.
 */
const LEGACY_VIEW = `CREATE TEMP VIEW numeric_notes_legacy AS
 SELECT n.id,n.entity_name,n.room_id,coalesce(c.content,n.content) AS content,n.created_at,
 coalesce(c.importance,n.importance) AS importance,n.last_accessed,n.note_type,n.pool_id,n.supersedes_id,
 n.recall_count,n.tier,n.confidence,n.verification_status,n.claim_key,
 coalesce(c.id,n.id) AS content_id
 FROM notes n LEFT JOIN memory_note_projections p ON p.note_id=n.id
 LEFT JOIN memory_records r ON r.id=p.record_id
 LEFT JOIN memory_record_versions v ON v.record_id=p.record_id AND v.version=p.version
 LEFT JOIN notes c ON c.id=CASE WHEN p.version IS NULL THEN r.current_note_id ELSE v.note_id END
 WHERE n.entity_name NOT LIKE 'memory:%' AND NOT EXISTS(SELECT 1 FROM memory_record_versions rv WHERE rv.note_id=n.id)`;

describe("numeric_notes reads what its original definition read", () => {
  it("after create, correct, delete and consolidate, row for row; one probe per row", async () => {
    const world = createTestEngine();
    try {
      const raw = world.db.memoryRepository().raw;
      raw.exec(LEGACY_VIEW);
      const same = (step: string) => {
        const diff = raw
          .query(
            `SELECT count(*) AS n FROM (
               SELECT * FROM numeric_notes EXCEPT SELECT * FROM numeric_notes_legacy
               UNION ALL
               SELECT * FROM numeric_notes_legacy EXCEPT SELECT * FROM numeric_notes)`,
          )
          .get() as { n: number };
        expect({ step, differing: diff.n }).toEqual({ step, differing: 0 });
        const rows = raw.query("SELECT count(*) AS n FROM numeric_notes").get() as { n: number };
        return rows.n;
      };
      const me = world.login("ada");
      const run = (command: string) => world.engine.processCommand(me.entityId, command);
      await run("note the harbour tide turns at dawn");
      await run("note amber lanterns along the pier");
      await run("note the harbour tide turns at dawn"); // verbatim duplicate: dedup path
      const afterCreate = same("create");
      expect(afterCreate).toBeGreaterThan(0);
      const first = raw
        .query("SELECT min(id) AS id FROM numeric_notes WHERE entity_name='ada'")
        .get() as {
        id: number;
      };
      // A correction revises the record: a new version note, current_note_id moves
      // to it, the new text gets a new numeric address, and the OLD address is
      // pinned to the version it described (it keeps reading "dawn").
      await run(`note correct ${first.id} the harbour tide turns at dusk`);
      same("correct");
      const texts = (
        raw
          .query("SELECT id, content FROM numeric_notes WHERE entity_name='ada' ORDER BY id")
          .all() as {
          id: number;
          content: string;
        }[]
      ).map((r) => r.content);
      expect(texts.some((t) => t.includes("dusk"))).toBe(true);
      expect(
        (
          raw.query("SELECT content FROM numeric_notes WHERE id=?").get(first.id) as {
            content: string;
          }
        ).content,
      ).toContain("dawn");
      await run("memory recall harbour"); // touches last_accessed: no FTS churn, no view drift
      same("recall");
      await run(`note delete ${first.id}`);
      same("delete");
      const ids = (
        raw.query("SELECT id FROM numeric_notes WHERE entity_name='ada' ORDER BY id").all() as {
          id: number;
        }[]
      ).map((r) => r.id);
      if (ids.length >= 2) await run(`note consolidate ${ids.slice(0, 2).join(" ")}`);
      same("consolidate");
      // Backfill parity: recompute the stored facts from scratch and compare.
      const stored = raw
        .query("SELECT id, content_id, version_note FROM notes ORDER BY id")
        .all() as { id: number; content_id: number | null; version_note: number }[];
      const derived = raw
        .query(
          `SELECT n.id,
             (SELECT CASE WHEN p.version IS NULL THEN r.current_note_id ELSE v.note_id END
              FROM memory_note_projections p
              LEFT JOIN memory_records r ON r.id=p.record_id
              LEFT JOIN memory_record_versions v ON v.record_id=p.record_id AND v.version=p.version
              WHERE p.note_id=n.id) AS content_id,
             EXISTS(SELECT 1 FROM memory_record_versions rv WHERE rv.note_id=n.id) AS version_note
           FROM notes n ORDER BY n.id`,
        )
        .all() as { id: number; content_id: number | null; version_note: number }[];
      expect(stored).toEqual(derived);
      // The view is one optional probe: no projection/record/version tables, no subquery.
      const plan = (
        raw
          .query("EXPLAIN QUERY PLAN SELECT count(*) FROM numeric_notes WHERE entity_name=?")
          .all() as {
          detail: string;
        }[]
      )
        .map((r) => r.detail)
        .join(" ; ");
      expect(plan).not.toMatch(/SEARCH (p|r|v|rv) /);
      expect(plan).not.toMatch(/SUBQUERY/);
    } finally {
      await world.dispose();
    }
  });

  it("notes_au re-indexes FTS on content changes only", async () => {
    const world = createTestEngine();
    try {
      const raw = world.db.memoryRepository().raw;
      const trigger = raw.query("SELECT sql FROM sqlite_master WHERE name='notes_au'").get() as {
        sql: string;
      };
      expect(trigger.sql).toMatch(/AFTER UPDATE OF content ON notes/);
      const me = world.login("bo");
      await world.engine.processCommand(me.entityId, "note a lighthouse on the breakwater");
      const hits = () =>
        (
          raw
            .query("SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?")
            .get("breakwater") as {
            n: number;
          }
        ).n;
      expect(hits()).toBe(1);
      // The text lives on the canonical version note (the numeric handle is an empty
      // address); touching a non-content column leaves FTS alone, a content change follows.
      const row = raw
        .query("SELECT rowid AS id FROM notes_fts WHERE notes_fts MATCH ?")
        .get("breakwater") as {
        id: number;
      };
      raw.run("UPDATE notes SET last_accessed=? WHERE id=?", [Date.now(), row.id]);
      expect(hits()).toBe(1);
      raw.run("UPDATE notes SET content='a lighthouse on the jetty' WHERE id=?", [row.id]);
      expect(hits()).toBe(0);
      expect(
        (
          raw.query("SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?").get("jetty") as {
            n: number;
          }
        ).n,
      ).toBe(1);
    } finally {
      await world.dispose();
    }
  });
});
