import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import {
  EXPORT_TABLES,
  exportState,
  importState,
  isExcludedFromExport,
  type MarinaSnapshot,
  validateSnapshot,
} from "../src/persistence/export-import";
import { entityId, roomId } from "../src/types";
import { cleanupDb } from "./helpers";

const SRC_DB = "test_export_src.db";
const DST_DB = "test_export_dst.db";

describe("Export/Import", () => {
  let srcDb: MarinaDB;

  beforeEach(() => {
    srcDb = new MarinaDB(SRC_DB);
  });

  afterEach(() => {
    srcDb.close();
    cleanupDb(SRC_DB);
    cleanupDb(DST_DB);
  });

  // ─── Seed helpers ──────────────────────────────────────────────────

  function seedTestData(): void {
    // Entity
    srcDb.saveEntity({
      id: entityId("e_1"),
      kind: "agent",
      name: "Alice",
      short: "Alice is here.",
      long: "A test agent named Alice.",
      room: roomId("core/nexus"),
      properties: { rank: 2 },
      inventory: [],
      createdAt: 1000,
    });

    // User
    srcDb.createUser({ id: "u_1", name: "Alice", rank: 2 });

    // Room store
    srcDb.setRoomStoreValue(roomId("core/nexus"), "counter", 42);

    // Channel + message + member
    srcDb.createChannel({
      id: "ch_1",
      type: "global",
      name: "general",
    });
    srcDb.addChannelMember("ch_1", "e_1");
    srcDb.addChannelMessage("ch_1", "e_1", "Alice", "Hello world");

    // Board + post + vote
    srcDb.createBoard({ id: "b_1", name: "general" });
    srcDb.createBoardPost({
      boardId: "b_1",
      authorId: "e_1",
      authorName: "Alice",
      title: "First Post",
      body: "Hello from Alice",
    });
    srcDb.voteBoardPost(1, "e_1", 1, 8);

    // Group + member
    srcDb.createGroup({
      id: "g_1",
      name: "explorers",
      leaderId: "e_1",
    });
    srcDb.addGroupMember("g_1", "e_1", 2);

    // Task + claim
    srcDb.createTask({
      title: "Map the world",
      description: "Explore all rooms",
      creatorId: "e_1",
      creatorName: "Alice",
    });
    srcDb.createTaskClaim(1, "e_1", "Alice");

    // Macro
    srcDb.createMacro("patrol", "e_1", "look");

    // Note (with importance and type)
    srcDb.createNote("Alice", "The nexus is the center of the world", "core/nexus", {
      importance: 8,
      noteType: "observation",
    });

    // Core memory
    srcDb.setCoreMemory("Alice", "goal", "Explore everything");

    // Memory pool
    srcDb.createMemoryPool("pool_1", "research", "Alice");
    srcDb.addPoolNote("pool_1", "Alice", "Pool note about research", 7, "fact");

    // Note link
    const noteId2 = srcDb.createNote("Alice", "Second note for linking", "core/nexus");
    srcDb.createNoteLink(1, noteId2, "supports");

    // Experiment + participant + result
    srcDb.createExperiment({
      name: "test-exp",
      description: "A test experiment",
      creatorName: "Alice",
    });
    srcDb.addParticipant(1, "Alice");
    srcDb.recordResult(1, "Alice", "accuracy", 0.95);

    // Ban
    srcDb.addBan("badguy", "Alice", "spamming");

    // Room source
    srcDb.saveRoomSource({
      roomId: "custom/room1",
      source: 'export default { short: "Custom", long: "A custom room." };',
      authorId: "e_1",
      authorName: "Alice",
      valid: true,
    });

    // Project
    srcDb.createProject({
      id: "proj_1",
      name: "Alpha",
      description: "Test project",
      createdBy: "Alice",
    });

    // Dynamic command
    srcDb.saveCommandSource({
      id: "cmd_1",
      name: "hello",
      source: 'export default { name: "hello", help: "Say hi", handler(ctx, input) {} };',
      createdBy: "Alice",
    });

    // Connector
    srcDb.createConnector({
      id: "conn_1",
      name: "brave",
      transport: "http",
      url: "https://brave.example.com/mcp",
      createdBy: "Alice",
    });
  }

  // ─── Export Tests ──────────────────────────────────────────────────

  describe("exportState", () => {
    it("should export all populated tables", () => {
      seedTestData();
      srcDb.close();

      const snapshot = exportState(SRC_DB);

      expect(snapshot.format).toBe("marina-snapshot");
      expect(snapshot.version).toBe(1);
      expect(snapshot.schema_version).toBe(50);
      expect(snapshot.exported_at).toBeTruthy();

      // Verify key tables are present
      expect(snapshot.tables.entities).toHaveLength(1);
      expect(snapshot.tables.users).toHaveLength(1);
      expect(snapshot.tables.channels).toHaveLength(1);
      expect(snapshot.tables.channel_members).toHaveLength(1);
      expect(snapshot.tables.channel_messages).toHaveLength(1);
      expect(snapshot.tables.boards).toHaveLength(1);
      expect(snapshot.tables.board_posts).toHaveLength(1);
      expect(snapshot.tables.board_votes).toHaveLength(1);
      expect(snapshot.tables.groups_).toHaveLength(1);
      expect(snapshot.tables.group_members).toHaveLength(1);
      expect(snapshot.tables.tasks).toHaveLength(1);
      expect(snapshot.tables.task_claims).toHaveLength(1);
      expect(snapshot.tables.macros).toHaveLength(1);
      expect(snapshot.tables.notes).toHaveLength(3); // 2 regular + 1 pool note
      expect(snapshot.tables.note_links).toHaveLength(1);
      expect(snapshot.tables.core_memory).toHaveLength(1);
      expect(snapshot.tables.memory_pools).toHaveLength(1);
      expect(snapshot.tables.experiments).toHaveLength(1);
      expect(snapshot.tables.experiment_participants).toHaveLength(1);
      expect(snapshot.tables.experiment_results).toHaveLength(1);
      expect(snapshot.tables.bans).toHaveLength(1);
      expect(snapshot.tables.room_sources).toHaveLength(1);
      expect(snapshot.tables.projects).toHaveLength(1);
      expect(snapshot.tables.dynamic_commands).toHaveLength(1);
      // connectors is secret-gated — omitted by default (see the dedicated secrets test)
      expect(snapshot.tables.connectors).toBeUndefined();
      expect(snapshot.tables.room_store).toHaveLength(1);

      // FTS tables should NOT be in the export
      expect(snapshot.tables.board_posts_fts).toBeUndefined();
      expect(snapshot.tables.notes_fts).toBeUndefined();

      // Sessions should NOT be in the export
      expect(snapshot.tables.sessions).toBeUndefined();
    });

    it("should skip event_log when requested", () => {
      srcDb.logEvent({
        type: "command",
        entity: entityId("e_1"),
        input: "look",
        timestamp: Date.now(),
      });
      srcDb.close();

      const snapshot = exportState(SRC_DB, { skipEventLog: true });
      expect(snapshot.tables.event_log).toBeUndefined();
    });

    it("omits secret-bearing tables (connectors) by default, includes them with includeSecrets", () => {
      srcDb.createConnector({
        id: "conn_1",
        name: "secret",
        transport: "http",
        url: "https://secret.example.com",
        createdBy: "admin",
      });
      srcDb.close();

      // Default export is safe to share — secrets omitted.
      expect(exportState(SRC_DB).tables.connectors).toBeUndefined();
      // Explicit opt-in includes them (full operational backup).
      expect(exportState(SRC_DB, { includeSecrets: true }).tables.connectors).toBeDefined();
    });

    it("should export an empty database without errors", () => {
      srcDb.close();

      const snapshot = exportState(SRC_DB);
      expect(snapshot.format).toBe("marina-snapshot");
      // Migration 23 seeds 12 default shell_allowlist entries
      expect(Object.keys(snapshot.tables).length).toBe(1);
      expect(snapshot.tables.shell_allowlist).toBeDefined();
    });

    it("should preserve entity properties as JSON strings", () => {
      srcDb.saveEntity({
        id: entityId("e_1"),
        kind: "agent",
        name: "Test",
        short: "Test is here.",
        long: "A test entity.",
        room: roomId("core/nexus"),
        properties: { rank: 3, custom: "value" },
        inventory: [entityId("e_2")],
        createdAt: 1000,
      });
      srcDb.close();

      const snapshot = exportState(SRC_DB);
      const exported = snapshot.tables.entities![0] as Record<string, unknown>;
      // Properties are stored as JSON strings in SQLite
      expect(typeof exported.properties).toBe("string");
      expect(JSON.parse(exported.properties as string)).toEqual({
        rank: 3,
        custom: "value",
      });
    });
  });

  // ─── Import Tests ──────────────────────────────────────────────────

  describe("importState", () => {
    it("should import a full snapshot into a fresh database", () => {
      seedTestData();
      srcDb.close();

      const snapshot = exportState(SRC_DB);

      // Import into a fresh DB
      const dstDb = new MarinaDB(DST_DB);
      dstDb.close();

      const result = importState(DST_DB, snapshot);
      expect(result.errors).toHaveLength(0);
      expect(result.tablesImported).toBeGreaterThan(15);
      expect(result.rowsImported).toBeGreaterThan(20);

      // Verify data in destination DB
      const verifyDb = new MarinaDB(DST_DB);

      // Entity
      const entity = verifyDb.loadEntity(entityId("e_1"));
      expect(entity).toBeDefined();
      expect(entity!.name).toBe("Alice");
      expect(entity!.properties.rank).toBe(2);

      // User
      const user = verifyDb.getUserByName("Alice");
      expect(user).toBeDefined();
      expect(user!.rank).toBe(2);

      // Channel + message
      const channel = verifyDb.getChannelByName("general");
      expect(channel).toBeDefined();
      const messages = verifyDb.getChannelHistory(channel!.id);
      expect(messages.length).toBeGreaterThan(0);

      // Board + post
      const board = verifyDb.getBoardByName("general");
      expect(board).toBeDefined();
      const posts = verifyDb.listBoardPosts(board!.id);
      expect(posts.length).toBe(1);
      expect(posts[0]!.title).toBe("First Post");

      // Group
      const group = verifyDb.getGroupByName("explorers");
      expect(group).toBeDefined();
      const members = verifyDb.getGroupMembers(group!.id);
      expect(members.length).toBe(1);

      // Task + claim
      const task = verifyDb.getTask(1);
      expect(task).toBeDefined();
      expect(task!.title).toBe("Map the world");
      const claims = verifyDb.getTaskClaims(1);
      expect(claims.length).toBe(1);

      // Note
      const notes = verifyDb.getNotesByEntity("Alice");
      expect(notes.length).toBeGreaterThanOrEqual(2);

      // Core memory
      const mem = verifyDb.getCoreMemory("Alice", "goal");
      expect(mem).toBeDefined();
      expect(mem!.value).toBe("Explore everything");

      // Memory pool
      const pool = verifyDb.getMemoryPool("research");
      expect(pool).toBeDefined();

      // Ban
      expect(verifyDb.isBanned("badguy")).toBe(true);

      // Project
      const project = verifyDb.getProjectByName("Alpha");
      expect(project).toBeDefined();

      // Experiment
      const exp = verifyDb.getExperimentByName("test-exp");
      expect(exp).toBeDefined();

      // Room store
      const storeVal = verifyDb.getRoomStoreValue(roomId("core/nexus"), "counter");
      expect(storeVal).toBe(42);

      verifyDb.close();
    });

    it("should rebuild FTS indexes after import", () => {
      // Create source data with a searchable note
      srcDb.createNote("Alice", "quantum physics is fascinating", "core/nexus");
      srcDb.createBoard({ id: "b_1", name: "general" });
      srcDb.createBoardPost({
        boardId: "b_1",
        authorId: "e_1",
        authorName: "Alice",
        title: "Quantum Results",
        body: "Our quantum experiment succeeded",
      });
      srcDb.close();

      const snapshot = exportState(SRC_DB);

      // Import
      const dstDb = new MarinaDB(DST_DB);
      dstDb.close();

      const result = importState(DST_DB, snapshot);
      expect(result.errors).toHaveLength(0);

      // Verify FTS works in destination
      const verifyDb = new MarinaDB(DST_DB);

      const noteResults = verifyDb.searchNotes("Alice", "quantum");
      expect(noteResults.length).toBe(1);
      expect(noteResults[0]!.content).toContain("quantum");

      const boardResults = verifyDb.searchBoardPosts("b_1", "quantum");
      expect(boardResults.length).toBe(1);
      expect(boardResults[0]!.title).toContain("Quantum");

      verifyDb.close();
    });

    it("should handle merge mode (INSERT OR REPLACE)", () => {
      // Create initial data in destination
      const dstDb = new MarinaDB(DST_DB);
      dstDb.createUser({ id: "u_existing", name: "Bob", rank: 1 });
      dstDb.close();

      // Create source with overlapping and new data
      srcDb.createUser({ id: "u_1", name: "Alice", rank: 2 });
      srcDb.close();

      const snapshot = exportState(SRC_DB);
      const result = importState(DST_DB, snapshot, { merge: true });
      expect(result.errors).toHaveLength(0);

      // Both users should exist
      const verifyDb = new MarinaDB(DST_DB);
      expect(verifyDb.getUserByName("Alice")).toBeDefined();
      expect(verifyDb.getUserByName("Bob")).toBeDefined();
      verifyDb.close();
    });

    it("should replace all data in default (non-merge) mode", () => {
      // Create initial data in destination
      const dstDb = new MarinaDB(DST_DB);
      dstDb.createUser({ id: "u_existing", name: "Bob", rank: 1 });
      dstDb.close();

      // Create source with different data
      srcDb.createUser({ id: "u_1", name: "Alice", rank: 2 });
      srcDb.close();

      const snapshot = exportState(SRC_DB);
      const result = importState(DST_DB, snapshot);
      expect(result.errors).toHaveLength(0);

      // Only Alice should exist (Bob was replaced)
      const verifyDb = new MarinaDB(DST_DB);
      expect(verifyDb.getUserByName("Alice")).toBeDefined();
      expect(verifyDb.getUserByName("Bob")).toBeUndefined();
      verifyDb.close();
    });

    it("should skip event_log on import when requested", () => {
      srcDb.logEvent({
        type: "command",
        entity: entityId("e_1"),
        input: "look",
        timestamp: Date.now(),
      });
      srcDb.close();

      const snapshot = exportState(SRC_DB);
      // The snapshot contains events
      expect(snapshot.tables.event_log).toBeDefined();

      // But import skips them
      const dstDb = new MarinaDB(DST_DB);
      dstDb.close();

      const result = importState(DST_DB, snapshot, { skipEventLog: true });
      expect(result.errors).toHaveLength(0);

      const verifyDb = new MarinaDB(DST_DB);
      expect(verifyDb.getEventCount()).toBe(0);
      verifyDb.close();
    });
  });

  // ─── Round-trip Integrity ──────────────────────────────────────────

  describe("round-trip integrity", () => {
    it("should preserve all data through export → import cycle", () => {
      seedTestData();
      srcDb.close();

      // Export
      const snapshot = exportState(SRC_DB);

      // Import into fresh DB
      const dstDb = new MarinaDB(DST_DB);
      dstDb.close();
      importState(DST_DB, snapshot);

      // Re-export from destination
      const reExport = exportState(DST_DB);

      // Compare table row counts
      for (const table of Object.keys(snapshot.tables)) {
        const srcRows = snapshot.tables[table]!.length;
        const dstRows = reExport.tables[table]?.length ?? 0;
        expect(dstRows).toBe(srcRows);
      }
    });
  });

  // ─── Validation ────────────────────────────────────────────────────

  describe("validateSnapshot", () => {
    it("should accept a valid snapshot", () => {
      const result = validateSnapshot({
        format: "marina-snapshot",
        version: 1,
        schema_version: 17,
        exported_at: new Date().toISOString(),
        tables: {},
      });
      expect(result.valid).toBe(true);
    });

    it("should reject null", () => {
      const result = validateSnapshot(null);
      expect(result.valid).toBe(false);
    });

    it("should reject wrong format", () => {
      const result = validateSnapshot({ format: "other", version: 1 });
      expect(result.valid).toBe(false);
    });

    it("should reject wrong version", () => {
      const result = validateSnapshot({
        format: "marina-snapshot",
        version: 99,
      });
      expect(result.valid).toBe(false);
    });

    it("should reject missing schema_version", () => {
      const result = validateSnapshot({
        format: "marina-snapshot",
        version: 1,
        tables: {},
      });
      expect(result.valid).toBe(false);
    });

    it("should reject missing tables", () => {
      const result = validateSnapshot({
        format: "marina-snapshot",
        version: 1,
        schema_version: 17,
      });
      expect(result.valid).toBe(false);
    });
  });

  // ─── Error Handling ────────────────────────────────────────────────

  describe("error handling", () => {
    it("should return errors for invalid snapshot format on import", () => {
      const dstDb = new MarinaDB(DST_DB);
      dstDb.close();

      const result = importState(DST_DB, {
        format: "wrong" as "marina-snapshot",
        version: 1,
        schema_version: 17,
        exported_at: "",
        tables: {},
      });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.tablesImported).toBe(0);
    });

    it("should ignore tables in snapshot that are not in the known table list", () => {
      srcDb.close();

      const snapshot: MarinaSnapshot = {
        format: "marina-snapshot",
        version: 1,
        schema_version: 17,
        exported_at: new Date().toISOString(),
        tables: {
          nonexistent_table: [{ id: 1, value: "test" }],
          entities: [],
        },
      };

      const dstDb = new MarinaDB(DST_DB);
      dstDb.close();

      const result = importState(DST_DB, snapshot);
      // Unknown tables are silently ignored (not in EXPORT_TABLES)
      expect(result.errors).toHaveLength(0);
      expect(result.tablesImported).toBe(0);
    });

    it("should handle empty snapshot gracefully", () => {
      srcDb.close();

      const snapshot: MarinaSnapshot = {
        format: "marina-snapshot",
        version: 1,
        schema_version: 17,
        exported_at: new Date().toISOString(),
        tables: {},
      };

      const dstDb = new MarinaDB(DST_DB);
      dstDb.close();

      const result = importState(DST_DB, snapshot);
      expect(result.errors).toHaveLength(0);
      expect(result.tablesImported).toBe(0);
      expect(result.rowsImported).toBe(0);
    });
  });

  // ─── Coverage / drift guard ────────────────────────────────────────

  describe("table coverage", () => {
    it("every persistent table is either in EXPORT_TABLES or explicitly excluded", () => {
      // Drift guard: a new migration that adds a table must also add it to
      // EXPORT_TABLES (or it'll be silently dropped on backup/restore) or to
      // the documented exclusions (sessions / schema_version / *_new / *_fts).
      const raw = new Database(SRC_DB, { readonly: true });
      const names = (
        raw.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((r) => r.name);
      raw.close();

      const exported = new Set<string>(EXPORT_TABLES);
      const uncovered = names.filter(
        (n) => !n.startsWith("sqlite_") && !exported.has(n) && !isExcludedFromExport(n),
      );
      expect(uncovered).toEqual([]);
    });
  });

  describe("civic substrate survives a round-trip", () => {
    it("preserves standing ledger, competence, roles, and agent configs", () => {
      // Standing ledger (source of truth for ranks) + a competence proof.
      srcDb.appendStandingEvent({
        entityId: "e_1",
        entityName: "Alice",
        kind: "pool_note",
        ref: "note:1",
        amount: 5,
        earnedAt: 1000,
      });
      srcDb.recordDemonstration("e_1", "code.exec", 0, 1000);
      // Custom role + trait.
      srcDb.saveTrait({
        name: "curious",
        category: "cognitive",
        prompt: "Ask why.",
        createdBy: "Alice",
      });
      srcDb.saveRole({ name: "scout", traits: ["curious"], createdBy: "Alice" });
      // Persistent agent config.
      srcDb.saveAgentConfig({
        name: "scout-bot",
        model: "marina/default",
        role: "scout",
        spawnedBy: "system",
      });
      srcDb.close();

      // Default export (no secrets) must still carry the civic substrate.
      const snapshot = exportState(SRC_DB);
      expect(snapshot.tables.entity_standing).toBeDefined();
      expect(snapshot.tables.entity_competence).toBeDefined();
      expect(snapshot.tables.roles).toBeDefined();
      expect(snapshot.tables.traits).toBeDefined();
      expect(snapshot.tables.agent_configs).toBeDefined();

      const dstDb = new MarinaDB(DST_DB);
      dstDb.close();
      const result = importState(DST_DB, snapshot);
      expect(result.errors).toHaveLength(0);

      const restored = new MarinaDB(DST_DB);
      expect(restored.getRole("scout")?.name).toBe("scout");
      expect(restored.getTrait("curious")?.prompt).toContain("Ask why");
      expect(restored.getAgentConfig("scout-bot")?.role).toBe("scout");
      // Standing recomputes from the restored ledger (it was the omitted source of truth before).
      const ledger = restored.ledgerForEntity("e_1", 10);
      expect(ledger.length).toBeGreaterThan(0);
      restored.close();
    });
  });
});
