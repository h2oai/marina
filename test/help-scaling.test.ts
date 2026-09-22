// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  COMMAND_CATEGORIES,
  HELP_PREVIEW_LINES,
  resolveCategory,
  usageExcerpt,
} from "../src/engine/commands/help";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_help_scaling.db";

describe("usageExcerpt", () => {
  it("returns short marker-less text untouched", () => {
    const { text, truncated } = usageExcerpt("Look around the room.");
    expect(text).toBe("Look around the room.");
    expect(truncated).toBe(false);
  });

  it("caps marker-less text at the preview line count", () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const { text, truncated } = usageExcerpt(long);
    expect(text.split("\n")).toHaveLength(HELP_PREVIEW_LINES);
    expect(truncated).toBe(true);
  });

  it("extracts the first Usage block plus the leading summary line", () => {
    const help = [
      "Coding sessions.",
      "Usage:",
      "  code            Enter Code Mode",
      "  code run <cmd>  Run a command",
      "",
      "Subcommands in depth:",
      "  ...hundreds of lines...",
    ].join("\n");
    const { text, truncated } = usageExcerpt(help);
    expect(text).toBe(
      [
        "Coding sessions.",
        "Usage:",
        "  code            Enter Code Mode",
        "  code run <cmd>  Run a command",
      ].join("\n"),
    );
    expect(truncated).toBe(true);
  });

  it("is not truncated when the Usage block is the whole text", () => {
    const help = "Show available commands. Usage: help [command | all]";
    const { text, truncated } = usageExcerpt(help);
    expect(text).toBe(help);
    expect(truncated).toBe(false);
  });
});

describe("resolveCategory", () => {
  const cats = Object.keys(COMMAND_CATEGORIES);

  it("matches exactly, case-insensitively", () => {
    expect(resolveCategory("memory", cats)).toBe("Memory");
    expect(resolveCategory("Canvas & Media", cats)).toBe("Canvas & Media");
  });

  it("accepts a unique prefix and rejects an ambiguous one", () => {
    expect(resolveCategory("nav", cats)).toBe("Navigation");
    // "C" prefixes Communication, Cognition, Coordination, Civic, Canvas & Media.
    expect(resolveCategory("c", cats)).toBeUndefined();
    expect(resolveCategory("nope", cats)).toBeUndefined();
  });
});

describe("help command scaling", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Helper");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  const run = (cmd: string): string => {
    conn.clear();
    engine.processCommand(conn.entity!, cmd);
    return stripAnsi(conn.lastText());
  };

  it("no-arg help is a starter block plus one line per category, not the full dump", () => {
    const text = run("help");
    expect(text).toContain("help <category>");
    expect(text).toContain("help <command>");
    expect(text).toContain("help all");
    expect(text).toContain("readiness");
    expect(text).toContain("guide");
    expect(text).toContain("Categories");
    // One category per line with a count.
    expect(text).toMatch(/Navigation \(\d+\)/);
    expect(text).toMatch(/Memory \(\d+\)/);
    // Short: far fewer lines than the number of registered commands.
    const lineCount = text.split("\n").length;
    expect(lineCount).toBeLessThan(engine.commands.allBuiltins().length / 2);
    // The full dump renders each command's description; the starter does not.
    expect(text).not.toContain("Available Commands");
  });

  it("help all is the full grouped dump", () => {
    const text = run("help all");
    expect(text).toContain("Available Commands");
    for (const name of ["look", "say", "note", "recall", "agent"]) {
      expect(text).toMatch(new RegExp(`^\\s+${name}\\b`, "m"));
    }
    expect(text.split("\n").length).toBeGreaterThan(engine.commands.allBuiltins().length);
  });

  it("help <category> lists exactly that category's commands", () => {
    const text = run("help navigation");
    expect(text).toContain("Navigation");
    for (const name of COMMAND_CATEGORIES.Navigation!) {
      expect(text).toMatch(new RegExp(`^\\s+${name}\\b`, "m"));
    }
    expect(text).not.toMatch(/^\s+note\b/m);
  });

  it("help <category prefix> works when unique", () => {
    const text = run("help nav");
    expect(text).toContain("Navigation");
    expect(text).toMatch(/^\s+look\b/m);
  });

  it("a token that is both a command and a category prefers the command and mentions the category", () => {
    const text = run("help memory");
    // Command detail header, not the category listing.
    expect(text.split("\n")[0]).toContain("memory");
    expect(text).toContain("Category:");
    expect(text).toContain('"Memory" is also a category');
    expect(text).toContain("help memory");
  });

  it("help <cmd> shows the Usage block only, with a full hint; help <cmd> full shows everything", () => {
    const code = engine.commands.allBuiltins().find((c) => c.name === "code");
    expect(code).toBeDefined();
    const short = run("help code");
    expect(short).toContain("Usage:");
    expect(short).toContain("help code full");
    expect(short.length).toBeLessThan(code!.help.length);

    const full = run("help code full");
    expect(full).toContain(code!.help.split("\n")[0]!);
    expect(full.length).toBeGreaterThanOrEqual(code!.help.length);
    expect(full).not.toContain("help code full");
  });

  it("help <alias> still resolves the command", () => {
    const text = run("help ?");
    expect(text.split("\n")[0]).toContain("help");
    expect(text).toContain("Usage:");
  });

  it("unknown tokens get a pointer back to the categories", () => {
    const text = run("help definitelynotacommand");
    expect(text).toContain("Unknown command or category");
    expect(text).toContain("help all");
  });
});
