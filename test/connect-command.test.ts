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

  test("onResult receives the request's own perceptions, on success and on refusal", async () => {
    const ok = [{ kind: "message", data: { text: "done" } }] as unknown as Perception[];
    let seen: Perception[] = [];
    expect(
      await runCliCommand({ command: async () => ok }, "look", undefined, {
        onResult: (p) => {
          seen = p;
        },
      }),
    ).toBe(true);
    expect(seen).toBe(ok);
    await runCliCommand(
      {
        command: async () => {
          throw new CommandError("Unknown command: frobnicate", [refusal]);
        },
      },
      "frobnicate",
      () => {},
      {
        onResult: (p) => {
          seen = p;
        },
      },
    );
    expect(seen).toEqual([refusal]);
  });

  test("a stopped wait passes the signal through and is not reported as a failure", async () => {
    const stop = new AbortController();
    const lines: string[] = [];
    let received: AbortSignal | undefined;
    const agent = {
      command: async (_input: string, options?: { signal?: AbortSignal }) => {
        received = options?.signal;
        stop.abort();
        throw new CommandError(
          "Stopped waiting for command completion; execution outcome is unknown.",
        );
      },
    };
    expect(
      await runCliCommand(agent, "ask why", (l) => lines.push(l), { signal: stop.signal }),
    ).toBe(false);
    expect(received).toBe(stop.signal);
    // The REPL says "stopped waiting" in its own words.
    expect(lines).toEqual([]);
  });

  test("every command call site in connect.ts and the REPL goes through the runner", () => {
    const read = (file: string) => readFileSync(join(import.meta.dir, "../scripts", file), "utf8");
    const source = read("connect.ts");
    const repl = read("connect-repl.ts");
    for (const text of [source, repl]) expect(text).not.toMatch(/await agent\.command\(/);
    // one-shot, pipe, redirected-stdout prompt; the interactive screen.
    expect(source.match(/runCliCommand\(agent,/g)?.length).toBe(3);
    expect(repl.match(/runCliCommand\(agent,/g)?.length).toBe(1);
  });
});
