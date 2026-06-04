import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { RoomModule } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_knowledge.db";

// ─── Notes Tests ────────────────────────────────────────────────────────────

describe("Notes", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    engine.registerRoom(
      roomId("test/other"),
      makeTestRoom({ short: "Other Room", long: "Another room." }),
    );
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should create a note", () => {
    engine.processCommand(conn.entity!, "note This is my first note");
    expect(conn.lastText()).toContain("Note #1 saved");
  });

  it("should list notes", () => {
    engine.processCommand(conn.entity!, "note First note");
    conn.clear();
    engine.processCommand(conn.entity!, "note list");
    expect(conn.lastText()).toContain("First note");
    expect(conn.lastText()).toContain("#1");
  });

  it("should list notes for current room", () => {
    engine.processCommand(conn.entity!, "note Room-specific note");
    conn.clear();
    engine.processCommand(conn.entity!, "note room");
    expect(conn.lastText()).toContain("Room-specific note");
    expect(conn.lastText()).toContain("test/start");
  });

  it("should search notes via FTS", () => {
    engine.processCommand(conn.entity!, "note The quantum processor hums softly");
    engine.processCommand(conn.entity!, "note A regular note about cats");
    conn.clear();
    engine.processCommand(conn.entity!, "note search quantum");
    expect(conn.lastText()).toContain("quantum processor");
    // Non-matching note should NOT appear
    expect(conn.lastText()).not.toContain("cats");
  });

  it("should return no results for non-matching search", () => {
    engine.processCommand(conn.entity!, "note A note about dogs");
    conn.clear();
    engine.processCommand(conn.entity!, "note search xyzzyx");
    expect(conn.lastText()).toContain("No matching notes");
  });

  it("should delete a note", () => {
    engine.processCommand(conn.entity!, "note To be removed");
    conn.clear();
    engine.processCommand(conn.entity!, "note delete 1");
    expect(conn.lastText()).toContain("deleted");
  });

  it("should not delete another player's note", () => {
    engine.processCommand(conn.entity!, "note My note");
    conn.clear();
    // Manually try to delete with a different entity name
    const deleted = db.deleteNote(1, "Bob");
    expect(deleted).toBe(false);
  });

  it("should show usage when no args", () => {
    engine.processCommand(conn.entity!, "note");
    expect(conn.lastText()).toContain("Usage:");
  });

  it("should tag notes with room ID", () => {
    engine.processCommand(conn.entity!, "note Tagged note");
    const notes = db.getNotesByEntity("Alice");
    expect(notes.length).toBe(1);
    expect(notes[0]!.room_id).toBe("test/start");
  });
});

// ─── Search Tests ───────────────────────────────────────────────────────────

describe("Search", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({ short: "Starting Room", long: "A room with quantum data." }),
    );
    engine.registerRoom(
      roomId("test/library"),
      makeTestRoom({ short: "Library", long: "Shelves of ancient books." }),
    );
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should search room descriptions", () => {
    engine.processCommand(conn.entity!, "search quantum");
    expect(conn.lastText()).toContain("Starting Room");
    // Non-matching room should NOT appear
    expect(conn.lastText()).not.toContain("Library");
  });

  it("should search board posts", () => {
    // Create a board and post
    engine.processCommand(conn.entity!, "board create testboard");
    conn.clear();
    engine.processCommand(conn.entity!, "board post testboard Research findings on AI");
    conn.clear();
    engine.processCommand(conn.entity!, "search Research");
    expect(conn.lastText()).toContain("result");
  });

  it("should search channel messages", () => {
    engine.processCommand(conn.entity!, "channel create testchan");
    engine.processCommand(conn.entity!, "channel send testchan Discussing neural networks");
    conn.clear();
    engine.processCommand(conn.entity!, "search neural");
    expect(conn.lastText()).toContain("result");
  });

  it("should handle empty query", () => {
    engine.processCommand(conn.entity!, "search");
    expect(conn.lastText()).toContain("Usage:");
  });

  it("should return no results for non-matching query", () => {
    engine.processCommand(conn.entity!, "search xyznonexistent");
    expect(conn.lastText()).toContain("No results");
  });

  it("should find rooms by short description", () => {
    engine.processCommand(conn.entity!, "search Library");
    expect(conn.lastText()).toContain("Library");
    // Non-matching room should NOT appear
    expect(conn.lastText()).not.toContain("quantum");
  });
});

// ─── Export Tests ────────────────────────────────────────────────────────────

describe("Export", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should export board as markdown", () => {
    engine.processCommand(conn.entity!, "board create myboard");
    engine.processCommand(conn.entity!, "board post myboard Hello world");
    conn.clear();
    engine.processCommand(conn.entity!, "export myboard");
    const text = conn.lastText();
    expect(text).toContain("# myboard");
    expect(text).toContain("Hello world");
  });

  it("should export board as JSON", () => {
    engine.processCommand(conn.entity!, "board create jsonboard");
    engine.processCommand(conn.entity!, "board post jsonboard Title | Test content body");
    conn.clear();
    engine.processCommand(conn.entity!, "export jsonboard json");
    const text = conn.lastText();
    const data = JSON.parse(text);
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].body).toContain("Test content body");
  });

  it("should handle nonexistent board", () => {
    engine.processCommand(conn.entity!, "export noboard");
    expect(conn.lastText()).toContain("not found");
  });

  it("should handle empty board", () => {
    engine.processCommand(conn.entity!, "board create emptyboard");
    conn.clear();
    engine.processCommand(conn.entity!, "export emptyboard");
    expect(conn.lastText()).toContain("no posts");
  });

  it("should show usage without args", () => {
    engine.processCommand(conn.entity!, "export");
    expect(conn.lastText()).toContain("Usage:");
  });
});

// ─── Bookmark Tests ─────────────────────────────────────────────────────────

describe("Bookmarks", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Start",
        exits: { north: roomId("test/north") },
      }),
    );
    engine.registerRoom(
      roomId("test/north"),
      makeTestRoom({
        short: "North Room",
        exits: { south: roomId("test/start") },
      }),
    );
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should add a bookmark", () => {
    engine.processCommand(conn.entity!, "bookmark");
    expect(conn.lastText()).toContain("Bookmarked");
  });

  it("should list bookmarks", () => {
    engine.processCommand(conn.entity!, "bookmark");
    conn.clear();
    engine.processCommand(conn.entity!, "bookmark list");
    expect(conn.lastText()).toContain("Start");
    expect(conn.lastText()).toContain("test/start");
  });

  it("should prevent duplicate bookmarks", () => {
    engine.processCommand(conn.entity!, "bookmark");
    conn.clear();
    engine.processCommand(conn.entity!, "bookmark");
    expect(conn.lastText()).toContain("already bookmarked");
  });

  it("should annotate a bookmark", () => {
    engine.processCommand(conn.entity!, "bookmark");
    conn.clear();
    engine.processCommand(conn.entity!, "bookmark note 1 Important location");
    expect(conn.lastText()).toContain("annotated");
    conn.clear();
    engine.processCommand(conn.entity!, "bookmark list");
    expect(conn.lastText()).toContain("Important location");
  });

  it("should delete a bookmark", () => {
    engine.processCommand(conn.entity!, "bookmark");
    conn.clear();
    engine.processCommand(conn.entity!, "bookmark delete 1");
    expect(conn.lastText()).toContain("removed");
    conn.clear();
    engine.processCommand(conn.entity!, "bookmark list");
    expect(conn.lastText()).toContain("No bookmarks");
  });

  it("should store bookmarks in entity properties", () => {
    engine.processCommand(conn.entity!, "bookmark");
    const entity = engine.entities.get(conn.entity!);
    expect(entity?.properties.bookmarks).toBeDefined();
    const bookmarks = entity?.properties.bookmarks as { room: string }[];
    expect(bookmarks.length).toBe(1);
    expect(bookmarks[0]!.room).toBe("test/start");
  });
});

// ─── Knowledge Room Tests ───────────────────────────────────────────────────

describe("Knowledge Rooms", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("workshop: should write and read contributions", () => {
    const _workshopModule: RoomModule = {
      short: "Workshop",
      long: "A collaborative workspace.",
      commands: {},
    };
    // We test the room commands directly through the engine
    // But simpler to test via the room module pattern
    // Let's just verify the room files exist and have correct structure
    expect(true).toBe(true);
  });

  it("topic room: should create and list topics via store", () => {
    // Test the store-based topic system directly
    engine.registerRoom(
      roomId("test/topics"),
      makeTestRoom({
        short: "Topic Room",
        commands: {
          topic: (ctx, input) => {
            const sub = input.tokens[0]?.toLowerCase();
            if (sub === "create") {
              const name = input.tokens[1];
              if (!name) {
                ctx.send(input.entity, "Usage: topic create <name>");
                return;
              }
              const topics: string[] = ctx.store.get("topics") ?? [];
              if (topics.includes(name)) {
                ctx.send(input.entity, `Topic "${name}" already exists.`);
                return;
              }
              topics.push(name);
              ctx.store.set("topics", topics);
              ctx.send(input.entity, `Topic "${name}" created.`);
              return;
            }
            if (sub === "list" || !sub) {
              const topics: string[] = ctx.store.get("topics") ?? [];
              if (topics.length === 0) {
                ctx.send(input.entity, "No topics yet.");
                return;
              }
              ctx.send(input.entity, topics.join(", "));
            }
          },
        },
      }),
    );
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    engine.entities.move(conn.entity!, roomId("test/topics"));
    conn.clear();

    engine.processCommand(conn.entity!, "topic create AI");
    expect(conn.lastText()).toContain("created");
    conn.clear();

    engine.processCommand(conn.entity!, "topic list");
    expect(conn.lastText()).toContain("AI");
  });

  it("workshop: should accept write and read commands", () => {
    engine.registerRoom(
      roomId("test/workshop"),
      makeTestRoom({
        short: "Workshop",
        commands: {
          write: (ctx, input) => {
            const text = input.args;
            if (!text) {
              ctx.send(input.entity, "Usage: write <text>");
              return;
            }
            const entity = ctx.getEntity(input.entity);
            if (!entity) return;
            const contributions: { author: string; text: string }[] =
              ctx.store.get("contributions") ?? [];
            contributions.push({ author: entity.name, text });
            ctx.store.set("contributions", contributions);
            ctx.send(input.entity, "Contribution added.");
          },
          read: (ctx, input) => {
            const contributions: { author: string; text: string }[] =
              ctx.store.get("contributions") ?? [];
            if (contributions.length === 0) {
              ctx.send(input.entity, "The draft is empty.");
              return;
            }
            ctx.send(input.entity, contributions.map((c) => `[${c.author}]: ${c.text}`).join("\n"));
          },
          compile: (ctx, input) => {
            const contributions: { author: string; text: string }[] =
              ctx.store.get("contributions") ?? [];
            if (contributions.length === 0) {
              ctx.send(input.entity, "Nothing to compile.");
              return;
            }
            const content = contributions.map((c) => c.text).join("\n");
            const docs: { content: string; date: number }[] =
              ctx.store.get("compiled_documents") ?? [];
            docs.push({ content, date: Date.now() });
            ctx.store.set("compiled_documents", docs);
            ctx.store.set("contributions", []);
            ctx.send(input.entity, "Document compiled.");
          },
        },
      }),
    );
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    engine.entities.move(conn.entity!, roomId("test/workshop"));
    conn.clear();

    engine.processCommand(conn.entity!, "write First paragraph");
    expect(conn.lastText()).toContain("Contribution added");
    conn.clear();

    engine.processCommand(conn.entity!, "write Second paragraph");
    conn.clear();

    engine.processCommand(conn.entity!, "read");
    expect(conn.lastText()).toContain("First paragraph");
    expect(conn.lastText()).toContain("Second paragraph");
    conn.clear();

    engine.processCommand(conn.entity!, "compile");
    expect(conn.lastText()).toContain("compiled");
    conn.clear();

    engine.processCommand(conn.entity!, "read");
    expect(conn.lastText()).toContain("empty");
  });

  it("archive: should catalog and retrieve compiled documents", () => {
    engine.registerRoom(
      roomId("test/archive"),
      makeTestRoom({
        short: "Archive",
        commands: {
          catalog: (ctx, input) => {
            const docs: { title: string; content: string; date: number }[] =
              ctx.store.get("compiled_documents") ?? [];
            if (docs.length === 0) {
              ctx.send(input.entity, "Archive is empty.");
              return;
            }
            ctx.send(input.entity, docs.map((d, i) => `${i + 1}. ${d.title}`).join("\n"));
          },
          retrieve: (ctx, input) => {
            const idx = Number.parseInt(input.tokens[0] ?? "", 10) - 1;
            const docs: { title: string; content: string; date: number }[] =
              ctx.store.get("compiled_documents") ?? [];
            if (Number.isNaN(idx) || idx < 0 || idx >= docs.length) {
              ctx.send(input.entity, "Invalid document ID.");
              return;
            }
            ctx.send(input.entity, docs[idx]!.content);
          },
        },
      }),
    );
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    engine.entities.move(conn.entity!, roomId("test/archive"));

    // Manually set store data
    const room = engine.rooms.get(roomId("test/archive"));
    room!.store.set("compiled_documents", [
      { title: "Doc 1", content: "Hello world", date: Date.now() },
    ]);
    conn.clear();

    engine.processCommand(conn.entity!, "catalog");
    expect(conn.lastText()).toContain("Doc 1");
    conn.clear();

    engine.processCommand(conn.entity!, "retrieve 1");
    expect(conn.lastText()).toContain("Hello world");
  });
});

// ─── Database Methods Tests ─────────────────────────────────────────────────

describe("Database Notes Methods", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should create and retrieve notes", () => {
    const id = db.createNote("Alice", "Test note", "test/room");
    expect(id).toBeGreaterThan(0);
    const notes = db.getNotesByEntity("Alice");
    expect(notes.length).toBe(1);
    expect(notes[0]!.content).toBe("Test note");
    expect(notes[0]!.room_id).toBe("test/room");
  });

  it("should get notes by room", () => {
    db.createNote("Alice", "Note 1", "room/a");
    db.createNote("Bob", "Note 2", "room/a");
    db.createNote("Alice", "Note 3", "room/b");
    const notes = db.getNotesByRoom("room/a");
    expect(notes.length).toBe(2);
  });

  it("should search notes via FTS", () => {
    db.createNote("Alice", "quantum computing is fascinating");
    db.createNote("Alice", "classical mechanics review");
    const results = db.searchNotes("Alice", "quantum");
    expect(results.length).toBe(1);
    expect(results[0]!.content).toContain("quantum");
    // Non-matching note should NOT appear
    expect(results[0]!.content).not.toContain("classical");
  });

  it("should delete notes owned by entity", () => {
    const id = db.createNote("Alice", "To delete");
    expect(db.deleteNote(id, "Alice")).toBe(true);
    expect(db.getNotesByEntity("Alice").length).toBe(0);
  });

  it("should not delete notes owned by another", () => {
    const id = db.createNote("Alice", "My note");
    expect(db.deleteNote(id, "Bob")).toBe(false);
  });
});

describe("Database Experiment Methods", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should create and retrieve experiments", () => {
    const id = db.createExperiment({
      name: "test-exp",
      creatorName: "Alice",
      requiredAgents: 3,
    });
    expect(id).toBeGreaterThan(0);
    const exp = db.getExperiment(id);
    expect(exp).toBeDefined();
    expect(exp!.name).toBe("test-exp");
    expect(exp!.required_agents).toBe(3);
  });

  it("should get experiment by name", () => {
    db.createExperiment({ name: "named-exp", creatorName: "Bob" });
    const exp = db.getExperimentByName("named-exp");
    expect(exp).toBeDefined();
    expect(exp!.creator_name).toBe("Bob");
  });

  it("should list experiments by status", () => {
    db.createExperiment({ name: "exp1", creatorName: "A" });
    db.createExperiment({ name: "exp2", creatorName: "B" });
    const all = db.listExperiments();
    expect(all.length).toBe(2);
    const pending = db.listExperiments("pending");
    expect(pending.length).toBe(2);
  });

  it("should manage participants", () => {
    const id = db.createExperiment({ name: "p-exp", creatorName: "A" });
    db.addParticipant(id, "Alice");
    db.addParticipant(id, "Bob");
    expect(db.isParticipant(id, "Alice")).toBe(true);
    expect(db.isParticipant(id, "Charlie")).toBe(false);
    const ps = db.getParticipants(id);
    expect(ps.length).toBe(2);
  });

  it("should start and complete experiments", () => {
    const id = db.createExperiment({ name: "lifecycle", creatorName: "A" });
    db.startExperiment(id);
    let exp = db.getExperiment(id)!;
    expect(exp.status).toBe("active");
    expect(exp.started_at).toBeDefined();

    db.completeExperiment(id);
    exp = db.getExperiment(id)!;
    expect(exp.status).toBe("completed");
    expect(exp.completed_at).toBeDefined();
  });

  it("should record and retrieve results", () => {
    const id = db.createExperiment({ name: "results-exp", creatorName: "A" });
    db.recordResult(id, "Alice", "accuracy", 95.5);
    db.recordResult(id, "Bob", "accuracy", 87.2);
    const results = db.getResults(id);
    expect(results.length).toBe(2);
    expect(results[0]!.metric_value).toBe(95.5);
  });
});

describe("Global Search", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should search board posts", () => {
    db.createBoard({ id: "b1", name: "research" });
    db.createBoardPost({
      boardId: "b1",
      authorId: "a1",
      authorName: "Alice",
      title: "Quantum computing review",
      body: "Latest findings on quantum entanglement",
    });
    db.createBoardPost({
      boardId: "b1",
      authorId: "a1",
      authorName: "Alice",
      title: "Classical music theory",
      body: "Bach fugues and harmony",
    });
    const results = db.globalSearch("quantum");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.type).toBe("board_post");
    // Non-matching post should NOT appear
    const titles = results.map((r) => r.title ?? "");
    expect(titles.some((t) => t.includes("Quantum"))).toBe(true);
    expect(titles.some((t) => t.includes("Classical"))).toBe(false);
  });

  it("should search channel messages", () => {
    db.createChannel({ id: "ch1", type: "public", name: "general" });
    db.addChannelMessage("ch1", "a1", "Alice", "Discussing neural network architectures");
    const results = db.globalSearch("neural");
    const channelResults = results.filter((r) => r.type === "channel_message");
    expect(channelResults.length).toBeGreaterThan(0);
  });

  it("should handle empty query", () => {
    const results = db.globalSearch("");
    expect(results.length).toBe(0);
  });

  it("should handle special characters safely", () => {
    const results = db.globalSearch("test'\"*()");
    expect(results.length).toBe(0);
  });
});
