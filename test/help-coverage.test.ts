// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { categorizeCommand } from "../src/engine/commands/help";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_help_coverage.db";

/**
 * Every primitive a user can run must be documented in `help`: it must be
 * registered, carry non-empty help text, and resolve to a real category (not
 * the "Other" catch-all). These assertions run against the FULL builtin set —
 * including db/manager-gated commands — so a newly added command that forgets
 * to categorize itself fails here instead of silently landing in "Other".
 */
describe("help coverage", () => {
  let db: MarinaDB;
  let engine: Engine;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    // A db-backed engine constructs every manager (channels, boards, groups,
    // tasks, macros, crews), so all conditionally-registered commands register.
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("registers a substantial set of builtins (sanity)", () => {
    expect(engine.commands.allBuiltins().length).toBeGreaterThan(70);
  });

  it('categorizes every registered command (none fall into "Other")', () => {
    const uncategorized = engine.commands
      .allBuiltins()
      .filter((cmd) => categorizeCommand(cmd) === "Other")
      .map((cmd) => cmd.name);
    expect(uncategorized).toEqual([]);
  });

  it("gives every registered command non-empty help text", () => {
    const missingHelp = engine.commands
      .allBuiltins()
      .filter((cmd) => !cmd.help || cmd.help.trim().length === 0)
      .map((cmd) => cmd.name);
    expect(missingHelp).toEqual([]);
  });

  it("has no duplicate names or alias collisions across builtins", () => {
    const seen = new Map<string, string>(); // token -> owning command
    const collisions: string[] = [];
    for (const cmd of engine.commands.allBuiltins()) {
      for (const token of [cmd.name, ...(cmd.aliases ?? [])]) {
        const prior = seen.get(token);
        if (prior && prior !== cmd.name) collisions.push(`${token} (${prior} vs ${cmd.name})`);
        else seen.set(token, cmd.name);
      }
    }
    expect(collisions).toEqual([]);
  });
});
