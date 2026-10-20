// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BUILTIN_SKILLS, builtinSkill, searchBuiltinSkills } from "../src/agent/builtin-skills";
import { loadSkillFile } from "../src/agent/skill-import";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { seedChroniclerRole, seedTraitsAndRoles } from "../worlds/seed";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_builtin_skills_cmd.db";

describe("built-in skill library", () => {
  it("ships the quantitative-estimates skill exactly as its seed file", () => {
    expect(BUILTIN_SKILLS.map((s) => s.name)).toEqual([
      "quantitative-estimates",
      "intake-triage",
      "decompose-multihop",
      "solve-math",
      "answer-request",
      "chronicling",
      "canvas-intents",
      "consolidate-memory",
    ]);
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

describe("progressive disclosure: long trait and reflection prose lives in built-in skills", () => {
  const traitPrompt = (name: string) => {
    const db = new MarinaDB(":memory:");
    try {
      seedTraitsAndRoles(db);
      seedChroniclerRole(db);
      return db.getTrait(name)?.prompt ?? "";
    } finally {
      db.close();
    }
  };

  it("the chronicling trait keeps every rule in one line each and points at its skill", () => {
    const trait = traitPrompt("chronicling");
    expect(Buffer.byteLength(trait)).toBeLessThan(800); // was 1,879 B
    for (const rule of [
      "append-only",
      "`chronicle pending`",
      "citing every source id",
      "`chronicle correct`",
      "at most ONE named participant per cycle",
      "never the same agent twice",
      "sparse fact-only entry",
      "Never embellish, speculate, praise or critique",
      "`skill builtin chronicling`",
    ])
      expect(trait).toContain(rule);
    const skill = builtinSkill("chronicling")!;
    for (const detail of [
      "chronicle digest day",
      "recap chronicle week",
      "note:<their reply note id>",
      "memory set last_interview:<name>",
      "memory get last_interview:<name>",
    ])
      expect(skill.body).toContain(detail);
  });

  it("the canvas-watcher trait (in every `general` agent) points at canvas-intents", () => {
    const trait = traitPrompt("canvas-watcher");
    expect(Buffer.byteLength(trait)).toBeLessThan(500); // was 832 B
    for (const rule of [
      "`canvas intent list`",
      "`canvas intent claim <node_id>`",
      "`canvas intent complete <node_id> <result>`",
      "`canvas intent fail <node_id> <reason>`",
      "Skip intents outside your expertise",
      "5 minutes",
      "`skill builtin canvas-intents`",
    ])
      expect(trait).toContain(rule);
    const skill = builtinSkill("canvas-intents")!;
    expect(skill.body).toContain("--type document");
    expect(skill.body).toContain("complete-rich <node_id> <a2ui_json>");
  });

  it("the reflection procedure is the consolidate-memory skill", () => {
    const skill = builtinSkill("consolidate-memory")!;
    for (const step of ["**Generate.**", "**Reflect.**", "**Curate.**", "note link", "skill store"])
      expect(skill.body).toContain(step);
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
