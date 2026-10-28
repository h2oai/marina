// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedWorldCommand,
  executeTool,
  parseToolArguments,
  requestFailureStatus,
  terminalTurnStatus,
  workspacePath,
} from "../scripts/qualification/long-horizon-tools";

test("truncated, empty, or refused replies never count as submitted evaluation phases", () => {
  expect(terminalTurnStatus("length", null)).toBe("output-limit");
  expect(terminalTurnStatus("length", "partial work")).toBe("output-limit");
  expect(terminalTurnStatus("stop", null)).toBe("empty-response");
  expect(terminalTurnStatus("stop", " ")).toBe("empty-response");
  expect(terminalTurnStatus("content_filter", "refused")).toBe("unexpected-finish");
  expect(terminalTurnStatus("stop", "Artifacts written")).toBe("submitted");
});

test("evaluation tools cannot read another run or private scoring material", () => {
  const root = mkdtempSync(join(tmpdir(), "marina-eval-boundary-"));
  try {
    symlinkSync(tmpdir(), join(root, "outside"));
    expect(() => workspacePath(root, "../secret")).toThrow("Workspace paths only");
    expect(() => workspacePath(root, "/etc/passwd")).toThrow("Workspace paths only");
    expect(() => workspacePath(root, "outside/secret")).toThrow("Symlinks refused");
    expect(workspacePath(root, "src/fix.py")).toBe(join(root, "src/fix.py"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluation writes preserve supplied evidence and checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "marina-eval-writes-"));
  try {
    writeFileSync(join(root, "check_submission.py"), "original");
    const options = {
      workspace: root,
      protectedFiles: new Set(["check_submission.py"]),
      image: "unused",
      checks: [],
    };
    await expect(
      executeTool(options, "write_file", { path: "check_submission.py", content: "weakened" }),
    ).rejects.toThrow("immutable");
    await expect(
      executeTool(options, "write_file", { path: "inputs/fake.json", content: "invented" }),
    ).rejects.toThrow("immutable");
    await executeTool(options, "write_file", { path: "JOURNAL.md", content: "next action" });
    expect(readFileSync(join(root, "check_submission.py"), "utf8")).toBe("original");
    expect(readFileSync(join(root, "JOURNAL.md"), "utf8")).toBe("next action");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Marina comparison tools cannot launch a process or another model", () => {
  for (const command of [
    "code exec cat /etc/passwd",
    "shell cat /etc/passwd",
    "agent spawn Other",
    "ask paid work",
    "memory api {}",
    "note fact; shell ls",
    "task list\nadmin shutdown",
  ])
    expect(allowedWorldCommand(command)).toBe(false);
  for (const command of [
    "note Current policy is revision4",
    "recall approved policy",
    "memory remember Cited fact",
    "task create Verify artifact | Check revision",
    "project create launch | Plan work",
    "brief full",
  ])
    expect(allowedWorldCommand(command)).toBe(true);
});

test("an expired phase cannot mutate artifacts or start a command", async () => {
  const root = mkdtempSync(join(tmpdir(), "marina-eval-deadline-"));
  try {
    const options = {
      workspace: root,
      protectedFiles: new Set<string>(),
      image: "unused",
      checks: [],
      deadline: Date.now() - 1,
    };
    await expect(
      executeTool(options, "write_file", { path: "answer.json", content: "{}" }),
    ).rejects.toThrow("deadline");
    await expect(executeTool(options, "marina_command", { command: "note late" })).rejects.toThrow(
      "deadline",
    );
    expect(() => readFileSync(join(root, "answer.json"))).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("append and edit preserve large artifacts, enforce byte offsets, and reject stale replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "marina-eval-incremental-"));
  const options = {
    workspace: root,
    protectedFiles: new Set(["fixed.txt"]),
    image: "unused",
    checks: [],
  };
  try {
    const initial = `α🙂${"x".repeat(10_000)}`;
    await executeTool(options, "write_file", { path: "large.txt", content: initial });
    const append = {
      path: "large.txt",
      content: "\nlast",
      expected_bytes: Buffer.byteLength(initial),
    };
    await executeTool(options, "append_file", append);
    await expect(executeTool(options, "append_file", append)).rejects.toThrow();
    await executeTool(options, "edit_file", {
      path: "large.txt",
      old_text: "\nlast",
      new_text: "\nfixed",
    });
    expect(readFileSync(join(root, "large.txt"), "utf8")).toBe(`${initial}\nfixed`);
    await expect(
      executeTool(options, "edit_file", { path: "large.txt", old_text: "x", new_text: "y" }),
    ).rejects.toThrow();
    for (const name of ["append_file", "edit_file"]) {
      await expect(
        executeTool(options, name, {
          path: "fixed.txt",
          content: "bad",
          expected_bytes: 0,
          old_text: "a",
          new_text: "b",
        }),
      ).rejects.toThrow("immutable");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a length-ended tool turn is rejected even when its arguments are valid JSON", () => {
  expect(() =>
    parseToolArguments('{"path":"x","content":"valid but unfinished"}', "length"),
  ).toThrow();
  expect(parseToolArguments('{"path":"x","content":"complete"}', "tool_calls")).toEqual({
    path: "x",
    content: "complete",
  });
  expect(() => parseToolArguments("[]", "tool_calls")).toThrow();
});

test("phase deadlines and upstream request timeouts remain distinct", () => {
  const timeout = new DOMException("timed out", "TimeoutError");
  expect(requestFailureStatus(timeout, 100, 100)).toBe("deadline");
  expect(requestFailureStatus(timeout, 100, 99)).toBe("request-timeout");
  expect(requestFailureStatus(new Error("failed"), 100, 99)).toBe("error");
});
