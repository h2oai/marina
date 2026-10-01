// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `;` chains only inside `batch`: a raw `marina_command` / MCP `command`
// with an unsplit chain runs exactly as typed and earns ONE terse line
// naming the segments that did not run (src/sdk/command-chain.ts).

import { afterAll, describe, expect, it } from "bun:test";
import { createCommandTool } from "../src/agent/tools";
import { describeCommand } from "../src/engine/command-manifest";
import { detectUnsplitChain, unsplitChainNote } from "../src/sdk/command-chain";
import type { Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";

const fixture = createTestEngine();
const catalog = fixture.engine.commands.allBuiltins().map(describeCommand);
afterAll(() => fixture.dispose());

describe("detectUnsplitChain", () => {
  it("names the segment the router never ran", () => {
    expect(detectUnsplitChain("memory delete rest; project hab join", catalog)).toEqual([
      "project hab join",
    ]);
    expect(unsplitChainNote("memory delete rest; project hab join", catalog)).toBe(
      "note: ';' is not a separator here — `project hab join` did not run; use `batch <a>; <b>` to run several",
    );
  });

  it("lists every trailing command", () => {
    expect(
      detectUnsplitChain("memory delete rest; project hab join; look; task list", catalog),
    ).toEqual(["project hab join", "look", "task list"]);
    expect(unsplitChainNote("memory delete rest; project hab join; task list", catalog)).toContain(
      "`project hab join`, `task list` did not run",
    );
  });

  it("leaves free text with a ';' alone", () => {
    for (const input of [
      "say hello; world",
      "memory set rest waiting; resume when asked",
      "memory set goal ship it; recall goals",
      "say ok; help me",
      "note learned x; look around later",
      "tell bob meet me; then go north",
      "channel send ops deploying; done",
      "say I will look; see you",
    ])
      expect(detectUnsplitChain(input, catalog)).toEqual([]);
  });

  it("still flags an unmistakable command after free text", () => {
    expect(detectUnsplitChain("say hi; look", catalog)).toEqual(["look"]);
    expect(detectUnsplitChain("note x; task claim 3", catalog)).toEqual(["task claim 3"]);
  });

  it("never flags batch, a no-';' input, or an unknown head (macros split)", () => {
    expect(detectUnsplitChain("batch look; task list", catalog)).toEqual([]);
    expect(detectUnsplitChain("/batch look; task list", catalog)).toEqual([]);
    expect(detectUnsplitChain("project hab join", catalog)).toEqual([]);
    expect(detectUnsplitChain("mymacro; task list", catalog)).toEqual([]);
    expect(unsplitChainNote("say hello; world", catalog)).toBe("");
  });
});

describe("marina_command", () => {
  function tool(perceptions: Perception[]) {
    const sent: string[] = [];
    const ctx = {
      client: {
        isConnected: () => true,
        command: async (command: string) => {
          sent.push(command);
          return perceptions;
        },
        capabilities: async () => ({
          schema: "marina.capabilities.v1",
          revision: 1,
          commands: catalog,
        }),
      },
      gameState: { handlePerception() {} },
    };
    return { sent, tool: createCommandTool(ctx as never) };
  }
  const ok = [{ kind: "message", data: { text: "Deleted rest;." } }] as unknown as Perception[];

  it("states that ';' chains only inside batch", () => {
    expect(tool([]).tool.description).toContain("`;` chains only inside `batch`");
  });

  it("runs the input unchanged and appends one note", async () => {
    const { sent, tool: t } = tool(ok);
    const result = await t.execute("1", { command: "memory delete rest; project hab join" });
    expect(sent).toEqual(["memory delete rest; project hab join"]);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe(
      "Deleted rest;.\nnote: ';' is not a separator here — `project hab join` did not run; use `batch <a>; <b>` to run several",
    );
  });

  it("adds nothing to free text or batch", async () => {
    for (const command of ["say hello; world", "batch look; task list"]) {
      const result = await tool(ok).tool.execute("1", { command });
      expect((result.content[0] as { text: string }).text).toBe("Deleted rest;.");
    }
  });

  it("appends the note to a failed head command too", async () => {
    const failed = [{ kind: "error", data: { text: "No key." } }] as unknown as Perception[];
    await expect(
      tool(failed).tool.execute("1", { command: "memory delete rest; project hab join" }),
    ).rejects.toThrow("`project hab join` did not run");
  });
});
