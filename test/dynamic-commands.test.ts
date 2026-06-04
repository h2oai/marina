import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import {
  compileCommandModule,
  DEFAULT_COMMAND_SOURCE,
  validateCommandSource,
} from "../src/engine/sandbox";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_dynamic_commands.db";

describe("Dynamic Commands", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    conn1 = new MockConnection("c1");
    engine.addConnection(conn1);
    engine.spawnEntity("c1", "Alice");

    // Give Alice architect rank (5) for build command
    const entity = engine.entities.get(conn1.entity!);
    if (entity) entity.properties.rank = 5;

    conn1.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  // ─── Sandbox Validation ──────────────────────────────────────────────────

  describe("Command Source Validation", () => {
    it("should validate valid command source", () => {
      const result = validateCommandSource(DEFAULT_COMMAND_SOURCE);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it("should reject source with forbidden patterns", () => {
      const source = `export default {
        name: "bad",
        help: "bad command",
        handler(ctx, input) { eval("alert()"); },
      };`;
      const result = validateCommandSource(source);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should reject source without default export", () => {
      const source = `const cmd = { name: "x", help: "x", handler() {} };`;
      const result = validateCommandSource(source);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "Command source must have a default export (export default { ... })",
      );
    });
  });

  describe("Command Compilation", () => {
    it("should compile valid command source", async () => {
      const source = `export default {
        name: "test",
        help: "A test command",
        handler(ctx, input) { ctx.send(input.entity, "works"); },
      };`;
      const cmd = await compileCommandModule(source);
      expect(cmd.name).toBe("test");
      expect(cmd.help).toBe("A test command");
      expect(typeof cmd.handler).toBe("function");
    });

    it("should reject module without name", async () => {
      const source = `export default { help: "x", handler() {} };`;
      await expect(compileCommandModule(source)).rejects.toThrow("non-empty 'name'");
    });

    it("should reject module without handler", async () => {
      const source = `export default { name: "x", help: "x" };`;
      await expect(compileCommandModule(source)).rejects.toThrow("'handler' function");
    });
  });

  // ─── Build Command Integration ──────────────────────────────────────────

  describe("Build Command - create", () => {
    it("should create a dynamic command", () => {
      engine.processCommand(conn1.entity!, "build command create testcmd");
      expect(conn1.lastText()).toContain('Created command "testcmd"');

      const cmd = db.getCommandByName("testcmd");
      expect(cmd).toBeDefined();
      expect(cmd!.name).toBe("testcmd");
    });

    it("should reject duplicate command names", () => {
      engine.processCommand(conn1.entity!, "build command create testcmd");
      conn1.clear();
      engine.processCommand(conn1.entity!, "build command create testcmd");
      expect(conn1.lastText()).toContain("already exists");
    });

    it("should reject short names", () => {
      engine.processCommand(conn1.entity!, "build command create x");
      expect(conn1.lastText()).toContain("2-30 characters");
    });
  });

  describe("Build Command - code", () => {
    it("should set command source", () => {
      engine.processCommand(conn1.entity!, "build command create testcmd");
      conn1.clear();
      const source =
        'export default { name: "testcmd", help: "test", handler(ctx, input) { ctx.send(input.entity, "hi"); } };';
      engine.processCommand(conn1.entity!, `build command code testcmd ${source}`);
      expect(conn1.lastText()).toContain("Saved source");

      const cmd = db.getCommandByName("testcmd");
      expect(cmd!.source).toContain("testcmd");
    });

    it("should show current source when no source provided", () => {
      engine.processCommand(conn1.entity!, "build command create testcmd");
      conn1.clear();
      engine.processCommand(conn1.entity!, "build command code testcmd");
      expect(conn1.lastText()).toContain("Source for command");
    });
  });

  describe("Build Command - validate", () => {
    it("should validate command source", () => {
      engine.processCommand(conn1.entity!, "build command create testcmd");
      conn1.clear();
      engine.processCommand(conn1.entity!, "build command validate testcmd");
      expect(conn1.lastText()).toContain("is valid");
    });

    it("should report not found", () => {
      engine.processCommand(conn1.entity!, "build command validate nonexistent");
      expect(conn1.lastText()).toContain("not found");
    });
  });

  describe("Build Command - reload", () => {
    it("should compile and register a dynamic command", async () => {
      const source =
        'export default { name: "greet", help: "greet someone", handler(ctx, input) { ctx.send(input.entity, "Hello " + input.args); } };';
      engine.processCommand(conn1.entity!, "build command create greet");
      conn1.clear();
      engine.processCommand(conn1.entity!, `build command code greet ${source}`);
      conn1.clear();

      // Reload is async
      await engine.processCommand(conn1.entity!, "build command reload greet");

      // Wait for async handler
      await Bun.sleep(100);
      const text = conn1.allTextJoined();
      expect(text).toContain("reloaded and registered");

      // Command should now be usable
      conn1.clear();
      engine.processCommand(conn1.entity!, "greet World");
      expect(conn1.lastText()).toContain("Hello World");
    });
  });

  describe("Build Command - list", () => {
    it("should list dynamic commands", () => {
      engine.processCommand(conn1.entity!, "build command create alpha");
      engine.processCommand(conn1.entity!, "build command create beta");
      conn1.clear();
      engine.processCommand(conn1.entity!, "build command list");
      const text = conn1.lastText();
      expect(text).toContain("Dynamic Commands");
      expect(text).toContain("alpha");
      expect(text).toContain("beta");
    });

    it("should show empty message when no commands", () => {
      engine.processCommand(conn1.entity!, "build command list");
      expect(conn1.lastText()).toContain("No dynamic commands");
    });
  });

  describe("Build Command - destroy", () => {
    it("should destroy a dynamic command", () => {
      engine.processCommand(conn1.entity!, "build command create testcmd");
      conn1.clear();
      engine.processCommand(conn1.entity!, "build command destroy testcmd");
      expect(conn1.lastText()).toContain("destroyed");

      const cmd = db.getCommandByName("testcmd");
      expect(cmd).toBeUndefined();
    });
  });

  describe("Build Command - audit", () => {
    it("should show command history", () => {
      engine.processCommand(conn1.entity!, "build command create testcmd");
      // Edit it
      const source = 'export default { name: "testcmd", help: "v2", handler(ctx, input) {} };';
      engine.processCommand(conn1.entity!, `build command code testcmd ${source}`);
      conn1.clear();
      engine.processCommand(conn1.entity!, "build command audit testcmd");
      const text = conn1.lastText();
      expect(text).toContain("Command History");
      expect(text).toContain("testcmd");
    });
  });

  // ─── DB Methods ────────────────────────────────────────────────────────

  describe("DB Methods", () => {
    it("should save and retrieve commands", () => {
      db.saveCommandSource({
        id: "cmd_test_1",
        name: "dbtest",
        source: "export default { name: 'dbtest', help: 'test', handler() {} };",
        createdBy: "system",
      });
      const cmd = db.getCommandByName("dbtest");
      expect(cmd).toBeDefined();
      expect(cmd!.name).toBe("dbtest");
      expect(cmd!.version).toBe(1);
      expect(cmd!.valid).toBe(0);
    });

    it("should update existing commands with history", () => {
      db.saveCommandSource({
        id: "cmd_test_2",
        name: "dbupdate",
        source: "v1 source",
        createdBy: "Alice",
      });
      db.saveCommandSource({
        id: "cmd_test_2",
        name: "dbupdate",
        source: "v2 source",
        createdBy: "Bob",
      });

      const cmd = db.getCommandByName("dbupdate");
      expect(cmd!.source).toBe("v2 source");
      expect(cmd!.version).toBe(2);

      const history = db.getCommandHistory("dbupdate");
      expect(history.length).toBe(1);
      expect(history[0]!.source).toBe("v1 source");
    });

    it("should list and delete commands", () => {
      db.saveCommandSource({ id: "cmd_a", name: "aaa", source: "a", createdBy: "s" });
      db.saveCommandSource({ id: "cmd_b", name: "bbb", source: "b", createdBy: "s" });
      expect(db.listCommands().length).toBe(2);

      db.deleteCommand("aaa");
      expect(db.listCommands().length).toBe(1);
    });

    it("should mark commands valid", () => {
      db.saveCommandSource({ id: "cmd_v", name: "valid", source: "v", createdBy: "s" });
      expect(db.getCommandByName("valid")!.valid).toBe(0);

      db.markCommandValid("valid");
      expect(db.getCommandByName("valid")!.valid).toBe(1);

      const names = db.getAllValidCommandNames();
      expect(names).toContain("valid");
    });
  });

  // ─── Rank Requirements ─────────────────────────────────────────────────

  describe("Rank Requirements", () => {
    it("should require builder rank for build command", () => {
      const entity = engine.entities.get(conn1.entity!);
      if (entity) entity.properties.rank = 1; // canvas
      conn1.clear();
      engine.processCommand(conn1.entity!, "build command create testcmd");
      expect(conn1.lastText()).toContain("rank 4");
    });
  });
});
