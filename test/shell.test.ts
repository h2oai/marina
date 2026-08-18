// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { Engine } from "../src/engine/engine";
import { ShellRuntime } from "../src/engine/shell-runtime";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, grantAllGates, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_shell.db";
const SCRATCH_ROOT = "test_scratch";

describe("Shell", () => {
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

    // Give Alice architect rank (5) and grant all safety gates so the
    // shell/run subcommands work in tests without seeding standing + demos.
    const entity = engine.entities.get(conn.entity!);
    if (entity) entity.properties.rank = 5;
    grantAllGates(db, conn.entity!);

    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    if (existsSync(SCRATCH_ROOT)) {
      rmSync(SCRATCH_ROOT, { recursive: true });
    }
    if (existsSync("data/scratch")) {
      rmSync("data/scratch", { recursive: true });
    }
  });

  // ─── ShellRuntime Unit Tests ──────────────────────────────────────────

  describe("ShellRuntime", () => {
    let runtime: ShellRuntime;

    beforeEach(() => {
      runtime = new ShellRuntime(db, SCRATCH_ROOT);
      runtime.init();
    });

    it("should initialize scratch root directory", () => {
      expect(existsSync(SCRATCH_ROOT)).toBe(true);
    });

    it("should create entity scratch dir on demand", () => {
      const dir = runtime.scratchDir("entity_1");
      expect(existsSync(dir)).toBe(true);
      expect(dir).toContain("entity_1");
    });

    it("should execute allowed binary", async () => {
      const result = await runtime.exec("entity_1", "echo", ["hello world"]);
      expect(result.exitCode).toBe(0);
      expect(result.preview).toContain("hello world");
      expect(result.timedOut).toBe(false);
    });

    it("should reject unlisted binary", async () => {
      expect(runtime.exec("entity_1", "python3", [])).rejects.toThrow("not in the shell allowlist");
    });

    it("should reject binary with path", async () => {
      expect(runtime.exec("entity_1", "/usr/bin/echo", [])).rejects.toThrow(
        "Binary paths are not allowed",
      );
    });

    it("should reject shell metacharacters in args", async () => {
      expect(runtime.exec("entity_1", "echo", ["hello; rm -rf /"])).rejects.toThrow(
        "Shell metacharacters",
      );
    });

    it("should allow metacharacters in raw mode", async () => {
      const result = await runtime.execRaw("entity_2", "echo hello && echo world");
      expect(result.exitCode).toBe(0);
      expect(result.preview).toContain("hello");
      expect(result.preview).toContain("world");
    });

    it("should enforce rate limiting", async () => {
      await runtime.exec("entity_3", "echo", ["first"]);
      expect(runtime.exec("entity_3", "echo", ["second"])).rejects.toThrow("Rate limited");
    });

    it("should write output file to scratch", async () => {
      const result = await runtime.exec("entity_4", "echo", ["output test"]);
      expect(result.outputFile).toMatch(/^output-\d+\.txt$/);
      const content = await runtime.readScratchFile("entity_4", result.outputFile);
      expect(content).toContain("output test");
    });

    it("should detect new files created during execution", async () => {
      const result = await runtime.execRaw("entity_5", 'echo "file content" > testfile.txt');
      expect(result.newFiles).toContain("testfile.txt");
    });

    it("should truncate long output in preview", async () => {
      // Generate 300 lines of output
      const cmd = 'for i in $(seq 1 300); do echo "line $i"; done';
      const result = await runtime.execRaw("entity_6", cmd);
      expect(result.truncated).toBe(true);
      expect(result.preview).toContain("more lines");
    });

    it("should store last exec result", async () => {
      await runtime.exec("entity_7", "echo", ["stored"]);
      const last = runtime.getLastExec("entity_7");
      expect(last).toBeDefined();
      expect(last!.exitCode).toBe(0);
    });

    it("should log execution to database", async () => {
      await runtime.exec("entity_8", "echo", ["logged"]);
      const history = db.getShellHistory("entity_8");
      expect(history.length).toBe(1);
      expect(history[0]!.binary).toBe("echo");
      expect(history[0]!.args).toBe("logged");
    });

    it("should handle command timeout", async () => {
      const result = await runtime.execRaw("entity_9", "sleep 10", 500);
      expect(result.timedOut).toBe(true);
    });

    it("should confine scratch file reads", async () => {
      const content = await runtime.readScratchFile("entity_10", "../etc/passwd");
      expect(content).toBeNull();
    });

    it("should confine scratch file deletes", () => {
      const deleted = runtime.deleteScratchFile("entity_10", "../etc/passwd");
      expect(deleted).toBe(false);
    });

    it("should list scratch files", async () => {
      await runtime.exec("entity_11", "echo", ["test"]);
      const files = runtime.listScratch("entity_11");
      expect(files.length).toBeGreaterThan(0);
    });
  });

  // ─── Allowlist DB Methods ─────────────────────────────────────────────

  describe("Allowlist", () => {
    it("should seed default allowlist on migration", () => {
      const list = db.getShellAllowlist();
      expect(list).toContain("curl");
      expect(list).toContain("wget");
      expect(list).toContain("ls");
      expect(list).toContain("echo");
      expect(list).toContain("jq");
      expect(list.length).toBe(12);
    });

    it("should check if binary is allowed", () => {
      expect(db.isShellAllowed("curl")).toBe(true);
      expect(db.isShellAllowed("rm")).toBe(false);
    });

    it("should add binary to allowlist", () => {
      db.addToShellAllowlist("python3", "admin");
      expect(db.isShellAllowed("python3")).toBe(true);
    });

    it("should remove binary from allowlist", () => {
      const removed = db.removeFromShellAllowlist("curl");
      expect(removed).toBe(true);
      expect(db.isShellAllowed("curl")).toBe(false);
    });

    it("should handle duplicate adds gracefully", () => {
      db.addToShellAllowlist("curl", "admin");
      expect(db.getShellAllowlist().filter((b) => b === "curl").length).toBe(1);
    });
  });

  // ─── Run Command (Integration) ────────────────────────────────────────

  describe("run command", () => {
    const wait = () => new Promise((r) => setTimeout(r, 300));

    it("should execute echo and display output", async () => {
      const entity = engine.entities.get(conn.entity!);
      if (entity) entity.properties.rank = 6; // engineer rank for run
      engine.processCommand(conn.entity!, "run echo hello");
      await wait();
      const text = stripAnsi(conn.allTextJoined());
      expect(text).toContain("hello");
      expect(text).toContain("exit 0");
    });

    it("should reject guest rank", () => {
      const entity = engine.entities.get(conn.entity!);
      if (entity) entity.properties.rank = 0;
      engine.processCommand(conn.entity!, "run echo test");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("at least");
    });

    it("should show help with no args", () => {
      const entity = engine.entities.get(conn.entity!);
      if (entity) entity.properties.rank = 6; // engineer rank for run
      engine.processCommand(conn.entity!, "run");
      const text = conn.lastText();
      expect(text).toContain("Execute shell commands");
    });

    it("should reject raw mode for non-sovereign", async () => {
      const entity = engine.entities.get(conn.entity!);
      if (entity) entity.properties.rank = 6; // engineer — can run but not raw
      engine.processCommand(conn.entity!, "run raw echo test");
      await wait();
      const text = stripAnsi(conn.allTextJoined());
      expect(text).toContain("sovereign rank");
    });

    it("should allow raw mode for sovereign", async () => {
      const entity = engine.entities.get(conn.entity!);
      if (entity) entity.properties.rank = 9;
      engine.processCommand(conn.entity!, "run raw echo piped");
      await wait();
      const text = stripAnsi(conn.allTextJoined());
      expect(text).toContain("piped");
    });

    it("should run quiet mode", async () => {
      const entity = engine.entities.get(conn.entity!);
      if (entity) entity.properties.rank = 6; // engineer rank for run
      engine.processCommand(conn.entity!, "run quiet echo silent");
      await wait();
      const text = stripAnsi(conn.allTextJoined());
      expect(text).not.toContain("silent");
      expect(text).toContain("exit");
      expect(text).toContain("output:");
    });
  });

  // ─── Shell Command (Integration) ──────────────────────────────────────

  describe("shell command", () => {
    it("should list allowlist", () => {
      engine.processCommand(conn.entity!, "shell list");
      const text = stripAnsi(conn.allTextJoined());
      expect(text).toContain("curl");
      expect(text).toContain("echo");
    });

    it("should reject allow for non-steward", () => {
      engine.processCommand(conn.entity!, "shell allow python3");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("steward rank");
    });

    it("should allow steward to add to allowlist", () => {
      const entity = engine.entities.get(conn.entity!);
      if (entity) entity.properties.rank = 7;
      engine.processCommand(conn.entity!, "shell allow python3");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("added");
      expect(db.isShellAllowed("python3")).toBe(true);
    });

    it("should allow steward to deny from allowlist", () => {
      const entity = engine.entities.get(conn.entity!);
      if (entity) entity.properties.rank = 7;
      engine.processCommand(conn.entity!, "shell deny curl");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("removed");
      expect(db.isShellAllowed("curl")).toBe(false);
    });

    it("should show shell history", async () => {
      // Run a command first to have history (need engineer rank for run)
      const entity = engine.entities.get(conn.entity!);
      if (entity) entity.properties.rank = 6;
      engine.processCommand(conn.entity!, "run echo history test");
      // Wait for async command to complete
      await new Promise((r) => setTimeout(r, 200));
      conn.clear();

      engine.processCommand(conn.entity!, "shell history");
      const text = stripAnsi(conn.allTextJoined());
      expect(text).toContain("echo");
    });

    it("should show help with no args", () => {
      engine.processCommand(conn.entity!, "shell");
      const text = conn.lastText();
      expect(text).toContain("Shell management");
    });

    it("should use sh alias", () => {
      engine.processCommand(conn.entity!, "sh list");
      const text = stripAnsi(conn.allTextJoined());
      expect(text).toContain("curl");
    });
  });
});
