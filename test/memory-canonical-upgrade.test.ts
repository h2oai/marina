// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDurableTwin } from "../src/memory/legacy-projection";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { closeWorldMemoryService } from "../src/memory/world-service";
import { MarinaDB } from "../src/persistence/database";
import { numericMemoryIntegrity } from "../src/persistence/db-memory-projections";
import { exportState, importState } from "../src/persistence/export-import";
import { SCHEMA_BASELINE } from "../src/persistence/schema-baseline";
import type { MemoryRecord } from "../src/sdk/memory-types";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "marina-canonical-upgrade-"));
  directories.push(dir);
  const path = join(dir, "old.db"),
    old = new Database(path);
  old.exec(SCHEMA_BASELINE);
  old.exec("PRAGMA foreign_keys=ON");
  old.run("INSERT INTO users(id,name,created_at,last_login) VALUES ('alice','Alice',1,1)");
  old.run(
    "INSERT INTO principals(principal_id,principal_type,display_name,created_at) VALUES ('alice','human','Alice',1)",
  );
  old.run(
    "INSERT INTO memory_spaces(id,owner_id,name,created_at) VALUES ('resident','alice','resident',1)",
  );
  function paired(handle: number, recordId: string, text: string) {
    old.run(
      "INSERT INTO notes(id,entity_name,content,created_at) VALUES (?,'Alice',?,1),(?,'memory:alice',?,1)",
      [handle, text, handle + 1, text],
    );
    const metadata = JSON.stringify({ legacy_note_id: handle });
    old.run(
      "INSERT INTO memory_records(id,space_id,version,current_note_id,metadata,created_at) VALUES (?,'resident',1,?,?,1)",
      [recordId, handle + 1, metadata],
    );
    old.run(
      "INSERT INTO memory_record_versions(record_id,version,note_id,attributes) VALUES (?,1,?,?)",
      [
        recordId,
        handle + 1,
        JSON.stringify({ metadata: JSON.parse(metadata), source_ids: [], depends_on: [] }),
      ],
    );
    old.run("INSERT INTO memory_note_projections(note_id,record_id) VALUES (?,?)", [
      handle,
      recordId,
    ]);
  }
  paired(10, "corrected", "old assertion");
  paired(30, "deleted", "retired assertion");
  old.run(
    "INSERT INTO notes(id,entity_name,content,supersedes_id,created_at) VALUES (12,'Alice','pending correction',10,2)",
  );
  old.run("UPDATE notes SET verification_status='superseded' WHERE id=10");
  old.run(
    "INSERT INTO note_sources(note_id,url,retrieved_at,credibility,captured_by) VALUES (12,'https://example.test/evidence',2,0,'Alice')",
  );
  old.run(
    "INSERT INTO note_verifications(note_id,verifier,status,confidence,created_at) VALUES (12,'Alice','disputed',0.1,2)",
  );
  old.run("UPDATE notes SET verification_status='disputed',confidence=0.1 WHERE id=12");
  const relationMetadata = JSON.stringify({
    kind: "legacy-link",
    legacy_source_note_id: 10,
    legacy_target_note_id: 30,
    relationship: "supports",
  });
  old.run(
    "INSERT INTO notes(id,entity_name,content,created_at) VALUES (70,'memory:alice','corrected -> deleted',1)",
  );
  old.run(
    "INSERT INTO memory_records(id,space_id,version,current_note_id,metadata,created_at) VALUES ('relation','resident',1,70,?,1)",
    [relationMetadata],
  );
  old.run(
    "INSERT INTO memory_record_versions(record_id,version,note_id,attributes) VALUES ('relation',1,70,?)",
    [JSON.stringify({ metadata: JSON.parse(relationMetadata), source_ids: [], depends_on: [] })],
  );
  old.run(
    "INSERT INTO note_links(source_id,target_id,relationship,created_at) VALUES (10,30,'supports',1)",
  );
  old.run("DELETE FROM note_links WHERE target_id=30");
  old.run("DELETE FROM notes WHERE id=30");
  old.run(
    "INSERT INTO notes(id,entity_name,content,created_at) VALUES (50,'Anonymous','namespace assertion',1)",
  );
  return { path, old };
}

test("version 137 upgrades pending corrections, reviews, sources and deletions atomically", async () => {
  const { path, old } = fixture();
  old.close();
  const db = new MarinaDB(path);
  try {
    expect(findDurableTwin(db, 10)).toMatchObject({ recordId: "corrected", version: 1 });
    expect(findDurableTwin(db, 12)).toMatchObject({ recordId: "corrected", version: 4 });
    expect(db.getNote(10)?.content).toBe("old assertion");
    expect(db.getNote(12)).toMatchObject({
      content: "pending correction",
      verification_status: "disputed",
    });
    expect(db.getNote(30)).toBeUndefined();
    const read = async (id: string, version?: number) =>
      (
        await residentMemoryOperation(db, "Alice", {
          operation: "get",
          id,
          input: version ? { version } : undefined,
        })
      ).result as MemoryRecord;
    expect((await read("corrected", 1)).content).toBe("old assertion");
    expect((await read("corrected")).metadata.legacy_sources).toMatchObject([{ credibility: 0 }]);
    expect((await read("corrected")).valid_time?.until).toBeNumber();
    expect((await read("deleted")).content).toBe("[deleted legacy note #30]");
    expect((await read("relation")).valid_time?.until).toBeNumber();
    expect(db.getNote(50)?.content).toBe("namespace assertion");
    expect(findDurableTwin(db, 50)).toBeDefined();
    expect(db.getUserByName("Anonymous")).toBeUndefined();
    expect(numericMemoryIntegrity(db.memoryRepository().raw)).toEqual({
      unconverted: 0,
      broken: 0,
      duplicateBodies: 0,
    });
    expect(db.memoryRepository().raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db
        .memoryRepository()
        .raw.query("SELECT name FROM sqlite_schema WHERE name LIKE 'legacy_memory_%'")
        .all(),
    ).toEqual([]);
  } finally {
    await closeWorldMemoryService(db);
    db.close();
  }
  const reopened = new MarinaDB(path);
  try {
    expect(findDurableTwin(reopened, 12)?.version).toBe(4);
  } finally {
    reopened.close();
  }
});

test("a failed conversion preserves schema 137, original text and every pending intent", () => {
  const { path, old } = fixture();
  old.exec(
    "CREATE TRIGGER reject_upgrade BEFORE INSERT ON memory_record_versions WHEN NEW.version>1 BEGIN SELECT RAISE(ABORT,'injected conversion failure'); END",
  );
  const before = old.query("SELECT * FROM legacy_memory_outbox ORDER BY id").all();
  old.close();
  expect(() => new MarinaDB(path)).toThrow("Migration 138 failed");
  const unchanged = new Database(path);
  try {
    expect(unchanged.query("SELECT max(version) v FROM schema_version").get()).toEqual({ v: 137 });
    expect(unchanged.query("SELECT content FROM notes WHERE id=10").get()).toEqual({
      content: "old assertion",
    });
    expect(unchanged.query("SELECT * FROM legacy_memory_outbox ORDER BY id").all()).toEqual(before);
    expect(
      unchanged.query("SELECT name FROM sqlite_schema WHERE name='numeric_notes'").get(),
    ).toBeNull();
    unchanged.exec("DROP TRIGGER reject_upgrade");
  } finally {
    unchanged.close();
  }
  const recovered = new MarinaDB(path);
  recovered.close();
});

test("upgrade preserves oversized historical text and suspended ownership without weakening new writes", () => {
  const { path, old } = fixture();
  const longText = "historical ".repeat(7000);
  old.run("INSERT INTO notes(id,entity_name,content,created_at) VALUES (90,'Alice',?,123)", [
    longText,
  ]);
  old.run("UPDATE principals SET status='suspended' WHERE principal_id='alice'");
  old.close();
  const db = new MarinaDB(path);
  try {
    expect(db.getNote(90)?.content).toBe(longText);
    expect(db.getPrincipal("human", "Alice")?.status).toBe("suspended");
    expect(() => db.createNote("Alice", "new unauthorized write")).toThrow();
    expect(() => db.createNote("NewNamespace", longText)).toThrow();
    expect(db.getNotesByEntity("NewNamespace")).toEqual([]);
    expect(numericMemoryIntegrity(db.memoryRepository().raw)).toEqual({
      unconverted: 0,
      broken: 0,
      duplicateBodies: 0,
    });
  } finally {
    db.close();
  }
});

test("old snapshots restore the same canonical identities and pending retirements", () => {
  const { path, old } = fixture();
  old.close();
  const snapshot = exportState(path);
  const target = join(directories.at(-1)!, "restored.db");
  const empty = new MarinaDB(target);
  empty.close();
  expect(importState(target, snapshot).errors).toEqual([]);
  const restored = new MarinaDB(target);
  try {
    expect(findDurableTwin(restored, 12)).toMatchObject({ recordId: "corrected", version: 4 });
    expect(restored.getNote(12)?.content).toBe("pending correction");
    expect(restored.getNote(30)).toBeUndefined();
    expect(
      restored
        .memoryRepository()
        .raw.query(
          "SELECT n.content FROM memory_records r JOIN notes n ON n.id=r.current_note_id WHERE r.id='deleted'",
        )
        .get(),
    ).toEqual({ content: "[deleted legacy note #30]" });
    expect(numericMemoryIntegrity(restored.memoryRepository().raw)).toEqual({
      unconverted: 0,
      broken: 0,
      duplicateBodies: 0,
    });
  } finally {
    restored.close();
  }
});
