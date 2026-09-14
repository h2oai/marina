// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import { buildFtsQuery, FTS_STOP_WORDS, isFtsStopWord } from "../src/persistence/fts";
import { MIGRATIONS } from "../src/persistence/schema";
import { cleanupDb } from "./helpers";

describe("FTS5 Board Search", () => {
  let db: MarinaDB;
  const dbPath = `/tmp/marina-fts5-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);

    // Create a board
    db.createBoard({
      id: "board:test",
      name: "test",
    });

    // Create posts with varied content
    db.createBoardPost({
      boardId: "board:test",
      authorId: "e_1",
      authorName: "Alice",
      title: "Introduction to Quantum Computing",
      body: "Quantum computing uses qubits instead of classical bits to perform calculations.",
      tags: ["science", "computing"],
    });

    db.createBoardPost({
      boardId: "board:test",
      authorId: "e_2",
      authorName: "Bob",
      title: "Classical Music Review",
      body: "The symphony was performed brilliantly last night at the concert hall.",
      tags: ["music", "review"],
    });

    db.createBoardPost({
      boardId: "board:test",
      authorId: "e_1",
      authorName: "Alice",
      title: "Computing History",
      body: "The history of computing spans from the abacus to modern quantum processors.",
      tags: ["history", "computing"],
    });
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should find posts by title keyword", () => {
    const results = db.searchBoardPosts("board:test", "Quantum");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title.includes("Quantum"))).toBe(true);
  });

  it("should find posts by body keyword", () => {
    const results = db.searchBoardPosts("board:test", "symphony");
    expect(results.length).toBe(1);
    expect(results[0]!.author_name).toBe("Bob");
  });

  it("should find posts matching multiple terms", () => {
    const results = db.searchBoardPosts("board:test", "computing history");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The post about Computing History should rank highly
    expect(results.some((r) => r.title === "Computing History")).toBe(true);
  });

  it("should return empty for non-matching queries", () => {
    const results = db.searchBoardPosts("board:test", "dinosaur");
    expect(results.length).toBe(0);
  });

  it("should return empty for empty queries", () => {
    const results = db.searchBoardPosts("board:test", "");
    expect(results.length).toBe(0);
  });

  it("should handle special characters safely", () => {
    const results = db.searchBoardPosts("board:test", "test' OR 1=1 --");
    // Should not crash and should return results or empty
    expect(Array.isArray(results)).toBe(true);
  });

  it("should find posts by tag content", () => {
    const results = db.searchBoardPosts("board:test", "computing");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("should rebuild search index", () => {
    // Should not throw
    db.rebuildBoardSearchIndex();

    // Verify search still works after rebuild
    const results = db.searchBoardPosts("board:test", "Quantum");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("should keep FTS in sync after new posts", () => {
    db.createBoardPost({
      boardId: "board:test",
      authorId: "e_3",
      authorName: "Charlie",
      title: "Blockchain Networks",
      body: "Decentralized ledger technology is transforming finance.",
      tags: ["blockchain"],
    });

    const results = db.searchBoardPosts("board:test", "blockchain");
    expect(results.length).toBe(1);
    expect(results[0]!.author_name).toBe("Charlie");
  });
});

describe("FTS5 query builder (stop words + injection safety)", () => {
  it("drops function words when a content token remains, in both modes", () => {
    expect(buildFtsQuery("what is the deployment", "or")).toBe('"deployment"');
    expect(buildFtsQuery("the deployment runbook", "and")).toBe('"deployment" "runbook"');
  });

  it("keeps a query made only of stop words instead of returning nothing", () => {
    expect(buildFtsQuery("the", "or")).toBe('"the"');
    expect(buildFtsQuery("what is it", "and")).toBe('"what" "is" "it"');
  });

  it("can be told to keep stop words", () => {
    expect(buildFtsQuery("the deployment", "or", { stopWords: false })).toBe(
      '"the" OR "deployment"',
    );
  });

  it("neutralizes FTS5 syntax by quoting every token", () => {
    expect(buildFtsQuery("test' OR 1=1 --", "and")).toBe('"test" "1" "1"');
    expect(buildFtsQuery("col:value ^prefix -neg", "or")).toBe(
      '"col" OR "value" OR "prefix" OR "neg"',
    );
    expect(buildFtsQuery("!!! ...", "or")).toBeNull();
  });

  it("classifies stop words case-insensitively", () => {
    expect(isFtsStopWord("The")).toBe(true);
    expect(isFtsStopWord("deployment")).toBe(false);
    expect(FTS_STOP_WORDS.size).toBeGreaterThan(40);
  });
});

describe("FTS5 notes: porter stemming (migration 112)", () => {
  let db: MarinaDB;
  const dbPath = `/tmp/marina-fts5-notes-test-${Date.now()}.db`;
  const entity = "porter-tester";
  let runbook: number;
  let ticket: number;
  let other: number;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    runbook = db.createNote(
      entity,
      "The deployment runbook lives in ops/runbooks/deploy.md",
      undefined,
      { skipDedup: true },
    );
    ticket = db.createNote(entity, "ticket abc-1234 tracks the e_42 regression", undefined, {
      skipDedup: true,
    });
    other = db.createNote(entity, "ticket abc-9999 tracks the e_7 memory leak", undefined, {
      skipDedup: true,
    });
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("uses the porter tokenizer on the notes index", () => {
    const ftsNotesMigration = MIGRATIONS.find((m) => m.version === 112);
    expect(ftsNotesMigration?.sql).toContain("tokenize='porter unicode61'");
    expect(ftsNotesMigration?.sql).toContain("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
  });

  it("matches morphological variants: runbooks -> runbook, deploying -> deployment", () => {
    expect(db.recallNotes(entity, "runbooks").map((n) => n.id)).toEqual([runbook]);
    expect(db.recallNotes(entity, "deploying").map((n) => n.id)).toEqual([runbook]);
    expect(db.searchNotes(entity, "runbooks").map((n) => n.id)).toEqual([runbook]);
  });

  it("ranks 'the deployment' like 'deployment'", () => {
    const bare = db.recallNotes(entity, "deployment").map((n) => n.id);
    const withArticle = db.recallNotes(entity, "the deployment").map((n) => n.id);
    expect(bare).toEqual([runbook]);
    expect(withArticle).toEqual(bare);
    expect(db.recallNotes(entity, "what is the deployment runbook")[0]!.id).toBe(runbook);
  });

  it("still matches exact identifiers", () => {
    expect(db.recallNotes(entity, "e_42").map((n) => n.id)).toEqual([ticket]);
    expect(db.recallNotes(entity, "abc-1234")[0]!.id).toBe(ticket);
    expect(db.searchNotes(entity, "abc-1234").map((n) => n.id)).toEqual([ticket]);
    expect(db.searchNotes(entity, "e_7").map((n) => n.id)).toEqual([other]);
  });

  it("keeps the index in sync through update and delete triggers", () => {
    const raw = new Database(dbPath);
    try {
      raw.run("UPDATE notes SET content = ? WHERE id = ?", [
        "The rollback playbook lives in ops/runbooks/rollback.md",
        runbook,
      ]);
    } finally {
      raw.close();
    }
    expect(db.recallNotes(entity, "deployment").map((n) => n.id)).toEqual([]);
    expect(db.recallNotes(entity, "playbooks").map((n) => n.id)).toEqual([runbook]);
    expect(db.deleteNote(runbook, entity)).toBe(true);
    expect(db.recallNotes(entity, "playbook")).toEqual([]);
  });
});
