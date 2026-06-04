import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

// Covers the DB primitives added during the dashboard live-visualization work
// (phases 0-6): feed_events, canvas_edges, note link removal, and the entity
// canvas lazy-create / lookup. These aren't covered by the existing integration
// suites, so a regression in any one would only surface via manual QA.

const TEST_DB = "test-p6-primitives.db";

describe("feed_events table", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("inserts and reads a feed event", () => {
    const id = db.insertFeedEvent({
      kind: "test_event",
      entity: "alice",
      ref: "ref:1",
      summary: "alice did something",
      payload: { foo: "bar" },
    });
    expect(id).toBeGreaterThan(0);

    const rows = db.queryFeedEvents({ limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("test_event");
    expect(rows[0]!.entity).toBe("alice");
    expect(rows[0]!.ref).toBe("ref:1");
    expect(rows[0]!.summary).toBe("alice did something");
    expect(JSON.parse(rows[0]!.payload!)).toEqual({ foo: "bar" });
  });

  it("filters by kind and entity", () => {
    db.insertFeedEvent({ kind: "a", entity: "alice", summary: "x" });
    db.insertFeedEvent({ kind: "b", entity: "bob", summary: "y" });
    db.insertFeedEvent({ kind: "a", entity: "bob", summary: "z" });

    expect(db.queryFeedEvents({ kind: "a" }).length).toBe(2);
    expect(db.queryFeedEvents({ kind: "b" }).length).toBe(1);
    expect(db.queryFeedEvents({ entity: "alice" }).length).toBe(1);
    expect(db.queryFeedEvents({ entity: "bob" }).length).toBe(2);
    expect(db.queryFeedEvents({ kind: "a", entity: "bob" }).length).toBe(1);
  });

  it("respects since/until time bounds and limit", () => {
    const before = Date.now();
    db.insertFeedEvent({ kind: "x", summary: "first" });
    db.insertFeedEvent({ kind: "x", summary: "second" });
    db.insertFeedEvent({ kind: "x", summary: "third" });
    const after = Date.now() + 1;

    expect(db.queryFeedEvents({ since: before, until: after }).length).toBe(3);
    expect(db.queryFeedEvents({ since: after + 100 }).length).toBe(0);
    expect(db.queryFeedEvents({ limit: 2 }).length).toBe(2);
  });

  it("trimFeedEvents removes old rows", () => {
    db.insertFeedEvent({ kind: "x", summary: "s1" });
    db.insertFeedEvent({ kind: "x", summary: "s2" });
    // Use a slightly-in-the-future cutoff (keepMs=-10 → cutoff = now + 10ms)
    // so rows inserted at the same millisecond as the test still qualify.
    const removed = db.trimFeedEvents(-10);
    expect(removed).toBe(2);
    expect(db.queryFeedEvents().length).toBe(0);
  });

  it("trimFeedEvents keeps rows newer than the cutoff", () => {
    db.insertFeedEvent({ kind: "x", summary: "recent" });
    // 1 hour window — nothing is older than that, so nothing gets trimmed
    const removed = db.trimFeedEvents(3_600_000);
    expect(removed).toBe(0);
    expect(db.queryFeedEvents().length).toBe(1);
  });
});

describe("canvas_edges", () => {
  let db: MarinaDB;
  let canvasId: string;
  let nodeA: string;
  let nodeB: string;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    canvasId = crypto.randomUUID();
    db.createCanvas({
      id: canvasId,
      name: "test-canvas",
      scope: "global",
      creatorName: "tester",
    });
    nodeA = crypto.randomUUID();
    nodeB = crypto.randomUUID();
    db.createNode({ id: nodeA, canvasId, type: "text", creatorName: "tester" });
    db.createNode({ id: nodeB, canvasId, type: "text", creatorName: "tester" });
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("creates and retrieves a typed edge", () => {
    const edgeId = crypto.randomUUID();
    db.createCanvasEdge({
      id: edgeId,
      canvasId,
      sourceId: nodeA,
      targetId: nodeB,
      relationship: "supports",
      creatorName: "tester",
    });
    const edges = db.getCanvasEdges(canvasId);
    expect(edges.length).toBe(1);
    expect(edges[0]!.id).toBe(edgeId);
    expect(edges[0]!.source_id).toBe(nodeA);
    expect(edges[0]!.target_id).toBe(nodeB);
    expect(edges[0]!.relationship).toBe("supports");
  });

  it("deletes an edge and returns true/false appropriately", () => {
    const edgeId = crypto.randomUUID();
    db.createCanvasEdge({
      id: edgeId,
      canvasId,
      sourceId: nodeA,
      targetId: nodeB,
      relationship: "related_to",
      creatorName: "tester",
    });
    expect(db.deleteCanvasEdge(edgeId)).toBe(true);
    expect(db.getCanvasEdges(canvasId).length).toBe(0);
    expect(db.deleteCanvasEdge(edgeId)).toBe(false);
  });

  it("rejects duplicate (canvas, source, target, relationship) via UNIQUE", () => {
    const edgeId1 = crypto.randomUUID();
    const edgeId2 = crypto.randomUUID();
    db.createCanvasEdge({
      id: edgeId1,
      canvasId,
      sourceId: nodeA,
      targetId: nodeB,
      relationship: "supports",
      creatorName: "tester",
    });
    expect(() =>
      db.createCanvasEdge({
        id: edgeId2,
        canvasId,
        sourceId: nodeA,
        targetId: nodeB,
        relationship: "supports",
        creatorName: "tester",
      }),
    ).toThrow();
  });
});

describe("removeNoteLink", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("removes an existing link and leaves others", () => {
    const id1 = db.createNote("alice", "first", undefined, { importance: 5 });
    const id2 = db.createNote("alice", "second", undefined, { importance: 5 });
    const id3 = db.createNote("alice", "third", undefined, { importance: 5 });
    db.createNoteLink(id1, id2, "supports");
    db.createNoteLink(id1, id3, "related_to");

    expect(db.getNoteLinks(id1).length).toBe(2);
    expect(db.removeNoteLink(id1, id2, "supports")).toBe(true);
    expect(db.getNoteLinks(id1).length).toBe(1);
    expect(db.getNoteLinks(id1)[0]!.relationship).toBe("related_to");
  });

  it("returns false when no such link exists", () => {
    const id1 = db.createNote("alice", "x", undefined);
    const id2 = db.createNote("alice", "y", undefined);
    expect(db.removeNoteLink(id1, id2, "supports")).toBe(false);
  });
});

describe("entity canvas lazy-create", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("returns undefined when no entity canvas exists yet", () => {
    expect(db.getEntityCanvas("e_alice")).toBeUndefined();
  });

  it("creates the canvas on first ensure and returns the same row on subsequent calls", () => {
    const first = db.ensureEntityCanvas("e_alice", "alice", "alice");
    expect(first.scope).toBe("entity");
    expect(first.scope_id).toBe("e_alice");
    // Names follow "<name>'s canvas" convention so they're human-readable in the breadcrumb
    expect(first.name).toBe("alice's canvas");

    const second = db.ensureEntityCanvas("e_alice", "alice", "alice");
    expect(second.id).toBe(first.id);
  });

  it("falls back to an id-qualified name when the preferred one is taken", () => {
    const manualId = crypto.randomUUID();
    db.createCanvas({
      id: manualId,
      name: "alice's canvas",
      scope: "global",
      creatorName: "someone",
    });

    const entityCanvas = db.ensureEntityCanvas("e_alice", "alice", "alice");
    expect(entityCanvas.id).not.toBe(manualId);
    expect(entityCanvas.scope).toBe("entity");
    // Name includes entity id suffix to disambiguate
    expect(entityCanvas.name).toContain("alice");
    expect(entityCanvas.name).not.toBe("alice's canvas");
    // Scope-keyed lookup returns the entity canvas, not the manual one
    expect(db.getEntityCanvas("e_alice")?.id).toBe(entityCanvas.id);
  });
});

describe("getGraphSnapshot", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("returns recent notes + links touching them", () => {
    const id1 = db.createNote("alice", "one", undefined, { importance: 5 });
    const id2 = db.createNote("alice", "two", undefined, { importance: 5 });
    const id3 = db.createNote("alice", "three", undefined, { importance: 5 });
    db.createNoteLink(id1, id2, "supports");
    db.createNoteLink(id2, id3, "related_to");

    const snap = db.getGraphSnapshot(100);
    expect(snap.notes.length).toBe(3);
    expect(snap.links.length).toBe(2);
  });

  it("respects the limit and still returns links only between included notes", () => {
    for (let i = 0; i < 5; i++) {
      db.createNote("alice", `n${i}`, undefined, { importance: 5 });
    }
    const snap = db.getGraphSnapshot(3);
    expect(snap.notes.length).toBe(3);
    expect(snap.links.length).toBe(0);
  });
});
