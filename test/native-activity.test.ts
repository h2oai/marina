// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A native agent's activity reads like Marina's own coder: one plain step per
 * action from each runtime's own event shape, nothing for protocol bookkeeping,
 * and streamed text released only as whole lines.
 */

import { describe, expect, it } from "bun:test";
import { nativeActivityStep, readyLines } from "../scripts/native-activity";

const cwd = "/work/project";

describe("nativeActivityStep", () => {
  it("Codex items: commands, file changes, failures; nothing for messages or reasoning", () => {
    expect(
      nativeActivityStep(
        "native.item/started",
        { item: { type: "commandExecution", command: "bun test test/a.test.ts" } },
        cwd,
      ),
    ).toBe("Run bun test test/a.test.ts");
    expect(
      nativeActivityStep(
        "native.item/started",
        {
          item: {
            type: "fileChange",
            changes: [{ path: `${cwd}/src/a.ts` }, { path: "test/a.test.ts" }],
          },
        },
        cwd,
      ),
    ).toBe("Edit src/a.ts, test/a.test.ts");
    expect(
      nativeActivityStep(
        "native.item/completed",
        { item: { type: "commandExecution", command: "bun test", exitCode: 1 } },
        cwd,
      ),
    ).toBe("bun test exited 1");
    expect(
      nativeActivityStep(
        "native.item/completed",
        { item: { type: "commandExecution", command: "bun test", exitCode: 0 } },
        cwd,
      ),
    ).toBeUndefined();
    for (const type of ["agentMessage", "reasoning", "userMessage"])
      expect(nativeActivityStep("native.item/started", { item: { type } }, cwd)).toBeUndefined();
  });

  it("Claude Code tool_use blocks, with workspace-relative paths", () => {
    const message = {
      message: {
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", name: "Read", input: { file_path: `${cwd}/src/x.ts` } },
          { type: "tool_use", name: "Bash", input: { command: "bun run typecheck\n" } },
          { type: "tool_use", name: "Edit", input: { file_path: "/elsewhere/y.ts" } },
          { type: "tool_use", name: "Grep", input: { pattern: "CODE_RUN_BUN_SCRIPTS" } },
        ],
      },
    };
    expect(nativeActivityStep("native.assistant", message, cwd)).toBe(
      [
        "Read src/x.ts",
        "Run bun run typecheck",
        "Edit /elsewhere/y.ts",
        'Search for "CODE_RUN_BUN_SCRIPTS"',
      ].join("\n"),
    );
    expect(
      nativeActivityStep("native.assistant", { message: { content: [{ type: "text" }] } }, cwd),
    ).toBeUndefined();
  });

  it("pi tool starts, and silence for every other event", () => {
    expect(
      nativeActivityStep(
        "native.tool_execution_start",
        { toolName: "write", args: { path: "notes.md" } },
        cwd,
      ),
    ).toBe("Write notes.md");
    for (const kind of [
      "native.turn/started",
      "native.thread/started",
      "native.result",
      "native.agent_settled",
      "output",
    ])
      expect(nativeActivityStep(kind, {}, cwd)).toBeUndefined();
  });

  it("shows the command a shell wrapper runs", () => {
    const run = (command: string) =>
      nativeActivityStep(
        "native.item/started",
        { item: { type: "commandExecution", command } },
        cwd,
      );
    expect(run("/usr/bin/bash -lc 'bun test'")).toBe("Run bun test");
    expect(run(`/bin/sh -c "rg --files -g '*.ts'"`)).toBe("Run rg --files -g '*.ts'");
    expect(run("bash -lc pwd")).toBe("Run bash -lc pwd");
  });

  it("clips long commands to one line", () => {
    const long = `bun test ${"x/".repeat(60)}`;
    const step = nativeActivityStep(
      "native.item/started",
      { item: { type: "commandExecution", command: `${long}\n  --bail` } },
      cwd,
    );
    expect(step!.length).toBeLessThanOrEqual(76);
    expect(step).not.toContain("\n");
  });
});

describe("readyLines", () => {
  it("keeps an unfinished line buffered until it ends or the turn does", () => {
    expect(readyLines("Added `format` and `test:fast` to the", false)).toEqual({
      ready: "",
      rest: "Added `format` and `test:fast` to the",
    });
    expect(readyLines("one\ntwo\nthr", false)).toEqual({ ready: "one\ntwo\n", rest: "thr" });
    expect(readyLines("thr", true)).toEqual({ ready: "thr", rest: "" });
  });
});
