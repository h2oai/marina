// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { classifyToolRisk, mediateToolCall, POLICY_LANGUAGE_LABEL } from "../src/agent/tool-policy";

describe("agent tool reference monitor", () => {
  it("classifies narrow reads, communication, mutation, and consequential commands", () => {
    expect(classifyToolRisk("marina_command", { command: "look" })).toBe("read");
    expect(classifyToolRisk("marina_tell", { target: "Ada", message: "hi" })).toBe("communicate");
    expect(classifyToolRisk("marina_memory", { action: "set" })).toBe("mutate");
    expect(classifyToolRisk("marina_command", { command: "build destroy room" })).toBe(
      "consequential",
    );
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
