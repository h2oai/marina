// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_memory.db";

describe("Agent Memory Primitives", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
    conn1.clear();
    conn2.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  // ─── Core Memory ──────────────────────────────────────────────────────

  describe("Core Memory", () => {
    it("should set and get a core memory entry", () => {
      engine.processCommand(conn1.entity!, "memory set goal Find the cipher");
      expect(conn1.lastText()).toContain('"goal" set');
      conn1.clear();
      engine.processCommand(conn1.entity!, "memory get goal");
      expect(conn1.lastText()).toContain("Find the cipher");
    });

    it("should list core memory entries", () => {
      engine.processCommand(conn1.entity!, "memory set goal Find the cipher");
      engine.processCommand(conn1.entity!, "memory set name Alice");
      conn1.clear();
      engine.processCommand(conn1.entity!, "memory list");
      const text = conn1.lastText();
      expect(text).toContain("goal");
      expect(text).toContain("name");
    });

    it("should delete a core memory entry", () => {
      engine.processCommand(conn1.entity!, "memory set goal Find the cipher");
      conn1.clear();
      engine.processCommand(conn1.entity!, "memory delete goal");
      expect(conn1.lastText()).toContain('"goal" deleted');
      conn1.clear();
      engine.processCommand(conn1.entity!, "memory get goal");
      expect(conn1.lastText()).toContain("No memory entry");
    });

    it("should overwrite and track version history", () => {
      engine.processCommand(conn1.entity!, "memory set goal Find the cipher");
      engine.processCommand(conn1.entity!, "memory set goal Solved it");
      conn1.clear();
      engine.processCommand(conn1.entity!, "memory get goal");
      expect(conn1.lastText()).toContain("Solved it");
      expect(conn1.lastText()).toContain("v2");
    });

    it("should show edit history", () => {
      engine.processCommand(conn1.entity!, "memory set goal Find the cipher");
      engine.processCommand(conn1.entity!, "memory set goal Solved it");
      conn1.clear();
      engine.processCommand(conn1.entity!, "memory history goal");
      const text = conn1.lastText();
      expect(text).toContain("Find the cipher");
      expect(text).toContain("Solved it");
    });

    it("should show empty when no entries exist", () => {
      engine.processCommand(conn1.entity!, "memory list");
      expect(conn1.lastText()).toContain("empty");
    });

    it("should be entity-scoped", () => {
      engine.processCommand(conn1.entity!, "memory set goal Alice goal");
      engine.processCommand(conn2.entity!, "memory set goal Bob goal");

      // Alice sees only her value
      conn1.clear();
      engine.processCommand(conn1.entity!, "memory get goal");
      expect(conn1.lastText()).toContain("Alice goal");
      expect(conn1.lastText()).not.toContain("Bob goal");

      // Bob sees only his value
      conn2.clear();
      engine.processCommand(conn2.entity!, "memory get goal");
      expect(conn2.lastText()).toContain("Bob goal");
      expect(conn2.lastText()).not.toContain("Alice goal");
    });

    it("should isolate memory lists between entities", () => {
      engine.processCommand(conn1.entity!, "memory set secret Alice only");
      engine.processCommand(conn2.entity!, "memory set plan Bob only");
      conn1.clear();
      conn2.clear();

      engine.processCommand(conn1.entity!, "memory list");
      expect(conn1.lastText()).toContain("secret");
      expect(conn1.lastText()).not.toContain("plan");

      engine.processCommand(conn2.entity!, "memory list");
      expect(conn2.lastText()).toContain("plan");
      expect(conn2.lastText()).not.toContain("secret");
    });

    it("should show no history when key has no edits", () => {
      engine.processCommand(conn1.entity!, "memory set goal original");
      conn1.clear();
      engine.processCommand(conn1.entity!, "memory history goal");
      expect(conn1.lastText()).toContain("No edit history");
    });
  });

  // ─── Note Extensions ──────────────────────────────────────────────────

  describe("Note Extensions", () => {
    it("should save note with importance via plain words", () => {
      engine.processCommand(conn1.entity!, "note Found a key importance 8");
      expect(conn1.lastText()).toContain("importance=8");
      const note = db.getNote(1);
      expect(note).toBeDefined();
      expect(note!.importance).toBe(8);
    });

    it("should save note with type via plain words", () => {
      engine.processCommand(conn1.entity!, "note The door is locked type fact");
      expect(conn1.lastText()).toContain("type=fact");
      const note = db.getNote(1);
      expect(note).toBeDefined();
      expect(note!.note_type).toBe("fact");
    });

    it("should save note with both importance and type", () => {
      engine.processCommand(
        conn1.entity!,
        "note Critical decision made importance 9 type decision",
      );
      expect(conn1.lastText()).toContain("importance=9");
      expect(conn1.lastText()).toContain("type=decision");
    });

    it("should support legacy !N and #type syntax", () => {
      engine.processCommand(conn1.entity!, "note Legacy note !7 #fact");
      expect(conn1.lastText()).toContain("importance=7");
      expect(conn1.lastText()).toContain("type=fact");
    });

    it("should default to importance=5 and type=observation", () => {
      engine.processCommand(conn1.entity!, "note Just a regular note");
      const note = db.getNote(1);
      expect(note).toBeDefined();
      expect(note!.importance).toBe(5);
      expect(note!.note_type).toBe("observation");
    });

    it("should show importance and type in note list", () => {
      engine.processCommand(conn1.entity!, "note Important fact importance 8 type fact");
      conn1.clear();
      engine.processCommand(conn1.entity!, "note list");
      const text = stripAnsi(conn1.lastText());
      expect(text).toContain("!8");
      expect(text).toContain("[fact]");
    });

    it("should correct a note with supersedes link", () => {
      engine.processCommand(conn1.entity!, "note The door is red");
      conn1.clear();
      engine.processCommand(conn1.entity!, "note correct 1 The door is blue");
      expect(conn1.lastText()).toContain("superseding #1");
      const newNote = db.getNote(2);
      expect(newNote).toBeDefined();
      expect(newNote!.supersedes_id).toBe(1);
      // Check link was created
      const links = db.getNoteLinks(2);
      expect(links.length).toBe(1);
      expect(links[0]!.relationship).toBe("supersedes");
    });

    it("should strip importance/type markers from content", () => {
      engine.processCommand(conn1.entity!, "note Found treasure here !8 #fact");
      const note = db.getNote(1);
      expect(note!.content).toBe("Found treasure here");
      expect(note!.importance).toBe(8);
      expect(note!.note_type).toBe("fact");
    });

    it("should ignore invalid note types", () => {
      engine.processCommand(conn1.entity!, "note test #invalid");
      const note = db.getNote(1);
      expect(note!.note_type).toBe("observation");
      expect(note!.content).toContain("#invalid");
    });
  });

  // ─── Recall (Scored Retrieval) ────────────────────────────────────────

  describe("Recall", () => {
    it("should retrieve notes sorted by combined score", () => {
      engine.processCommand(conn1.entity!, "note The key is hidden !9 #fact");
      engine.processCommand(conn1.entity!, "note Found a key here !3");
      conn1.clear();
      engine.processCommand(conn1.entity!, "recall key");
      const text = stripAnsi(conn1.lastText());
      expect(text).toContain("key");
      expect(text).toContain("0.");
    });

    it("should support --recent flag", () => {
      engine.processCommand(conn1.entity!, "note Old key information !9");
      engine.processCommand(conn1.entity!, "note New key discovery !3");
      conn1.clear();
      engine.processCommand(conn1.entity!, "recall key --recent");
      const text = conn1.lastText();
      expect(text).toContain("key");
    });

    it("should support --important flag", () => {
      engine.processCommand(conn1.entity!, "note Trivial key mention !2");
      engine.processCommand(conn1.entity!, "note Critical key finding !9");
      conn1.clear();
      engine.processCommand(conn1.entity!, "recall key --important");
      const text = conn1.lastText();
      expect(text).toContain("key");
    });

    it("should update last_accessed on recalled notes", () => {
      engine.processCommand(conn1.entity!, "note Searchable content here !5");
      const before = db.getNote(1);
      expect(before!.last_accessed).toBeNull();
      engine.processCommand(conn1.entity!, "recall content");
      const after = db.getNote(1);
      expect(after!.last_accessed).not.toBeNull();
    });

    it("should show message when no results", () => {
      engine.processCommand(conn1.entity!, "recall nonexistentquery");
      expect(conn1.lastText()).toContain("No matching memories");
    });
  });

  // ─── Note Links (Knowledge Graph) ────────────────────────────────────

  describe("Note Links", () => {
    it("should link two notes with a relationship", () => {
      engine.processCommand(conn1.entity!, "note Premise A");
      engine.processCommand(conn1.entity!, "note Conclusion B");
      conn1.clear();
      engine.processCommand(conn1.entity!, "note link 1 2 supports");
      expect(conn1.lastText()).toContain("Linked note #1 -> #2 (supports)");
    });

    it("should trace the graph from a note", () => {
      engine.processCommand(conn1.entity!, "note Root idea");
      engine.processCommand(conn1.entity!, "note Supporting evidence");
      engine.processCommand(conn1.entity!, "note Related concept");
      engine.processCommand(conn1.entity!, "note link 1 2 supports");
      engine.processCommand(conn1.entity!, "note link 2 3 related_to");
      conn1.clear();
      engine.processCommand(conn1.entity!, "note trace 1");
      const text = conn1.lastText();
      expect(text).toContain("Root idea");
      expect(text).toContain("Supporting evidence");
      expect(text).toContain("Related concept");
    });

    it("should show graph summary", () => {
      engine.processCommand(conn1.entity!, "note Fact one #fact");
      engine.processCommand(conn1.entity!, "note Fact two #fact");
      engine.processCommand(conn1.entity!, "note Decision #decision");
      engine.processCommand(conn1.entity!, "note link 1 2 supports");
      conn1.clear();
      engine.processCommand(conn1.entity!, "note graph");
      const text = stripAnsi(conn1.lastText());
      expect(text).toContain("[fact] 2");
      expect(text).toContain("[decision] 1");
      expect(text).toContain("supports: 1");
    });

    it("should reject invalid relationships", () => {
      engine.processCommand(conn1.entity!, "note A");
      engine.processCommand(conn1.entity!, "note B");
      conn1.clear();
      engine.processCommand(conn1.entity!, "note link 1 2 invalid_rel");
      expect(conn1.lastText()).toContain("Invalid relationship");
    });

    it("should reject links to nonexistent notes", () => {
      engine.processCommand(conn1.entity!, "note A");
      conn1.clear();
      engine.processCommand(conn1.entity!, "note link 1 999 supports");
      expect(conn1.lastText()).toContain("not found");
    });
  });

  // ─── Reflect ──────────────────────────────────────────────────────────

  describe("Reflect", () => {
    it("should create an episode-type note linked to sources", () => {
      // Create several high-importance notes
      for (let i = 0; i < 5; i++) {
        engine.processCommand(conn1.entity!, `note Important observation number ${i} !8`);
      }
      conn1.clear();
      engine.processCommand(conn1.entity!, "reflect");
      const text = conn1.lastText();
      expect(text).toContain("Reflection Created");
      expect(text).toContain("episode");
      // Check the reflection note
      const notes = db.getNotesByEntity("Alice");
      const reflection = notes.find((n) => n.note_type === "episode");
      expect(reflection).toBeDefined();
      expect(reflection!.importance).toBe(9);
    });

    it("should filter by topic when provided", () => {
      engine.processCommand(conn1.entity!, "note The key opens doors !7 #fact");
      engine.processCommand(conn1.entity!, "note Keys are important !8 #fact");
      engine.processCommand(conn1.entity!, "note Another key discovery !7");
      engine.processCommand(conn1.entity!, "note Unrelated stuff !6");
      conn1.clear();
      engine.processCommand(conn1.entity!, "reflect key");
      const text = conn1.lastText();
      expect(text).toContain("Reflection Created");
    });

    it("should require at least 2 source notes", () => {
      engine.processCommand(conn1.entity!, "note One thing !8");
      conn1.clear();
      engine.processCommand(conn1.entity!, "reflect");
      expect(conn1.lastText()).toContain("Not enough notes");
    });

    it("should create part_of links from sources to reflection", () => {
      for (let i = 0; i < 3; i++) {
        engine.processCommand(conn1.entity!, `note High importance item ${i} !8`);
      }
      engine.processCommand(conn1.entity!, "reflect");
      // The reflection note ID should be 4 (after 3 source notes)
      const links = db.getNoteLinks(4);
      const partOfLinks = links.filter((l) => l.relationship === "part_of");
      expect(partOfLinks.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Memory Pools ─────────────────────────────────────────────────────

  describe("Memory Pools", () => {
    it("should create a pool", () => {
      engine.processCommand(conn1.entity!, "pool create team-kb");
      expect(conn1.lastText()).toContain('"team-kb" created');
    });

    it("should add notes to a pool and recall from it", () => {
      engine.processCommand(conn1.entity!, "pool create team-kb");
      engine.processCommand(conn1.entity!, "pool team-kb add Shared finding about keys !7");
      conn1.clear();
      engine.processCommand(conn1.entity!, "pool team-kb recall finding");
      const text = conn1.lastText();
      expect(text).toContain("Shared finding");
    });

    it("should list all pools", () => {
      engine.processCommand(conn1.entity!, "pool create alpha");
      engine.processCommand(conn1.entity!, "pool create beta");
      conn1.clear();
      engine.processCommand(conn1.entity!, "pool list");
      const text = conn1.lastText();
      expect(text).toContain("alpha");
      expect(text).toContain("beta");
    });

    it("should scope retrieval to pool only", () => {
      engine.processCommand(conn1.entity!, "pool create scoped");
      engine.processCommand(conn1.entity!, "pool scoped add Pool specific finding");
      engine.processCommand(conn1.entity!, "note Personal finding about something");
      conn1.clear();
      // Recall from pool should only find pool notes
      engine.processCommand(conn1.entity!, "pool scoped recall finding");
      const text = conn1.lastText();
      expect(text).toContain("Pool specific finding");
      expect(text).not.toContain("Personal finding");
    });

    it("should not create duplicate pools", () => {
      engine.processCommand(conn1.entity!, "pool create mypool");
      conn1.clear();
      engine.processCommand(conn1.entity!, "pool create mypool");
      expect(conn1.lastText()).toContain("already exists");
    });
  });

  // ─── DB Methods Direct ────────────────────────────────────────────────

  describe("DB Methods Direct", () => {
    it("setCoreMemory/getCoreMemory should work", () => {
      db.setCoreMemory("Alice", "goal", "Find the cipher");
      const entry = db.getCoreMemory("Alice", "goal");
      expect(entry).toBeDefined();
      expect(entry!.value).toBe("Find the cipher");
      expect(entry!.version).toBe(1);
    });

    it("setCoreMemory should log history on update", () => {
      db.setCoreMemory("Alice", "goal", "v1");
      db.setCoreMemory("Alice", "goal", "v2");
      const history = db.getCoreMemoryHistory("Alice", "goal");
      expect(history.length).toBe(1);
      expect(history[0]!.old_value).toBe("v1");
      expect(history[0]!.new_value).toBe("v2");
    });

    it("createNoteLink/getNoteLinks should work", () => {
      const id1 = db.createNote("Alice", "Note A");
      const id2 = db.createNote("Alice", "Note B");
      db.createNoteLink(id1, id2, "supports");
      const links = db.getNoteLinks(id1);
      expect(links.length).toBe(1);
      expect(links[0]!.relationship).toBe("supports");
    });

    it("traceNoteGraph should follow edges", () => {
      const id1 = db.createNote("Alice", "Root");
      const id2 = db.createNote("Alice", "Child");
      const id3 = db.createNote("Alice", "Grandchild");
      db.createNoteLink(id1, id2, "related_to");
      db.createNoteLink(id2, id3, "caused_by");
      const graph = db.traceNoteGraph(id1, 2);
      expect(graph.length).toBe(3);
    });

    it("recallNotes should return scored results", () => {
      db.createNote("Alice", "The key is hidden", undefined, { importance: 9 });
      db.createNote("Alice", "Found a key", undefined, { importance: 3 });
      const results = db.recallNotes("Alice", "key");
      expect(results.length).toBe(2);
      expect(results[0]!.score).toBeDefined();
      // Higher importance should score higher (all else equal)
      expect(results[0]!.importance).toBe(9);
    });

    it("createMemoryPool/addPoolNote/recallPoolNotes should work", () => {
      db.createMemoryPool("p1", "team", "Alice");
      db.addPoolNote("p1", "Alice", "Pool note about keys", 7);
      const results = db.recallPoolNotes("p1", "keys");
      expect(results.length).toBe(1);
      expect(results[0]!.content).toContain("keys");
      expect(results[0]!.pool_id).toBe("p1");
    });

    it("countNoteLinks should count links for entity", () => {
      const id1 = db.createNote("Alice", "First note about linking");
      const id2 = db.createNote("Alice", "Second note about linking");
      db.createNoteLink(id1, id2, "related_to");
      const count = db.countNoteLinks("Alice");
      expect(count).toBeGreaterThan(0);
    });

    it("countLinksForNote should count links for specific note", () => {
      const id1 = db.createNote("Alice", "Hub note for counting");
      const id2 = db.createNote("Alice", "Spoke note one");
      const id3 = db.createNote("Alice", "Spoke note two");
      db.createNoteLink(id1, id2, "related_to");
      db.createNoteLink(id1, id3, "caused_by");
      expect(db.countLinksForNote(id1)).toBe(2);
      expect(db.countLinksForNote(id2)).toBe(1);
    });

    it("adjustNoteImportance should protect well-linked notes from early decay", () => {
      // Create a well-linked note (3+ links) older than 7 days
      const eightDaysAgo = Date.now() - 8 * 86_400_000;
      const hubId = db.createNote("Alice", "Hub insight about everything", undefined, {
        importance: 5,
      });
      const spoke1 = db.createNote("Alice", "Related idea one");
      const spoke2 = db.createNote("Alice", "Related idea two");
      const spoke3 = db.createNote("Alice", "Related idea three");
      db.createNoteLink(hubId, spoke1, "related_to");
      db.createNoteLink(hubId, spoke2, "related_to");
      db.createNoteLink(hubId, spoke3, "related_to");

      // Backdate the hub note (cast to bypass private access in test)
      // biome-ignore lint/suspicious/noExplicitAny: test-only raw DB access
      (db as any).db.run("UPDATE notes SET created_at = ? WHERE id = ?", [eightDaysAgo, hubId]);

      // Run decay
      db.adjustNoteImportance();

      // Well-linked note should be protected (not decayed at 7 days)
      const hub = db.getNote(hubId);
      expect(hub!.importance).toBe(5);
    });
  });

  // ─── Orient Command ────────────────────────────────────────────────────

  describe("Orient Command", () => {
    it("should produce a briefing with core memory", () => {
      engine.processCommand(conn1.entity!, "memory set goal Explore the grid");
      conn1.clear();
      engine.processCommand(conn1.entity!, "orient");
      const text = conn1.lastText();
      expect(text).toContain("Orientation Briefing");
      expect(text).toContain("Core Memory");
      expect(text).toContain("goal");
      expect(text).toContain("Explore the grid");
    });

    it("should show recent notes in briefing", () => {
      engine.processCommand(conn1.entity!, "note The vault code is 7249 importance 8");
      conn1.clear();
      engine.processCommand(conn1.entity!, "orient");
      const text = conn1.lastText();
      expect(text).toContain("Recent Notes");
      expect(text).toContain("vault code");
    });

    it("should show memory health stats", () => {
      engine.processCommand(conn1.entity!, "note First observation");
      engine.processCommand(conn1.entity!, "note Second observation");
      conn1.clear();
      engine.processCommand(conn1.entity!, "orient");
      const text = conn1.lastText();
      expect(text).toContain("Memory Health");
      expect(text).toContain("Total notes:");
    });

    it("should work via status alias", () => {
      conn1.clear();
      engine.processCommand(conn1.entity!, "status");
      expect(conn1.lastText()).toContain("Orientation Briefing");
    });
  });

  // ─── Intent-Aware Recall ───────────────────────────────────────────────

  describe("Intent-Aware Recall", () => {
    it("should recall with default weights for simple queries", () => {
      engine.processCommand(conn1.entity!, "note The cipher key is 42 importance 8");
      conn1.clear();
      engine.processCommand(conn1.entity!, "recall cipher key");
      expect(conn1.lastText()).toContain("cipher key");
    });

    it("should still respect explicit recent modifier", () => {
      engine.processCommand(conn1.entity!, "note Found a map importance 5");
      conn1.clear();
      engine.processCommand(conn1.entity!, "recall map recent");
      expect(conn1.lastText()).toContain("map");
    });

    it("should still respect explicit important modifier", () => {
      engine.processCommand(conn1.entity!, "note Critical discovery importance 9");
      conn1.clear();
      engine.processCommand(conn1.entity!, "recall discovery important");
      expect(conn1.lastText()).toContain("discovery");
    });
  });

  // ─── Graph-Enhanced Recall ─────────────────────────────────────────────

  describe("Graph-Enhanced Recall", () => {
    it("should surface linked notes via spreading activation", () => {
      // Create a note that matches the query
      engine.processCommand(
        conn1.entity!,
        "note The main encryption cipher is AES-256 importance 8",
      );
      // Create a linked note that does NOT match the query keywords
      engine.processCommand(conn1.entity!, "note The backup protocol uses RSA-4096 importance 7");
      conn1.clear();

      // Link them manually via the note link subcommand
      // First get the IDs
      engine.processCommand(conn1.entity!, "note list");
      const listText = conn1.lastText();
      // Extract note IDs from the list
      const ids = [...listText.matchAll(/#(\d+)/g)].map((m) => m[1]);
      if (ids.length >= 2) {
        conn1.clear();
        engine.processCommand(conn1.entity!, `note link ${ids[0]} ${ids[1]} related_to`);
      }

      conn1.clear();
      // Recall for "cipher" — should find the AES note directly, and may boost the RSA note via graph link
      engine.processCommand(conn1.entity!, "recall cipher");
      const text = conn1.lastText();
      expect(text).toContain("AES-256");
    });
  });
});
