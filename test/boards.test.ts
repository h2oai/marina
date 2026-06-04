import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { setRank } from "../src/engine/permissions";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_boards.db";

describe("Boards", () => {
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

  it("should create a board", () => {
    engine.processCommand(conn1.entity!, "board create general");
    expect(conn1.lastText()).toContain('Created board "general"');
  });

  it("should list boards", () => {
    engine.processCommand(conn1.entity!, "board create general");
    engine.processCommand(conn1.entity!, "board create announcements");
    conn1.clear();
    engine.processCommand(conn1.entity!, "board list");
    const text = conn1.lastText();
    expect(text).toContain("announcements");
    expect(text).toContain("general");
  });

  it("should post to a board", () => {
    engine.processCommand(conn1.entity!, "board create general");
    conn1.clear();
    engine.processCommand(conn1.entity!, "board post general My First Post | This is the body");
    expect(stripAnsi(conn1.lastText())).toContain("Posted #");
    expect(stripAnsi(conn1.lastText())).toContain("My First Post");
  });

  it("should read posts from a board", () => {
    engine.processCommand(conn1.entity!, "board create general");
    engine.processCommand(conn1.entity!, "board post general Hello World | Body text here");
    conn1.clear();
    engine.processCommand(conn1.entity!, "board read general");
    const text = conn1.lastText();
    expect(text).toContain("Hello World");
    expect(text).toContain("Alice");
  });

  it("should read a specific post", () => {
    engine.processCommand(conn1.entity!, "board create general");
    engine.processCommand(conn1.entity!, "board post general Test Title | Detailed body");
    conn1.clear();
    engine.processCommand(conn1.entity!, "board read general 1");
    const text = conn1.lastText();
    expect(text).toContain("Test Title");
    expect(text).toContain("Detailed body");
  });

  it("should reply to a post", () => {
    engine.processCommand(conn1.entity!, "board create general");
    engine.processCommand(conn1.entity!, "board post general Original | Original body");
    conn2.clear();
    engine.processCommand(conn2.entity!, "board reply 1 This is my reply");
    expect(stripAnsi(conn2.lastText())).toContain("Reply #2 posted to #1");
  });

  it("should search posts", () => {
    engine.processCommand(conn1.entity!, "board create general");
    engine.processCommand(conn1.entity!, "board post general Alpha | Alpha body");
    engine.processCommand(conn1.entity!, "board post general Beta | Beta body");
    conn1.clear();
    engine.processCommand(conn1.entity!, "board search general Alpha");
    const text = conn1.lastText();
    expect(text).toContain("Alpha");
    expect(text).not.toContain("Beta");
  });

  it("should vote on posts", () => {
    engine.processCommand(conn1.entity!, "board create general");
    engine.processCommand(conn1.entity!, "board post general Vote Test | Body");
    conn1.clear();
    engine.processCommand(conn1.entity!, "board vote 1 up");
    expect(conn1.lastText()).toContain("Total: 1");

    conn2.clear();
    engine.processCommand(conn2.entity!, "board vote 1 up");
    expect(conn2.lastText()).toContain("Total: 2");
  });

  it("should pin and archive posts", () => {
    engine.processCommand(conn1.entity!, "board create general");
    engine.processCommand(conn1.entity!, "board post general Pinnable | Body");

    // Set Alice to architect rank for pin permission
    const alice = engine.entities.get(conn1.entity!)!;
    setRank(alice, 3);

    conn1.clear();
    engine.processCommand(conn1.entity!, "board pin 1");
    expect(conn1.lastText()).toContain("Pinned post #1");

    conn1.clear();
    engine.processCommand(conn1.entity!, "board archive 1");
    expect(conn1.lastText()).toContain("Archived post #1");
  });

  it("should prevent duplicate board names", () => {
    engine.processCommand(conn1.entity!, "board create general");
    conn1.clear();
    engine.processCommand(conn1.entity!, "board create general");
    expect(conn1.lastText()).toContain("already exists");
  });

  it("board manager should work directly", () => {
    const bm = engine.boardManager!;
    const board = bm.createBoard({ name: "test-board" });
    expect(board.name).toBe("test-board");

    const post = bm.createPost({
      boardId: board.id,
      authorId: "e_1",
      authorName: "Test",
      title: "Direct Post",
      body: "Posted directly",
    });
    expect(post.title).toBe("Direct Post");

    bm.vote(post.id, "e_1", 1);
    bm.vote(post.id, "e_2", -1);
    expect(bm.getVoteCount(post.id)).toBe(0);
  });
});
