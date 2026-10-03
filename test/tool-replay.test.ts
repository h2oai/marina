// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { applyToolReplayPolicy, replayPolicyFor } from "../src/agent/tools/profiles";

function stub(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "stub",
    parameters: {},
    execute: async () => ({ content: [] }),
  } as unknown as AgentTool;
}

describe("tool replay contract", () => {
  it("marks read-only tools safe", () => {
    expect(replayPolicyFor("marina_look")).toBe("safe");
    expect(replayPolicyFor("marina_web")).toBe("safe");
    expect(replayPolicyFor("marina_code_diff")).toBe("safe");
  });

  it("leaves mutating tools unstamped (never re-run)", () => {
    expect(replayPolicyFor("marina_command")).toBeUndefined();
    expect(replayPolicyFor("marina_say")).toBeUndefined();
    expect(replayPolicyFor("marina_code_apply_patch")).toBeUndefined();
  });

  it("stamps safe replays onto a tool list without touching declared policies", () => {
    const read = stub("marina_look");
    const mutate = stub("marina_command");
    const explicit = { ...stub("marina_look"), replay: "never" as const };

    const result = applyToolReplayPolicy([read, mutate, explicit, stub("marina_web")]);

    expect(result.map((t) => t.replay)).toEqual(["safe", undefined, "never", "safe"]);
  });
});
