// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCliCommand } from "../scripts/connect-command";
import { CommandError, type Perception } from "../src/sdk/client";

const refusal = {
  type: "error",
  data: { text: 'Unknown command: frobnicate. Type "help" for commands.' },
} as unknown as Perception;

describe("connect CLI command runner", () => {
  test("a refused command resolves false without rethrowing or reprinting", async () => {
    const lines: string[] = [];
    const agent = {
      command: async () => {
        throw new CommandError("Unknown command: frobnicate", [refusal]);
      },
    };
    expect(await runCliCommand(agent, "frobnicate", (l) => lines.push(l))).toBe(false);
    // The perception printer already showed the refusal: no second copy, no stack.
    expect(lines).toEqual([]);
  });

  test("a failure with no output is reported once", async () => {
    const lines: string[] = [];
    const agent = {
      command: async () => {
        throw new CommandError("Command completion timed out; execution outcome is unknown.");
      },
    };
    expect(await runCliCommand(agent, "look", (l) => lines.push(l))).toBe(false);
    expect(lines).toEqual(["Command completion timed out; execution outcome is unknown."]);
  });

  test("success resolves true; non-command errors still throw", async () => {
    expect(await runCliCommand({ command: async () => [] }, "look")).toBe(true);
    const broken = {
      command: async () => {
        throw new TypeError("bug");
      },
    };
    await expect(runCliCommand(broken, "look")).rejects.toThrow("bug");
  });

  test("every command call site in connect.ts goes through the runner", () => {
    const source = readFileSync(join(import.meta.dir, "../scripts/connect.ts"), "utf8");
    expect(source).not.toMatch(/await agent\.command\(/);
    expect(source.match(/runCliCommand\(agent,/g)?.length).toBe(3);
  });
});
