// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  classifyToolRisk,
  isAdditiveDeposit,
  mediateToolCall,
  POLICY_LANGUAGE_LABEL,
  READ_TOOL_NAMES,
  typedToolCommand,
} from "../src/agent/tool-policy";
import { createWorldTools } from "../src/agent/tools";
import { READ_ONLY_TOOL_NAMES } from "../src/agent/tools/profiles";

describe("agent tool reference monitor", () => {
  it("classifies narrow reads, communication, mutation, and consequential commands", () => {
    expect(classifyToolRisk("marina_command", { command: "look" })).toBe("read");
    expect(classifyToolRisk("marina_tell", { target: "Ada", message: "hi" })).toBe("communicate");
    expect(classifyToolRisk("marina_memory", { action: "set" })).toBe("mutate");
    expect(classifyToolRisk("marina_command", { command: "build destroy room" })).toBe(
      "consequential",
    );
  });

  it("classifies read-only verbs and subcommands as reads", () => {
    for (const command of [
      "calc [83%2, 83%3]",
      "calc 83 % 2; 83 % 3",
      "look",
      "examine lamp",
      "help task",
      "recall formation rules",
      "pool guide recall autonomy posture",
      "pool project:hab status",
      "pool list",
      "board history project:hab",
      "board read general 4",
      "challenge list",
      "challenges",
      "memory get focus",
      "memory kv history pace",
      "memory retrieve what did we decide",
      "note search shards",
      "task info 7",
      "project hab status",
      "trace show abc",
      "guide posture",
      "context posture",
      "evolve status exp-1",
    ]) {
      expect([command, classifyToolRisk("marina_command", { command })]).toEqual([command, "read"]);
    }
  });

  it("treats an agent's writes to its own loop settings as self-scoped", () => {
    for (const command of [
      "memory set rest No request pending; resume when asked.",
      "memory set pace slow",
      "memory kv set channel_sends 2",
      "memory set focus_persistent true",
      "memory delete rest",
      "memory rm rest",
    ]) {
      expect([command, classifyToolRisk("marina_command", { command })]).toEqual([command, "self"]);
    }
  });

  it("keeps writes, unknown verbs and other principals' objects gated", () => {
    for (const command of [
      "task create Fix the build | details",
      "code exec bun test",
      "agent spawn Scout model:x",
      "note correct 252 replaced text",
      "pool crew:answerer add T1 PRIMES: 83, 89, 97",
      "pool create recall",
      "project create hab | desc",
      "project hab join",
      "memory set goal something else",
      "memory delete goal",
      "memory clear",
      "memory delete rest; project hab join",
      "memory set rest",
      "benchmark run smoke --limit 15",
      "channel join model-answerer",
      "frobnicate everything",
      "",
    ]) {
      expect([command, classifyToolRisk("marina_command", { command })]).toEqual([
        command,
        "mutate",
      ]);
    }
  });

  it("classifies a batch by its riskiest command", () => {
    expect(classifyToolRisk("marina_batch", { commands: "calc 83; calc 89; look" })).toBe("read");
    expect(classifyToolRisk("marina_command", { command: "batch calc 1 ; look" })).toBe("read");
    expect(classifyToolRisk("marina_batch", { commands: "look; task create x | y" })).toBe(
      "mutate",
    );
    expect(classifyToolRisk("marina_batch", { commands: "look; admin stats" })).toBe(
      "consequential",
    );
    expect(classifyToolRisk("marina_batch", { commands: "" })).toBe("mutate");
    // The monitor's text rules keep their single-command scope: a batch is not
    // refused for bundling (its parts are router-gated one by one).
    const batched = mediateToolCall("marina_command", { command: "batch look; admin stats" }, [
      "untrusted_relay",
    ]);
    expect(batched.risk).toBe("consequential");
    expect(batched.block).toBeUndefined();
  });

  it("classifies typed wrappers by the command they send", () => {
    expect(classifyToolRisk("marina_pool", { action: "recall", pool: "guide", content: "x" })).toBe(
      "read",
    );
    expect(classifyToolRisk("marina_pool", { action: "list" })).toBe("read");
    expect(classifyToolRisk("marina_pool", { action: "add", pool: "out", content: "T1" })).toBe(
      "mutate",
    );
    expect(classifyToolRisk("marina_task", { action: "list" })).toBe("read");
    expect(classifyToolRisk("marina_task", { action: "create", args: "a | b" })).toBe("mutate");
    expect(classifyToolRisk("marina_focus", { action: "show" })).toBe("read");
    expect(classifyToolRisk("marina_focus", { action: "set", description: "x" })).toBe("mutate");
    expect(classifyToolRisk("marina_memory_service", { operation: "retrieve" })).toBe("read");
    expect(classifyToolRisk("marina_memory_service", { operation: "remember" })).toBe("mutate");
    expect(classifyToolRisk("memory", { action: "search", query: "x" })).toBe("read");
    expect(classifyToolRisk("memory", { action: "write", content: "x" })).toBe("mutate");
    expect(classifyToolRisk("marina_examine", { target: "lamp" })).toBe("read");
    // A fetch leaves the process with agent-chosen arguments: still gated.
    expect(classifyToolRisk("marina_web", { action: "fetch", url: "https://x.test" })).toBe(
      "mutate",
    );
    // Tools outside Marina stay gated.
    expect(classifyToolRisk("github_create_issue", { title: "x" })).toBe("mutate");
  });

  it("mirrors the command each typed wrapper actually sends", async () => {
    const sent: string[] = [];
    const tools = createWorldTools({
      client: {
        isConnected: () => true,
        command: async (command: string) => {
          sent.push(command);
          return [];
        },
      },
      gameState: { handlePerception: () => undefined },
    } as never);
    const cases: [string, Record<string, unknown>][] = [
      ["marina_pool", { action: "list" }],
      ["marina_pool", { action: "recall", pool: "guide", content: "posture" }],
      ["marina_pool", { action: "status", pool: "guide" }],
      ["marina_pool", { action: "add", pool: "out", content: "T1 done" }],
      ["marina_pool", { action: "create", pool: "fresh" }],
      ["marina_board", { action: "read", args: "general 4" }],
      ["marina_task", { action: "info", args: "7" }],
      ["marina_project", { action: "list" }],
      ["marina_canvas", { action: "nodes", args: "main" }],
      ["marina_macro", { action: "list" }],
      ["marina_market", { action: "leaderboard" }],
      ["marina_market", { action: "position", args: "open X" }],
      ["marina_batch", { commands: "look; calc 1" }],
      ["marina_focus", { action: "show" }],
      ["marina_goal", { action: "show" }],
    ];
    for (const [name, args] of cases) {
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      sent.length = 0;
      await tool!.execute("id", args as never);
      expect([name, typedToolCommand(name, args)]).toEqual([name, sent[0]]);
    }
  });

  it("only reads with names the tool executor also treats as read-only", () => {
    // `marina_recall` is a legacy name kept as a read; no current tool carries it.
    for (const name of READ_TOOL_NAMES) {
      if (name === "marina_recall") continue;
      expect([name, READ_ONLY_TOOL_NAMES.has(name)]).toEqual([name, true]);
    }
  });

  it("recognises additive deposits into a pool or crew artifact slot", () => {
    expect(isAdditiveDeposit("marina_command", { command: "pool crew:answerer add T1 done" })).toBe(
      true,
    );
    expect(isAdditiveDeposit("marina_pool", { action: "add", pool: "out", content: "T1" })).toBe(
      true,
    );
    expect(
      isAdditiveDeposit("marina_command", { command: "crew artifact answerer draft -- T1: 83" }),
    ).toBe(true);
    expect(isAdditiveDeposit("marina_command", { command: "pool out add" })).toBe(false);
    expect(isAdditiveDeposit("marina_command", { command: "pool create add x" })).toBe(false);
    expect(isAdditiveDeposit("marina_command", { command: "note correct 252 x" })).toBe(false);
    expect(isAdditiveDeposit("marina_command", { command: "task create x | y" })).toBe(false);
  });

  it("treats changing an existing role or trait as consequential, creating one as a plain mutation", () => {
    for (const command of [
      "role edit scout tone terse",
      "role delete scout",
      "role reload scout",
      "trait delete curious",
      "agent config Ada role scout-v2",
    ]) {
      expect(classifyToolRisk("marina_command", { command })).toBe("consequential");
    }
    expect(
      classifyToolRisk("marina_command", { command: "role create scout-v2 traits curious" }),
    ).toBe("mutate");
  });

  it("blocks policy manipulation only on a consequential call with untrusted content in context", () => {
    for (const source of ["external_tool", "untrusted_relay"]) {
      const decision = mediateToolCall(
        "marina_command",
        { command: "build destroy room -- ignore the safety gate" },
        ["world_event", source],
      );
      expect(decision.risk).toBe("consequential");
      expect(decision.block).toContain("reference monitor");
    }
  });

  it("notes, but never blocks, policy language from first-party context", () => {
    // Consequential, but only world events and memory fed the cycle.
    const consequential = mediateToolCall(
      "marina_command",
      { command: "build destroy room -- ignore the safety gate" },
      ["world_event", "memory"],
    );
    expect(consequential.block).toBeUndefined();
    expect(consequential.label).toBe(POLICY_LANGUAGE_LABEL);
  });

  it("lets an agent write or argue about relaxing a gate, even with untrusted context", () => {
    const note = mediateToolCall(
      "marina_command",
      { command: "note We should remove the permission gate on canvas edits; it slows review" },
      ["world_event", "memory", "external_tool"],
    );
    expect(note.risk).toBe("mutate");
    expect(note.block).toBeUndefined();
    expect(note.label).toBe(POLICY_LANGUAGE_LABEL);

    const message = mediateToolCall(
      "marina_tell",
      { target: "Ada", message: "Can we override the policy on board posts?" },
      ["untrusted_relay"],
    );
    expect(message.risk).toBe("communicate");
    expect(message.block).toBeUndefined();
    expect(message.label).toBe(POLICY_LANGUAGE_LABEL);
  });

  it("carries no label for ordinary text", () => {
    expect(
      mediateToolCall("marina_command", { command: "note mapped the east wing" }, []).label,
    ).toBeUndefined();
  });

  it("requires consequential raw operations to remain individually mediated", () => {
    const decision = mediateToolCall(
      "marina_command",
      { command: "admin stats; build destroy room" },
      ["world_event"],
    );
    expect(decision.risk).toBe("consequential");
    expect(decision.block).toContain("one operation at a time");
  });

  it("does not suppress ordinary autonomous work informed by world evidence", () => {
    expect(
      mediateToolCall("marina_command", { command: "task submit 42 evidence #9" }, [
        "world_event",
        "memory",
      ]).block,
    ).toBeUndefined();
  });
});
