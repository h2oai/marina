// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { composeRolePrompt, resolveRole, splitRoleLoopBlocks } from "../src/agent/roles";
import { parseRoleArgs } from "../src/engine/commands/role";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const parse = (line: string) => parseRoleArgs(line.split(/\s+/));

describe("role create/edit arguments", () => {
  it("lets a guideline contain spaces, separated by |", () => {
    expect(parse("guidelines Cite your sources | Say what you did not check tone plain")).toEqual({
      guidelines: ["Cite your sources", "Say what you did not check"],
      tone: "plain",
    });
  });

  it("still parses the one-token forms", () => {
    expect(parse("traits curious,terse guidelines a|b focus x,y tone calm origin seed")).toEqual({
      traits: ["curious", "terse"],
      guidelines: ["a", "b"],
      focus: ["x", "y"],
      tone: "calm",
      origin: "seed",
    });
  });

  it("keeps a capitalized field word inside text as text", () => {
    expect(parse("guidelines Set the Tone early | Keep Focus on the task tone warm")).toEqual({
      guidelines: ["Set the Tone early", "Keep Focus on the task"],
      tone: "warm",
    });
    expect(parse("description Sets the Tone for a crew traits curious")).toEqual({
      description: "Sets the Tone for a crew",
      traits: ["curious"],
    });
  });

  it("accepts fields in any order, and a capitalized first field", () => {
    expect(parse("Tone precise guidelines Answer with only the final answer")).toEqual({
      tone: "precise",
      guidelines: ["Answer with only the final answer"],
    });
  });
});

describe("role loop sections", () => {
  const DB = `test_role_loop_${process.pid}.db`;
  afterEach(() => cleanupDb(DB));

  it("parses the loop fields as free text", () => {
    expect(
      parse("tone calm every_turn Do whatever seems most alive operating_loop Wander then write"),
    ).toEqual({
      tone: "calm",
      loop: { every_turn: "Do whatever seems most alive", operating_loop: "Wander then write" },
    });
  });

  it("stores them (migration 141) and resolves them into the composed role", () => {
    const db = new MarinaDB(DB);
    try {
      db.saveRole({
        name: "wanderer",
        loop: { how_to_be: "Stay curious.", every_turn: "  " },
        createdBy: "ada",
      });
      const resolved = resolveRole(db, "wanderer");
      expect(resolved?.loop).toEqual({ how_to_be: "Stay curious." });
      const composed = composeRolePrompt(resolved!);
      expect(splitRoleLoopBlocks(composed)).toEqual({
        prose: "# YOUR ROLE: WANDERER",
        loop: { how_to_be: "Stay curious." },
      });
      // A role without loop sections serializes exactly as before.
      db.saveRole({ name: "plain", tone: "calm", createdBy: "ada" });
      expect(db.getRoleHistory("plain")[0]!.new_value).not.toContain("loop");
    } finally {
      db.close();
    }
  });
});
