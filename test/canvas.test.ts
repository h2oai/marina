import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { LocalStorageProvider } from "../src/storage/local-provider";
import type { EntityId, RoomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_canvas.db";
const TEST_ASSETS = "test_canvas_assets";

describe("Canvas — Phase 1: Asset Store", () => {
  let db: MarinaDB;
  let storage: LocalStorageProvider;
  let engine: Engine;
  let conn: MockConnection;
  let entityId: EntityId;

  beforeEach(async () => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    storage = new LocalStorageProvider(TEST_ASSETS);
    await storage.init();
    engine = new Engine({ db, storage, startRoom: "test/start" as RoomId });
    engine.registerRoom("test/start" as RoomId, makeTestRoom());

    conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.login("c1", "Tester");
    if ("error" in result) throw new Error(result.error);
    entityId = result.entityId;
    // Promote to citizen so canvas command works (minRank: 1)
    const entity = engine.entities.get(entityId);
    if (entity) entity.properties.rank = 1;
    conn.clear();
  });

  afterEach(async () => {
    try {
      engine.shutdown();
    } catch {}
    try {
      db.close();
    } catch {}
    cleanupDb(TEST_DB);
    // Clean up test assets directory
    try {
      const { rmSync } = await import("node:fs");
      rmSync(TEST_ASSETS, { recursive: true, force: true });
    } catch {}
  });

  // ─── Storage Provider Tests ────────────────────────────────────────────

  describe("LocalStorageProvider", () => {
    it("puts and gets a file", async () => {
      const data = new TextEncoder().encode("hello world");
      await storage.put("test.txt", data, "text/plain");
      const result = await storage.get("test.txt");
      expect(result).not.toBeNull();
      expect(new TextDecoder().decode(result!.data)).toBe("hello world");
    });

    it("returns null for missing key", async () => {
      const result = await storage.get("nonexistent");
      expect(result).toBeNull();
    });

    it("deletes a file", async () => {
      const data = new TextEncoder().encode("temp");
      await storage.put("del.txt", data, "text/plain");
      const deleted = await storage.delete("del.txt");
      expect(deleted).toBe(true);
      const result = await storage.get("del.txt");
      expect(result).toBeNull();
    });

    it("returns false when deleting nonexistent file", async () => {
      const deleted = await storage.delete("nope");
      expect(deleted).toBe(false);
    });

    it("resolves key to URL path", () => {
      expect(storage.resolve("abc.png")).toBe("/assets/abc.png");
    });
  });

  // ─── Database Asset Methods ────────────────────────────────────────────

  describe("Database asset CRUD", () => {
    it("creates and retrieves an asset", () => {
      db.createAsset({
        id: "a1",
        entityName: "Tester",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        size: 1024,
        storageKey: "a1.jpg",
      });
      const asset = db.getAsset("a1");
      expect(asset).toBeDefined();
      expect(asset!.id).toBe("a1");
      expect(asset!.entity_name).toBe("Tester");
      expect(asset!.filename).toBe("photo.jpg");
      expect(asset!.mime_type).toBe("image/jpeg");
      expect(asset!.size).toBe(1024);
      expect(asset!.storage_key).toBe("a1.jpg");
    });

    it("lists assets by entity", () => {
      db.createAsset({
        id: "a1",
        entityName: "Alice",
        filename: "a.png",
        mimeType: "image/png",
        size: 100,
        storageKey: "a1.png",
      });
      db.createAsset({
        id: "a2",
        entityName: "Bob",
        filename: "b.png",
        mimeType: "image/png",
        size: 200,
        storageKey: "a2.png",
      });
      db.createAsset({
        id: "a3",
        entityName: "Alice",
        filename: "c.mp3",
        mimeType: "audio/mpeg",
        size: 300,
        storageKey: "a3.mp3",
      });

      const aliceAssets = db.getAssetsByEntity("Alice");
      expect(aliceAssets).toHaveLength(2);

      const allAssets = db.listAssets();
      expect(allAssets).toHaveLength(3);

      const images = db.listAssets({ mime: "image/" });
      expect(images).toHaveLength(2);
    });

    it("deletes an asset", () => {
      db.createAsset({
        id: "a1",
        entityName: "Tester",
        filename: "test.txt",
        mimeType: "text/plain",
        size: 10,
        storageKey: "a1.txt",
      });
      expect(db.deleteAsset("a1")).toBe(true);
      expect(db.getAsset("a1")).toBeUndefined();
      expect(db.deleteAsset("a1")).toBe(false);
    });

    it("returns undefined for missing asset", () => {
      expect(db.getAsset("nonexistent")).toBeUndefined();
    });
  });

  // ─── Canvas Command (Asset Subcommands) ────────────────────────────────

  describe("canvas asset command", () => {
    it("shows usage without subcommand", () => {
      engine.processCommand(entityId, "canvas");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("canvas create");
    });

    it("lists assets (empty)", () => {
      engine.processCommand(entityId, "canvas asset list");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("No assets found");
    });

    it("lists assets after creating one via DB", () => {
      db.createAsset({
        id: "test-id-1234",
        entityName: "Tester",
        filename: "test.png",
        mimeType: "image/png",
        size: 2048,
        storageKey: "test-id-1234.png",
      });
      engine.processCommand(entityId, "canvas asset list");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("test.png");
      expect(text).toContain("image/png");
    });

    it("shows asset info", () => {
      db.createAsset({
        id: "info-test-id",
        entityName: "Tester",
        filename: "document.pdf",
        mimeType: "application/pdf",
        size: 5000,
        storageKey: "info-test-id.pdf",
      });
      engine.processCommand(entityId, "canvas asset info info-test-id");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("document.pdf");
      expect(text).toContain("application/pdf");
      expect(text).toContain("info-test-id");
    });

    it("shows asset info with partial ID", () => {
      db.createAsset({
        id: "abcdef-1234-5678",
        entityName: "Tester",
        filename: "img.jpg",
        mimeType: "image/jpeg",
        size: 1000,
        storageKey: "abcdef-1234-5678.jpg",
      });
      engine.processCommand(entityId, "canvas asset info abcdef");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("img.jpg");
    });

    it("deletes an asset", async () => {
      const data = new TextEncoder().encode("delete me");
      await storage.put("del-key.txt", data, "text/plain");
      db.createAsset({
        id: "del-id",
        entityName: "Tester",
        filename: "del.txt",
        mimeType: "text/plain",
        size: 9,
        storageKey: "del-key.txt",
      });
      engine.processCommand(entityId, "canvas asset delete del-id");
      // Wait for async handler
      await Bun.sleep(50);
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("deleted");
      expect(db.getAsset("del-id")).toBeUndefined();
    });

    it("reports error for missing asset delete", () => {
      engine.processCommand(entityId, "canvas asset delete nonexistent");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("not found");
    });

    it("allows rank 0 to post/read (canvas is a basic posting capability)", () => {
      const entity = engine.entities.get(entityId);
      if (entity) entity.properties.rank = 0;
      conn.clear();
      engine.processCommand(entityId, "canvas asset list");
      const text = stripAnsi(conn.lastText());
      // No longer rank-gated — newcomers can list/post. The command runs instead
      // of returning a rank error.
      expect(text).not.toContain("must be at least");
    });

    it("still gates the destructive `canvas delete` above rank 0", () => {
      const entity = engine.entities.get(entityId);
      if (entity) entity.properties.rank = 0;
      conn.clear();
      engine.processCommand(entityId, "canvas delete some-canvas");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("rank 1+");
    });

    it("canvas post creates an inline text node at rank 0 (no asset step)", () => {
      const entity = engine.entities.get(entityId);
      if (entity) entity.properties.rank = 0;
      conn.clear();
      engine.processCommand(entityId, "canvas post hello from a newcomer");
      expect(stripAnsi(conn.lastText())).toContain("Posted to canvas");

      const canvas = db.getCanvasByName("global");
      expect(canvas).toBeDefined();
      const nodes = db.getNodesByCanvas(canvas!.id);
      const node = nodes.find((n) => n.type === "text");
      expect(node).toBeDefined();
      expect(node!.asset_id).toBeNull();
      expect(JSON.parse(node!.data).content).toBe("hello from a newcomer");
    });

    it("canvas post routes to a named canvas via on:<name>", () => {
      conn.clear();
      engine.processCommand(entityId, "canvas post on:ideas spark of insight");
      expect(stripAnsi(conn.lastText())).toContain('"ideas"');
      const canvas = db.getCanvasByName("ideas");
      expect(canvas).toBeDefined();
      expect(db.getNodesByCanvas(canvas!.id).length).toBe(1);
    });
  });

  describe("canvas intent loop", () => {
    it("claims a pending intent once through the guarded DB helper", () => {
      db.createCanvas({ id: "intent-canvas", name: "requests", creatorName: "Requester" });
      db.createNode({
        id: "intent-node-1234",
        canvasId: "intent-canvas",
        type: "text",
        creatorName: "Requester",
        data: {
          body: "Need help",
          intent: { status: "pending", prompt: "Summarize this source." },
        },
      });

      const first = db.claimCanvasIntent("intent-node", "Worker");
      const second = db.claimCanvasIntent("intent-node", "Other");

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
      if (!first.ok) throw new Error("first claim unexpectedly failed");
      expect(first.intent.claimedBy).toBe("Worker");

      const stored = JSON.parse(db.getNode("intent-node-1234")!.data);
      expect(stored.intent.status).toBe("active");
      expect(stored.intent.claimedBy).toBe("Worker");
    });

    it("shared intent listing expires stale active claims back to pending", () => {
      const now = Date.now();
      db.createCanvas({ id: "expiry-canvas", name: "requests", creatorName: "Requester" });
      db.createNode({
        id: "intent-node-expired",
        canvasId: "expiry-canvas",
        type: "text",
        creatorName: "Requester",
        data: {
          intent: {
            status: "active",
            prompt: "Pick this back up.",
            claimedBy: "Worker",
            claimedAt: now - 10 * 60 * 1000,
          },
        },
      });

      const pending = db.listCanvasIntents({
        statuses: ["pending"],
        expireActiveMs: 5 * 60 * 1000,
        now,
      });

      expect(pending.map((i) => i.nodeId)).toContain("intent-node-expired");
      const stored = JSON.parse(db.getNode("intent-node-expired")!.data);
      expect(stored.intent.status).toBe("pending");
      expect(stored.intent.claimedBy).toBeUndefined();
      expect(stored.intent.claimedAt).toBeUndefined();
    });

    it("notifies the requester when another entity claims their intent", async () => {
      const requesterConn = new MockConnection("c-requester");
      engine.addConnection(requesterConn);
      const requesterLogin = engine.login("c-requester", "Requester");
      if ("error" in requesterLogin) throw new Error(requesterLogin.error);

      db.createCanvas({ id: "notify-canvas", name: "requests", creatorName: "Requester" });
      db.createNode({
        id: "intent-node-notify",
        canvasId: "notify-canvas",
        type: "text",
        creatorName: "Requester",
        data: {
          intent: { status: "pending", prompt: "Review this draft." },
        },
      });

      conn.clear();
      requesterConn.clear();
      await engine.processCommand(entityId, "canvas intent claim intent-node-notify");

      expect(stripAnsi(conn.lastText())).toContain("Claimed intent");
      expect(stripAnsi(requesterConn.lastText())).toContain("Tester claimed your canvas intent");
    });
  });

  // ─── Export includes assets ────────────────────────────────────────────

  describe("export-import", () => {
    it("includes assets in EXPORT_TABLES", async () => {
      const { exportState } = await import("../src/persistence/export-import");
      db.createAsset({
        id: "export-test",
        entityName: "Tester",
        filename: "x.png",
        mimeType: "image/png",
        size: 100,
        storageKey: "export-test.png",
      });
      // Shutdown engine first (saves state), then close db so export can open it readonly
      engine.shutdown();
      db.close();
      const snapshot = exportState(TEST_DB);
      expect(snapshot.tables.assets).toBeDefined();
      expect(snapshot.tables.assets).toHaveLength(1);
      // Reopen for afterEach cleanup — engine is already shut down
      db = new MarinaDB(TEST_DB);
    });
  });
});

// ─── Phase 2: Canvas Data Model ──────────────────────────────────────────

describe("Canvas — Phase 2: Canvas Data Model", () => {
  let db: MarinaDB;
  let storage: LocalStorageProvider;
  let engine: Engine;
  let conn: MockConnection;
  let entityId: EntityId;

  beforeEach(async () => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    storage = new LocalStorageProvider(TEST_ASSETS);
    await storage.init();
    engine = new Engine({ db, storage, startRoom: "test/start" as RoomId });
    engine.registerRoom("test/start" as RoomId, makeTestRoom());

    conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.login("c1", "Tester");
    if ("error" in result) throw new Error(result.error);
    entityId = result.entityId;
    const entity = engine.entities.get(entityId);
    if (entity) entity.properties.rank = 1;
    conn.clear();
  });

  afterEach(async () => {
    try {
      engine.shutdown();
    } catch {}
    try {
      db.close();
    } catch {}
    cleanupDb(TEST_DB);
    try {
      const { rmSync } = await import("node:fs");
      rmSync(TEST_ASSETS, { recursive: true, force: true });
    } catch {}
  });

  // ─── Database Canvas CRUD ──────────────────────────────────────────────

  describe("Database canvas CRUD", () => {
    it("creates and retrieves a canvas", () => {
      db.createCanvas({ id: "c1", name: "gallery", creatorName: "Tester" });
      const canvas = db.getCanvas("c1");
      expect(canvas).toBeDefined();
      expect(canvas!.name).toBe("gallery");
      expect(canvas!.scope).toBe("global");
    });

    it("finds canvas by name", () => {
      db.createCanvas({ id: "c1", name: "mycanvas", creatorName: "Tester" });
      const canvas = db.getCanvasByName("mycanvas");
      expect(canvas).toBeDefined();
      expect(canvas!.id).toBe("c1");
    });

    it("lists canvases", () => {
      db.createCanvas({ id: "c1", name: "first", creatorName: "A" });
      db.createCanvas({ id: "c2", name: "second", creatorName: "B" });
      const all = db.listCanvases();
      expect(all).toHaveLength(2);
    });

    it("deletes a canvas", () => {
      db.createCanvas({ id: "c1", name: "del", creatorName: "Tester" });
      expect(db.deleteCanvas("c1")).toBe(true);
      expect(db.getCanvas("c1")).toBeUndefined();
    });
  });

  // ─── Database Node CRUD ────────────────────────────────────────────────

  describe("Database node CRUD", () => {
    beforeEach(() => {
      db.createCanvas({ id: "c1", name: "test-canvas", creatorName: "Tester" });
    });

    it("creates and retrieves a node", () => {
      db.createNode({ id: "n1", canvasId: "c1", type: "image", creatorName: "Tester" });
      const node = db.getNode("n1");
      expect(node).toBeDefined();
      expect(node!.type).toBe("image");
      expect(node!.canvas_id).toBe("c1");
      expect(node!.width).toBe(300);
      expect(node!.height).toBe(200);
    });

    it("lists nodes by canvas", () => {
      db.createNode({ id: "n1", canvasId: "c1", type: "image", creatorName: "A" });
      db.createNode({ id: "n2", canvasId: "c1", type: "video", creatorName: "B" });
      const nodes = db.getNodesByCanvas("c1");
      expect(nodes).toHaveLength(2);
    });

    it("updates node position", () => {
      db.createNode({ id: "n1", canvasId: "c1", type: "text", creatorName: "Tester" });
      db.updateNode("n1", { x: 100, y: 200 });
      const node = db.getNode("n1");
      expect(node!.x).toBe(100);
      expect(node!.y).toBe(200);
    });

    it("deletes a node", () => {
      db.createNode({ id: "n1", canvasId: "c1", type: "text", creatorName: "Tester" });
      expect(db.deleteNode("n1")).toBe(true);
      expect(db.getNode("n1")).toBeUndefined();
    });

    it("cascades node deletion when canvas is deleted", () => {
      db.createNode({ id: "n1", canvasId: "c1", type: "text", creatorName: "Tester" });
      db.createNode({ id: "n2", canvasId: "c1", type: "image", creatorName: "Tester" });
      db.deleteCanvas("c1");
      expect(db.getNodesByCanvas("c1")).toHaveLength(0);
    });
  });

  // ─── Canvas Commands ───────────────────────────────────────────────────

  describe("canvas commands", () => {
    it("creates a canvas", () => {
      engine.processCommand(entityId, "canvas create gallery My gallery");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("gallery");
      expect(text).toContain("created");
    });

    it("rejects duplicate canvas name", () => {
      engine.processCommand(entityId, "canvas create gallery");
      conn.clear();
      engine.processCommand(entityId, "canvas create gallery");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("already exists");
    });

    it("lists canvases", () => {
      engine.processCommand(entityId, "canvas create gallery");
      conn.clear();
      engine.processCommand(entityId, "canvas list");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("gallery");
    });

    it("shows canvas info", () => {
      engine.processCommand(entityId, "canvas create gallery A test gallery");
      conn.clear();
      engine.processCommand(entityId, "canvas info gallery");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("gallery");
      expect(text).toContain("Tester");
    });

    it("publishes an asset to a canvas", () => {
      db.createAsset({
        id: "a1",
        entityName: "Tester",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        size: 1024,
        storageKey: "a1.jpg",
      });
      engine.processCommand(entityId, "canvas create gallery");
      conn.clear();
      engine.processCommand(entityId, "canvas publish image a1 gallery");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("Published");
      expect(text).toContain("gallery");
      // Verify node was created
      const canvas = db.getCanvasByName("gallery")!;
      const nodes = db.getNodesByCanvas(canvas.id);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.type).toBe("image");
    });

    it("populates a unified node-data shape on manual publish", () => {
      // Customer-demo regression: nodes published via `canvas publish` were
      // appearing blank because their data lacked feedType / author / title.
      // Without these, the dashboard renderer falls through every label
      // fallback and shows empty space. Lock the contract here.
      db.createAsset({
        id: "a2",
        entityName: "Tester",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 2048,
        storageKey: "a2.pdf",
      });
      engine.processCommand(entityId, "canvas create archive");
      engine.processCommand(entityId, "canvas publish pdf a2 archive");

      const canvas = db.getCanvasByName("archive")!;
      const node = db.getNodesByCanvas(canvas.id)[0]!;
      const data = JSON.parse(node.data) as Record<string, unknown>;

      expect(data.feedType).toBe("manual");
      expect(data.author).toBe("Tester");
      expect(data.title).toBe("report.pdf");
      expect(data.filename).toBe("report.pdf");
      expect(data.mime).toBe("application/pdf");
    });

    it("rejects a publish whose asset MIME doesn't match the node type", () => {
      // Without this check, `canvas publish image <json_asset>` would succeed
      // and the dashboard would render a broken <img> with no signal.
      db.createAsset({
        id: "j1",
        entityName: "Tester",
        filename: "data.json",
        mimeType: "application/json",
        size: 64,
        storageKey: "j1.json",
      });
      engine.processCommand(entityId, "canvas create vault");
      conn.clear();
      engine.processCommand(entityId, "canvas publish image j1 vault");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("not a valid image");
      const canvas = db.getCanvasByName("vault")!;
      expect(db.getNodesByCanvas(canvas.id)).toHaveLength(0);
    });

    it("tags a reply publish as a conversation node", () => {
      db.createAsset({
        id: "a3",
        entityName: "Tester",
        filename: "reply.txt",
        mimeType: "text/plain",
        size: 32,
        storageKey: "a3.txt",
      });
      engine.processCommand(entityId, "canvas create thread");
      engine.processCommand(entityId, "canvas publish text a3 thread");
      const canvas = db.getCanvasByName("thread")!;
      const parent = db.getNodesByCanvas(canvas.id)[0]!;
      conn.clear();
      engine.processCommand(entityId, `canvas publish text a3 thread reply:${parent.id}`);

      const nodes = db.getNodesByCanvas(canvas.id);
      const reply = nodes.find((n) => n.parent_node_id === parent.id);
      expect(reply).toBeDefined();
      const data = JSON.parse(reply!.data) as Record<string, unknown>;
      expect(data.feedType).toBe("conversation");
      expect(data.author).toBe("Tester");
    });

    it("shows canvas nodes", () => {
      db.createAsset({
        id: "a1",
        entityName: "Tester",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        size: 1024,
        storageKey: "a1.jpg",
      });
      engine.processCommand(entityId, "canvas create gallery");
      engine.processCommand(entityId, "canvas publish image a1 gallery");
      conn.clear();
      engine.processCommand(entityId, "canvas nodes gallery");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("[image]");
      expect(text).toContain("Tester");
    });

    it("deletes a canvas", () => {
      engine.processCommand(entityId, "canvas create temp");
      conn.clear();
      engine.processCommand(entityId, "canvas delete temp");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("deleted");
      expect(db.getCanvasByName("temp")).toBeUndefined();
    });

    it("layouts nodes in a grid", () => {
      engine.processCommand(entityId, "canvas create grid-test");
      const canvas = db.getCanvasByName("grid-test")!;
      db.createNode({ id: "n1", canvasId: canvas.id, type: "image", creatorName: "T" });
      db.createNode({ id: "n2", canvasId: canvas.id, type: "image", creatorName: "T" });
      db.createNode({ id: "n3", canvasId: canvas.id, type: "image", creatorName: "T" });
      db.createNode({ id: "n4", canvasId: canvas.id, type: "image", creatorName: "T" });
      conn.clear();
      engine.processCommand(entityId, "canvas layout grid grid-test");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("4 nodes");
      expect(text).toContain("grid");
      // Check positions
      const n1 = db.getNode("n1")!;
      const n4 = db.getNode("n4")!;
      expect(n1.x).toBe(0);
      expect(n1.y).toBe(0);
      // n4 should be in second row, first column (3 cols, index 3 → col 0, row 1)
      expect(n4.x).toBe(0);
      expect(n4.y).toBe(260); // 240 + 20 padding
    });

    it("layouts nodes in a timeline", () => {
      engine.processCommand(entityId, "canvas create time-test");
      const canvas = db.getCanvasByName("time-test")!;
      db.createNode({ id: "t1", canvasId: canvas.id, type: "text", creatorName: "T" });
      db.createNode({ id: "t2", canvasId: canvas.id, type: "text", creatorName: "T" });
      conn.clear();
      engine.processCommand(entityId, "canvas layout timeline time-test");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("2 nodes");
      expect(text).toContain("timeline");
      const t1 = db.getNode("t1")!;
      const t2 = db.getNode("t2")!;
      expect(t1.y).toBe(0);
      expect(t2.y).toBe(0);
      // t2 should be offset by 360 (320 + 40)
      expect(t2.x).toBe(360);
    });
  });
});
