// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { parseRoleArgs } from "../src/engine/commands/role";

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
