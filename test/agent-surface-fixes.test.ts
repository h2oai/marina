// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-surface repairs: `batch` splits only at command boundaries, the
 * `project:<name>` board alias, malformed `marina_tell` argument repair,
 * correlated command output kept out of the perception buffer, ANSI-free tool
 * text, and the clamped focus directive.
 */

import { describe, expect, it } from "bun:test";
import { isSelfEchoPerception, LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { formatPerceptions } from "../src/agent/tools/shared";
import { repairTellArguments } from "../src/agent/tools/world";
import { projectBoardAlias } from "../src/coordination/board-manager";
import { splitCommandChain } from "../src/engine/parse-input";
import type { Perception } from "../src/types";

const VERBS = new Set(["look", "say", "tell", "north", "note", "channel", "task", "mymacro"]);
const isCommand = (verb: string) => VERBS.has(verb);

describe("splitCommandChain", () => {
  it("splits plain commands on every ';' (with or without a verb lookup)", () => {
    expect(splitCommandChain("look ; north ; look")).toEqual(["look", "north", "look"]);
    expect(splitCommandChain("look; north", isCommand)).toEqual(["look", "north"]);
    expect(splitCommandChain(" ; look ;; ")).toEqual(["look"]);
  });

  it("keeps a ';' inside free text unless a command follows it", () => {
    expect(splitCommandChain("tell bob a; b and c", isCommand)).toEqual(["tell bob a; b and c"]);
    expect(splitCommandChain("say hi; look", isCommand)).toEqual(["say hi", "look"]);
    expect(splitCommandChain("channel send crew x; y; task list", isCommand)).toEqual([
      "channel send crew x; y",
      "task list",
    ]);
    expect(splitCommandChain("note one; two; mymacro arg", isCommand)).toEqual([
      "note one; two",
      "mymacro arg",
    ]);
    // Not free text: an unknown segment still separates (as before).
    expect(splitCommandChain("look; bogus", isCommand)).toEqual(["look", "bogus"]);
  });

  it("honours balanced quotes/backticks and the \\; escape", () => {
    expect(splitCommandChain('say "a; b"; look')).toEqual(['say "a; b"', "look"]);
    expect(splitCommandChain("say `x; y`; look")).toEqual(["say `x; y`", "look"]);
    expect(splitCommandChain("say a\\; b; look")).toEqual(["say a; b", "look"]);
    // An unbalanced quote is ordinary text.
    expect(splitCommandChain('say 5" pipe; look')).toEqual(['say 5" pipe', "look"]);
  });
});

describe("projectBoardAlias", () => {
  it("maps project:<name> to the project's group board", () => {
    expect(projectBoardAlias("project:Hab Lab")).toBe("group:project_hab_lab");
    expect(projectBoardAlias("general")).toBe("general");
  });
});

describe("repairTellArguments", () => {
  it("passes a well-formed call through untouched", () => {
    const args = { target: "bob", message: "hi" };
    expect(repairTellArguments(args)).toBe(args as never);
  });

  it("recovers nested, synonym and tool-name-leak shapes", () => {
    expect(repairTellArguments({ parameters: { target: "bob", message: "hi" } })).toEqual({
      target: "bob",
      message: "hi",
    });
    expect(repairTellArguments({ to: "bob", text: "hi", awaitReply: true })).toEqual({
      target: "bob",
      message: "hi",
      awaitReply: true,
    });
    expect(
      repairTellArguments({ target: "functions.marina_tell", commentary: "bob", message: "hi" }),
    ).toEqual({ target: "bob", message: "hi" });
    expect(repairTellArguments({ target: "bob: ready for review" })).toEqual({
      target: "bob",
      message: "ready for review",
    });
  });

  it("never invents a missing message", () => {
    const args = { target: "functions.marina_tell", commentary: "bob" };
    expect(repairTellArguments(args)).toBe(args as never);
  });
});

describe("agent-bound text", () => {
  it("drops correlated command output from the buffer but never a tell", () => {
    const own: Perception = {
      kind: "message",
      timestamp: 0,
      command_request_id: "r1",
      data: { text: "Board posts: …" },
    };
    expect(isSelfEchoPerception(own, "Board posts: …")).toBe(true);
    const tell: Perception = { ...own, tag: "tell", data: { text: "bob tells you: hi" } };
    expect(isSelfEchoPerception(tell, "bob tells you: hi")).toBe(false);
    const ambient: Perception = { kind: "message", timestamp: 0, data: { text: "x" } };
    expect(isSelfEchoPerception(ambient, "x")).toBe(false);
  });

  it("tool results carry no ANSI colour codes", () => {
    const text = formatPerceptions([
      { kind: "message", timestamp: 0, data: { text: "\x1b[1;36mRoom\x1b[0m here" } },
    ]);
    expect(text).toBe("Room here");
  });

  it("the action directive repeats an unchanged focus clamped, a new one in full", () => {
    const adapter = new LeanAgentAdapter({ name: "f" }, "ws://127.0.0.1:3300", null);
    const long = `fix the parser ${"x".repeat(400)}`;
    expect(adapter.focusDirective(long)).toContain(long);
    const repeat = adapter.focusDirective(long);
    expect(repeat).toContain("(unchanged)");
    expect(repeat.length).toBeLessThan(260);
    expect(adapter.focusDirective("ship it")).toBe(
      "Focus: ship it. Next verifiable step; skip completed work.",
    );
  });
});
