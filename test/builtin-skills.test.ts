// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BUILTIN_SKILLS, builtinSkill, searchBuiltinSkills } from "../src/agent/builtin-skills";
import { loadSkillFile } from "../src/agent/skill-import";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { seedTraitsAndRoles } from "../worlds/seed";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_builtin_skills_cmd.db";

describe("built-in skill library", () => {
  it("ships the quantitative-estimates skill exactly as its seed file", () => {
    expect(BUILTIN_SKILLS.map((s) => s.name)).toEqual(["quantitative-estimates", "intake-triage"]);
    expect(builtinSkill(" Quantitative-Estimates ")).toEqual(
      loadSkillFile("seeds/skills/quantitative-estimates.md"),
    );
    expect(builtinSkill("nope")).toBeUndefined();
  });

  it("search matches name, description and tags by word", () => {
    expect(searchBuiltinSkills("percent change").map((s) => s.name)).toEqual([
      "quantitative-estimates",
    ]);
    expect(searchBuiltinSkills("buckets")).toHaveLength(1);
    expect(searchBuiltinSkills("poetry")).toEqual([]);
    expect(searchBuiltinSkills("a b")).toEqual([]);
  });
});

describe("skill builtin / skill search reach it with no import", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    conn.clear();
  });

  afterEach(() => {
    engine.shutdown();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("lists and shows built-in skills at rank 0, writing no note", () => {
    engine.processCommand(conn.entity!, "skill builtin");
    expect(stripAnsi(conn.lastText())).toContain("quantitative-estimates:");
    conn.clear();
    engine.processCommand(conn.entity!, "skill builtin quantitative-estimates");
    const text = stripAnsi(conn.lastText());
    expect(text).toContain("[Skill: quantitative-estimates]");
    expect(text).toContain("quant buckets");
    conn.clear();
    engine.processCommand(conn.entity!, "skill builtin nope");
    expect(stripAnsi(conn.lastText())).toContain('No built-in skill "nope"');
    expect(db.getNotesByType("Alice", "skill")).toHaveLength(0);
  });

  it("skill search finds the built-in skill when no note matches", () => {
    engine.processCommand(conn.entity!, "skill search growth extrapolation");
    const text = stripAnsi(conn.lastText());
    expect(text).toContain('built-in "quantitative-estimates"');
    expect(text).toContain("skill builtin quantitative-estimates");
    conn.clear();
    engine.processCommand(conn.entity!, "skill search zzzqqq");
    expect(stripAnsi(conn.lastText())).toContain("No matching skills found.");
  });

  it("the quantitative-estimates trait points every numeric role at it", () => {
    seedTraitsAndRoles(db);
    const trait = db.getTrait("quantitative-estimates");
    expect(trait?.prompt).toContain("skill builtin quantitative-estimates");
    expect(db.getTrait("intake-triage")?.prompt).toContain("skill builtin intake-triage");
    for (const role of ["researcher", "market-oracle"]) {
      expect(JSON.parse(db.getRole(role)!.traits)).toContain("quantitative-estimates");
      expect(JSON.parse(db.getRole(role)!.traits)).toContain("intake-triage");
    }
    // Seeding stays idempotent.
    seedTraitsAndRoles(db);
    expect(JSON.parse(db.getRole("researcher")!.traits)).toContain("quantitative-estimates");
  });
});
