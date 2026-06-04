import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
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
