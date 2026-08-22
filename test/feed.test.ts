// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { CanvasBroadcaster } from "../src/net/canvas-ws";
import { FeedPublisher } from "../src/net/feed-publisher";
import { MarinaDB } from "../src/persistence/database";
import type { StorageProvider } from "../src/storage/provider";
import type { EngineEvent, EntityId, RoomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_feed.db";

describe("Feed Canvas System", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let entityId: EntityId;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ db, startRoom: "test/start" as RoomId });
    engine.registerRoom("test/start" as RoomId, makeTestRoom());

    conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.login("c1", "Tester");
    if ("error" in result) throw new Error(result.error);
    entityId = result.entityId;
    const entity = engine.entities.get(entityId);
    if (entity) entity.properties.rank = 2; // builder rank for board/pool
    conn.clear();
  });

  afterEach(() => {
    try {
      engine.shutdown();
    } catch {}
    try {
      db.close();
    } catch {}
    cleanupDb(TEST_DB);
  });

  // ─── parent_node_id (Threading) ──────────────────────────────────────

  describe("parent_node_id threading", () => {
    it("creates a node with parent_node_id", () => {
      db.createCanvas({ id: "c1", name: "feed", creatorName: "system" });
      db.createNode({ id: "root", canvasId: "c1", type: "text", creatorName: "Alice" });
      db.createNode({
        id: "reply1",
        canvasId: "c1",
        type: "text",
        creatorName: "Bob",
        parentNodeId: "root",
      });
      const reply = db.getNode("reply1");
      expect(reply).toBeDefined();
      expect(reply!.parent_node_id).toBe("root");
    });

    it("getChildNodes returns children of a node", () => {
      db.createCanvas({ id: "c1", name: "feed", creatorName: "system" });
      db.createNode({ id: "root", canvasId: "c1", type: "text", creatorName: "Alice" });
      db.createNode({
        id: "child1",
        canvasId: "c1",
        type: "text",
        creatorName: "Bob",
        parentNodeId: "root",
      });
      db.createNode({
        id: "child2",
        canvasId: "c1",
        type: "image",
        creatorName: "Carol",
        parentNodeId: "root",
      });
      db.createNode({ id: "orphan", canvasId: "c1", type: "text", creatorName: "Dave" });

      const children = db.getChildNodes("root");
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id)).toContain("child1");
      expect(children.map((c) => c.id)).toContain("child2");
    });

    it("getRootNodes returns only root nodes", () => {
      db.createCanvas({ id: "c1", name: "feed", creatorName: "system" });
      db.createNode({ id: "root1", canvasId: "c1", type: "text", creatorName: "A" });
      db.createNode({ id: "root2", canvasId: "c1", type: "text", creatorName: "B" });
      db.createNode({
        id: "child",
        canvasId: "c1",
        type: "text",
        creatorName: "C",
        parentNodeId: "root1",
      });

      const roots = db.getRootNodes("c1");
      expect(roots).toHaveLength(2);
      expect(roots.map((r) => r.id)).toContain("root1");
      expect(roots.map((r) => r.id)).toContain("root2");
      expect(roots.map((r) => r.id)).not.toContain("child");
    });

    it("parent_node_id is null by default", () => {
      db.createCanvas({ id: "c1", name: "feed", creatorName: "system" });
      db.createNode({ id: "n1", canvasId: "c1", type: "text", creatorName: "Tester" });
      const node = db.getNode("n1");
      expect(node!.parent_node_id).toBeNull();
    });

    it("deleting parent sets child parent_node_id to null", () => {
      db.createCanvas({ id: "c1", name: "feed", creatorName: "system" });
      db.createNode({ id: "parent", canvasId: "c1", type: "text", creatorName: "A" });
      db.createNode({
        id: "child",
        canvasId: "c1",
        type: "text",
        creatorName: "B",
        parentNodeId: "parent",
      });
      db.deleteNode("parent");
      const child = db.getNode("child");
      expect(child).toBeDefined();
      expect(child!.parent_node_id).toBeNull();
    });
  });

  // ─── Feed Layout ─────────────────────────────────────────────────────

  describe("feed layout", () => {
    it("arranges root nodes in reverse chronological order with children indented", () => {
      engine.processCommand(entityId, "canvas create feed-test");
      const canvas = db.getCanvasByName("feed-test")!;

      // Create root nodes with slight time gaps
      db.createNode({ id: "r1", canvasId: canvas.id, type: "text", creatorName: "A" });
      db.createNode({ id: "r2", canvasId: canvas.id, type: "text", creatorName: "B" });
      db.createNode({
        id: "c1",
        canvasId: canvas.id,
        type: "text",
        creatorName: "C",
        parentNodeId: "r1",
      });

      conn.clear();
      engine.processCommand(entityId, "canvas layout feed feed-test");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("feed layout");
      expect(text).toContain("2 top-level");

      // Root nodes should be at x=0, children indented
      const c1 = db.getNode("c1")!;
      expect(c1.x).toBe(60); // indented by 60px
    });
  });

  // ─── canvas nodes shows threading ────────────────────────────────────

  describe("canvas nodes threading display", () => {
    it("shows reply indicator for child nodes", () => {
      engine.processCommand(entityId, "canvas create test");
      const canvas = db.getCanvasByName("test")!;
      db.createNode({ id: "parent-node", canvasId: canvas.id, type: "text", creatorName: "A" });
      db.createNode({
        id: "reply-node",
        canvasId: canvas.id,
        type: "text",
        creatorName: "B",
        parentNodeId: "parent-node",
      });

      conn.clear();
      engine.processCommand(entityId, "canvas nodes test");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("parent-n"); // truncated parent id
    });
  });

  // ─── canvas publish reply:<node_id> ──────────────────────────────────

  describe("canvas publish with reply", () => {
    it("creates a child node via reply: prefix", () => {
      db.createAsset({
        id: "a1",
        entityName: "Tester",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        size: 1024,
        storageKey: "a1.jpg",
      });
      engine.processCommand(entityId, "canvas create gallery");
      const canvas = db.getCanvasByName("gallery")!;
      db.createNode({ id: "target", canvasId: canvas.id, type: "text", creatorName: "A" });

      conn.clear();
      engine.processCommand(entityId, "canvas publish image a1 gallery reply:target");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("Published");

      const nodes = db.getNodesByCanvas(canvas.id);
      const reply = nodes.find((n) => n.id !== "target");
      expect(reply).toBeDefined();
      expect(reply!.parent_node_id).toBe("target");
    });
  });

  // ─── Feed Publisher (engine → canvas) ────────────────────────────────

  describe("FeedPublisher", () => {
    let publisher: FeedPublisher;

    beforeEach(() => {
      publisher = new FeedPublisher({
        db,
        resolveEntity: (id) => engine.entities.get(id)?.name,
      });
    });

    it("auto-creates feed canvas on first event", () => {
      expect(db.getCanvasByName("feed")).toBeUndefined();
      publisher.handleEvent({
        type: "task_claimed",
        entity: entityId,
        taskId: 1,
        timestamp: Date.now(),
      });
      const feedCanvas = db.getCanvasByName("feed");
      expect(feedCanvas).toBeDefined();
    });

    it("publishes task events as feed nodes", () => {
      // Create a task so the publisher can resolve it
      db.createTask({
        title: "Fix the bridge",
        description: "It is broken",
        creatorId: entityId,
        creatorName: "Tester",
      });

      publisher.handleEvent({
        type: "task_claimed",
        entity: entityId,
        taskId: 1,
        timestamp: Date.now(),
      });

      const feedCanvas = db.getCanvasByName("feed")!;
      const nodes = db.getNodesByCanvas(feedCanvas.id);
      expect(nodes).toHaveLength(1);
      const data = JSON.parse(nodes[0]!.data);
      expect(data.feedType).toBe("task_event");
      expect(data.ref).toBe("task:1");
      expect(data.action).toBe("claimed");
    });

    it("broadcasts complete live node snapshots for automated feed events", () => {
      db.createCanvas({ id: "feed-live", name: "feed", creatorName: "system" });
      const broadcaster = new CanvasBroadcaster();
      const sent: string[] = [];
      broadcaster.addClient(
        { readyState: 1, send: (payload: string) => sent.push(payload) } as never,
        "feed-live",
      );
      const livePublisher = new FeedPublisher({
        db,
        resolveEntity: (id) => engine.entities.get(id)?.name,
        broadcaster,
      });

      livePublisher.handleEvent({
        type: "board_post",
        entity: entityId,
        postId: 42,
        boardId: "board:welcome",
        boardName: "welcome",
        title: "Visible now",
        body: "A complete live node",
        timestamp: Date.now(),
      });

      const event = JSON.parse(sent[0]!) as { node: Record<string, unknown> };
      expect(event.node.canvas_id).toBe("feed-live");
      expect(event.node.type).toBe("text");
      expect(event.node.x).toBe(0);
      expect(event.node.width).toBe(300);
      expect(event.node.data).toMatchObject({ feedType: "board_post", title: "Visible now" });
    });

    it("broadcasts agent-published nodes onto their target canvas", () => {
      db.createCanvas({ id: "work-live", name: "work-live", creatorName: "Tester" });
      db.createNode({
        id: "agent-node",
        canvasId: "work-live",
        type: "text",
        data: { content: "Agent result" },
        creatorName: "Tester",
      });
      const broadcaster = new CanvasBroadcaster();
      const sent: string[] = [];
      broadcaster.addClient(
        { readyState: 1, send: (payload: string) => sent.push(payload) } as never,
        "work-live",
      );
      const livePublisher = new FeedPublisher({
        db,
        resolveEntity: (id) => engine.entities.get(id)?.name,
        broadcaster,
      });

      livePublisher.handleEvent({
        type: "canvas_publish",
        entity: entityId,
        canvasId: "work-live",
        nodeId: "agent-node",
        timestamp: Date.now(),
      });

      const event = JSON.parse(sent[0]!) as { type: string; node: { data: unknown } };
      expect(event.type).toBe("node_added");
      expect(event.node.data).toEqual({ content: "Agent result" });
    });

    it("enriches broadcast snapshots of asset-backed nodes with a resolvable url", () => {
      db.createAsset({
        id: "asset-1",
        entityName: "Tester",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        size: 1024,
        storageKey: "asset-1.jpg",
      });
      db.createCanvas({ id: "media-live", name: "media-live", creatorName: "Tester" });
      db.createNode({
        id: "media-node",
        canvasId: "media-live",
        type: "image",
        assetId: "asset-1",
        data: { caption: "A photo" },
        creatorName: "Tester",
      });
      const broadcaster = new CanvasBroadcaster();
      const sent: string[] = [];
      broadcaster.addClient(
        { readyState: 1, send: (payload: string) => sent.push(payload) } as never,
        "media-live",
      );
      const storage: StorageProvider = {
        init: async () => {},
        put: async (key) => key,
        get: async () => null,
        delete: async () => true,
        resolve: (key) => `/assets/${key}`,
      };
      const livePublisher = new FeedPublisher({
        db,
        resolveEntity: (id) => engine.entities.get(id)?.name,
        broadcaster,
        storage,
      });

      livePublisher.handleEvent({
        type: "canvas_publish",
        entity: entityId,
        canvasId: "media-live",
        nodeId: "media-node",
        timestamp: Date.now(),
      });

      const event = JSON.parse(sent[0]!) as {
        type: string;
        node: { data: Record<string, unknown> };
      };
      expect(event.type).toBe("node_added");
      expect(event.node.data.url).toBe("/assets/asset-1.jpg");
      expect(event.node.data.filename).toBe("photo.jpg");
      expect(event.node.data.mime).toBe("image/jpeg");
      expect(event.node.data.caption).toBe("A photo");
    });

    it("records the feed_event even when the intent node data row is corrupt", () => {
      db.createCanvas({ id: "intent-live", name: "intent-live", creatorName: "Tester" });
      db.createNode({
        id: "intent-node",
        canvasId: "intent-live",
        type: "text",
        data: { intent: { prompt: "do the thing", status: "done" } },
        creatorName: "Tester",
      });
      db.updateNode("intent-node", { data: "{not json" });
      const broadcaster = new CanvasBroadcaster();
      const sent: string[] = [];
      broadcaster.addClient(
        { readyState: 1, send: (payload: string) => sent.push(payload) } as never,
        "intent-live",
      );
      const livePublisher = new FeedPublisher({
        db,
        resolveEntity: (id) => engine.entities.get(id)?.name,
        broadcaster,
      });

      livePublisher.handleEvent({
        type: "canvas_intent",
        entity: entityId,
        canvasId: "intent-live",
        nodeId: "intent-node",
        prompt: "do the thing",
        status: "done",
        timestamp: Date.now(),
      } as EngineEvent);

      // The corrupt row skips only the broadcast enrichment…
      const updates = sent.map((s) => JSON.parse(s)).filter((e) => e.type === "node_updated");
      expect(updates).toHaveLength(0);
      // …while the structured feed_event is still recorded.
      const [event] = db.queryFeedEvents({ limit: 1 });
      expect(event?.kind).toBe("canvas_intent");
      expect(event?.ref).toBe("canvas_intent:intent-node");
    });

    it("broadcasts typed edge creation and deletion on the canvas socket", () => {
      const broadcaster = new CanvasBroadcaster();
      const sent: string[] = [];
      broadcaster.addClient(
        { readyState: 1, send: (payload: string) => sent.push(payload) } as never,
        "work-live",
      );
      const livePublisher = new FeedPublisher({
        db,
        resolveEntity: (id) => engine.entities.get(id)?.name,
        broadcaster,
      });
      livePublisher.handleEvent({
        type: "canvas_edge_created",
        entity: entityId,
        canvasId: "work-live",
        edgeId: "edge-1",
        sourceId: "node-a",
        targetId: "node-b",
        relationship: "supports",
        timestamp: 123,
      });
      livePublisher.handleEvent({
        type: "canvas_edge_deleted",
        entity: entityId,
        canvasId: "work-live",
        edgeId: "edge-1",
        timestamp: 124,
      });

      expect(JSON.parse(sent[0]!)).toMatchObject({
        type: "edge_added",
        // No DB row for this edge — data degrades to null, matching the
        // snapshot API's non-optional CanvasEdgeData.data contract.
        edge: { id: "edge-1", relationship: "supports", creatorName: "Tester", data: null },
      });
      expect(JSON.parse(sent[1]!)).toEqual({
        type: "edge_deleted",
        canvasId: "work-live",
        edgeId: "edge-1",
      });
    });

    it("includes the persisted edge data payload in edge_added broadcasts", () => {
      db.createCanvas({ id: "edge-data", name: "edge-data", creatorName: "Tester" });
      db.createNode({ id: "node-a", canvasId: "edge-data", type: "text", creatorName: "Tester" });
      db.createNode({ id: "node-b", canvasId: "edge-data", type: "text", creatorName: "Tester" });
      db.createCanvasEdge({
        id: "edge-2",
        canvasId: "edge-data",
        sourceId: "node-a",
        targetId: "node-b",
        relationship: "supports",
        data: { weight: 3, note: "load-bearing" },
        creatorName: "Tester",
      });
      const broadcaster = new CanvasBroadcaster();
      const sent: string[] = [];
      broadcaster.addClient(
        { readyState: 1, send: (payload: string) => sent.push(payload) } as never,
        "edge-data",
      );
      const livePublisher = new FeedPublisher({
        db,
        resolveEntity: (id) => engine.entities.get(id)?.name,
        broadcaster,
      });

      livePublisher.handleEvent({
        type: "canvas_edge_created",
        entity: entityId,
        canvasId: "edge-data",
        edgeId: "edge-2",
        sourceId: "node-a",
        targetId: "node-b",
        relationship: "supports",
        timestamp: 456,
      });

      expect(JSON.parse(sent[0]!)).toMatchObject({
        type: "edge_added",
        canvasId: "edge-data",
        edge: {
          id: "edge-2",
          sourceId: "node-a",
          targetId: "node-b",
          relationship: "supports",
          data: { weight: 3, note: "load-bearing" },
          creatorName: "Tester",
          createdAt: 456,
        },
      });
    });

    it("broadcasts canvas_deleted and records a feed_event for canvas deletion", () => {
      const broadcaster = new CanvasBroadcaster();
      const sent: string[] = [];
      broadcaster.addClient(
        { readyState: 1, send: (payload: string) => sent.push(payload) } as never,
        "doomed-id",
      );
      const livePublisher = new FeedPublisher({
        db,
        resolveEntity: (id) => engine.entities.get(id)?.name,
        broadcaster,
      });

      livePublisher.handleEvent({
        type: "canvas_deleted",
        entity: entityId,
        canvasId: "doomed-id",
        name: "doomed",
        timestamp: Date.now(),
      });

      expect(JSON.parse(sent[0]!)).toEqual({ type: "canvas_deleted", canvasId: "doomed-id" });
      const [event] = db.queryFeedEvents({ limit: 1 });
      expect(event?.kind).toBe("canvas_deleted");
      expect(event?.ref).toBe("canvas:doomed-id");
      expect(event?.summary).toContain('deleted canvas "doomed"');
      expect(JSON.parse(event?.payload ?? "{}")).toEqual({
        canvasId: "doomed-id",
        name: "doomed",
      });
    });

    it("emits node_deleted for exactly the evicted node ids when retention trims the feed", () => {
      db.createCanvas({ id: "feed-trim", name: "feed", creatorName: "system" });
      const broadcaster = new CanvasBroadcaster();
      const sent: string[] = [];
      broadcaster.addClient(
        { readyState: 1, send: (payload: string) => sent.push(payload) } as never,
        "feed-trim",
      );
      const livePublisher = new FeedPublisher({
        db,
        resolveEntity: (id) => engine.entities.get(id)?.name,
        broadcaster,
      });

      // Fill the feed to exactly FEED_CANVAS_MAX_NODES (500), then spread
      // created_at so eviction order is deterministic — Date.now() collides at
      // ms resolution and the trim SQL orders by created_at.
      const seedIds: string[] = [];
      for (let i = 0; i < 500; i++) {
        const id = `seed-${String(i).padStart(4, "0")}`;
        seedIds.push(id);
        db.createNode({ id, canvasId: "feed-trim", type: "text", creatorName: "system" });
      }
      const raw = new Database(TEST_DB);
      raw.run(
        "UPDATE canvas_nodes SET created_at = created_at - 100000 + rowid WHERE canvas_id = 'feed-trim'",
      );
      raw.close();

      // FEED_TRIM_INTERVAL inserts trigger one amortized trim: 500 + 20 nodes
      // trims back to 500, evicting the 20 oldest seeds via the
      // `LIMIT -1 OFFSET max` idiom in trimCanvasNodesWithIds.
      for (let i = 0; i < 20; i++) {
        livePublisher.handleEvent({
          type: "board_post",
          entity: entityId,
          postId: i,
          boardId: "board:general",
          boardName: "general",
          title: `post ${i}`,
          body: "retention test",
          timestamp: Date.now(),
        });
      }

      const deletions = sent
        .map((payload) => JSON.parse(payload) as { type: string; canvasId: string; nodeId: string })
        .filter((event) => event.type === "node_deleted");
      expect(deletions).toHaveLength(20);
      expect(deletions.every((event) => event.canvasId === "feed-trim")).toBe(true);
      expect(deletions.map((event) => event.nodeId).sort()).toEqual(seedIds.slice(0, 20));
      expect(db.getNodesByCanvas("feed-trim")).toHaveLength(500);
      // The evicted rows are gone; the newest seed survives.
      expect(db.getNode("seed-0019")).toBeUndefined();
      expect(db.getNode("seed-0020")).toBeDefined();
    });

    it("publishes board_post events as feed nodes", () => {
      publisher.handleEvent({
        type: "board_post",
        entity: entityId,
        postId: 42,
        boardId: "board:welcome",
        boardName: "welcome",
        title: "Hello World",
        body: "First post!",
        timestamp: Date.now(),
      });

      const feedCanvas = db.getCanvasByName("feed")!;
      const nodes = db.getNodesByCanvas(feedCanvas.id);
      expect(nodes).toHaveLength(1);
      const data = JSON.parse(nodes[0]!.data);
      expect(data.feedType).toBe("board_post");
      expect(data.ref).toBe("board_post:42");
      expect(data.title).toBe("Hello World");
      expect(data.board).toBe("welcome");
    });

    it("publishes pool_note events as feed nodes", () => {
      publisher.handleEvent({
        type: "pool_note",
        entity: entityId,
        noteId: 7,
        poolName: "findings",
        content: "The ore vein is at depth 3",
        importance: 8,
        timestamp: Date.now(),
      });

      const feedCanvas = db.getCanvasByName("feed")!;
      const nodes = db.getNodesByCanvas(feedCanvas.id);
      expect(nodes).toHaveLength(1);
      const data = JSON.parse(nodes[0]!.data);
      expect(data.feedType).toBe("pool_note");
      expect(data.ref).toBe("note:7");
      expect(data.importance).toBe(8);
    });

    it("publishes channel_message events as feed nodes", () => {
      publisher.handleEvent({
        type: "channel_message",
        entity: entityId,
        messageId: 99,
        channelName: "general",
        content: "Hello everyone!",
        timestamp: Date.now(),
      });

      const feedCanvas = db.getCanvasByName("feed")!;
      const nodes = db.getNodesByCanvas(feedCanvas.id);
      expect(nodes).toHaveLength(1);
      const data = JSON.parse(nodes[0]!.data);
      expect(data.feedType).toBe("channel_message");
      expect(data.channel).toBe("general");
    });

    it("does not publish tick or connect events", () => {
      publisher.handleEvent({ type: "tick", timestamp: Date.now() });
      publisher.handleEvent({
        type: "connect",
        connectionId: "c1",
        protocol: "websocket",
        timestamp: Date.now(),
      });
      expect(db.getCanvasByName("feed")).toBeUndefined();
    });

    it("records request lifecycle as a causal feed timeline without canvas noise", () => {
      publisher.handleEvent({
        type: "model_request_lifecycle",
        phase: "completed",
        requestId: "req-demo",
        runId: "req-demo",
        traceId: "req-demo",
        spanId: "span-req-demo",
        model: "marina:answerer",
        target: "Answerer",
        durationMs: 1234,
        timestamp: Date.now(),
      });
      const [event] = db.queryFeedEvents({ limit: 1 });
      expect(event?.kind).toBe("model_request_completed");
      expect(event?.ref).toBe("request:req-demo");
      expect(event?.summary).toContain("1234ms");
      expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({
        requestId: "req-demo",
        runId: "req-demo",
        traceId: "req-demo",
        spanId: "span-req-demo",
      });
      expect(db.getCanvasByName("feed")).toBeUndefined();
    });

    // ─── Crew lifecycle bookends ────────────────────────────────────────

    it("publishes crew_created as a feed-canvas node", () => {
      publisher.handleEvent({
        type: "crew_created",
        crew: "crew-test01" as never,
        name: "researchers",
        owner: entityId,
        formation: "research",
        lifetime: "persisted",
        timestamp: Date.now(),
      } as EngineEvent);

      const feedCanvas = db.getCanvasByName("feed")!;
      expect(feedCanvas).toBeDefined();
      const nodes = db.getNodesByCanvas(feedCanvas.id);
      expect(nodes).toHaveLength(1);
      const data = JSON.parse(nodes[0]!.data);
      expect(data.feedType).toBe("crew_created");
      expect(data.crewName).toBe("researchers");
      expect(data.formation).toBe("research");
    });

    it("publishes crew_completed with result-note reference", () => {
      publisher.handleEvent({
        type: "crew_completed",
        crew: "crew-test02" as never,
        resultNoteId: 42,
        timestamp: Date.now(),
      } as EngineEvent);

      const feedCanvas = db.getCanvasByName("feed")!;
      const nodes = db.getNodesByCanvas(feedCanvas.id);
      expect(nodes).toHaveLength(1);
      const data = JSON.parse(nodes[0]!.data);
      expect(data.feedType).toBe("crew_completed");
      expect(data.resultNoteId).toBe(42);
    });

    it("publishes crew_dissolved with reason", () => {
      publisher.handleEvent({
        type: "crew_dissolved",
        crew: "crew-test03" as never,
        reason: "idle timeout",
        timestamp: Date.now(),
      } as EngineEvent);

      const feedCanvas = db.getCanvasByName("feed")!;
      const nodes = db.getNodesByCanvas(feedCanvas.id);
      expect(nodes).toHaveLength(1);
      const data = JSON.parse(nodes[0]!.data);
      expect(data.feedType).toBe("crew_dissolved");
      expect(data.reason).toBe("idle timeout");
    });

    it("does not publish member/stage/artifact events to the feed canvas", () => {
      // These are the high-frequency events that stay in the dashboard
      // activity feed only — the canvas is reserved for lifecycle bookends.
      publisher.handleEvent({
        type: "crew_member_joined",
        crew: "crew-test04" as never,
        agentName: "Bob",
        role: "specialist",
        timestamp: Date.now(),
      } as EngineEvent);
      publisher.handleEvent({
        type: "crew_stage_completed",
        crew: "crew-test04" as never,
        stage: "extract",
        agentName: "Bob",
        timestamp: Date.now(),
      } as EngineEvent);
      publisher.handleEvent({
        type: "crew_artifact_deposited",
        crew: "crew-test04" as never,
        agentName: "Bob",
        artifactRef: "shard.json",
        kind: "map",
        timestamp: Date.now(),
      } as EngineEvent);

      expect(db.getCanvasByName("feed")).toBeUndefined();
    });
  });

  // ─── Canvas delete emits canvas_deleted event ────────────────────────

  describe("canvas delete emits events", () => {
    it("emits canvas_deleted with the canvas id and name", () => {
      const events: EngineEvent[] = [];
      engine.addEventListener((e) => events.push(e));

      engine.processCommand(entityId, "canvas create doomed");
      const canvas = db.getCanvasByName("doomed")!;
      events.length = 0;

      engine.processCommand(entityId, "canvas delete doomed");

      expect(db.getCanvasByName("doomed")).toBeUndefined();
      const deleteEvents = events.filter((e) => e.type === "canvas_deleted");
      expect(deleteEvents).toHaveLength(1);
      const event = deleteEvents[0] as EngineEvent & { type: "canvas_deleted" };
      expect(event.canvasId).toBe(canvas.id);
      expect(event.name).toBe("doomed");
      expect(event.entity).toBe(entityId);
    });

    it("does not emit canvas_deleted when the canvas does not exist", () => {
      const events: EngineEvent[] = [];
      engine.addEventListener((e) => events.push(e));

      engine.processCommand(entityId, "canvas delete no-such-canvas");

      expect(events.filter((e) => e.type === "canvas_deleted")).toHaveLength(0);
    });
  });

  // ─── Board command emits board_post event ────────────────────────────

  describe("board command emits events", () => {
    it("emits board_post event on post", () => {
      const events: EngineEvent[] = [];
      engine.addEventListener((e) => events.push(e));

      // Create a board
      db.createBoard({ id: "board:gen", name: "general", scopeType: "global" });

      engine.processCommand(entityId, "board post general Test Title | Body text");

      const boardEvents = events.filter((e) => e.type === "board_post");
      expect(boardEvents).toHaveLength(1);
      const event = boardEvents[0] as EngineEvent & { type: "board_post" };
      expect(event.boardName).toBe("general");
      expect(event.title).toBe("Test Title");
      expect(event.body).toBe("Body text");
    });

    it("emits board_post event on reply", () => {
      const events: EngineEvent[] = [];
      engine.addEventListener((e) => events.push(e));

      db.createBoard({ id: "board:gen", name: "general", scopeType: "global" });
      engine.processCommand(entityId, "board post general Original | Content");
      events.length = 0;

      engine.processCommand(entityId, "board reply 1 This is a reply");

      const boardEvents = events.filter((e) => e.type === "board_post");
      expect(boardEvents).toHaveLength(1);
      const event = boardEvents[0] as EngineEvent & { type: "board_post" };
      expect(event.parentId).toBe(1);
      expect(event.body).toBe("This is a reply");
    });
  });

  // ─── Pool command emits pool_note event ──────────────────────────────

  describe("pool command emits events", () => {
    it("emits pool_note event on add", () => {
      const events: EngineEvent[] = [];
      engine.addEventListener((e) => events.push(e));

      db.createMemoryPool("pool1", "tips", entityId);

      engine.processCommand(entityId, "pool tips add Important discovery importance 8");

      const poolEvents = events.filter((e) => e.type === "pool_note");
      expect(poolEvents).toHaveLength(1);
      const event = poolEvents[0] as EngineEvent & { type: "pool_note" };
      expect(event.poolName).toBe("tips");
      expect(event.importance).toBe(8);
      expect(event.content).toBe("Important discovery");
    });
  });

  // ─── Channel command emits channel_message event ─────────────────────

  describe("channel command emits events", () => {
    it("emits channel_message event on send", () => {
      const events: EngineEvent[] = [];
      engine.addEventListener((e) => events.push(e));

      db.createChannel({
        id: "ch:general",
        type: "public",
        name: "general",
        ownerId: entityId,
        persistence: "permanent",
      });
      db.addChannelMember("ch:general", entityId);

      engine.processCommand(entityId, "channel send general Hello world");

      const chEvents = events.filter((e) => e.type === "channel_message");
      expect(chEvents).toHaveLength(1);
      const event = chEvents[0] as EngineEvent & { type: "channel_message" };
      expect(event.channelName).toBe("general");
      expect(event.content).toBe("Hello world");
    });
  });
});
