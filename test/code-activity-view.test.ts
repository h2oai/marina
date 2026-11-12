// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// What a person sees while the coder works and when it is done: one plain line per
// action with the change itself under an edit, routine bookkeeping left out, and one
// result block (how it ended, files, checks, time, cost, exact next commands).

import { describe, expect, it } from "bun:test";
import {
  codePerceptionFormat,
  formatCodePerception,
  renderRunResult,
} from "../scripts/code-presentation";
import { styleActivity } from "../scripts/code-style";
import { createTheme } from "../scripts/term-theme";
import {
  coderDisplayName,
  describeCodingCall,
  replacementDiff,
} from "../src/engine/commands/code/activity";
import type { Perception } from "../src/sdk/client";

const DIFF = [
  "diff --git a/paginate.js b/paginate.js",
  "--- a/paginate.js",
  "+++ b/paginate.js",
  "@@ -1,3 +1,3 @@",
  "-  const start = page * perPage;",
  "+  const start = (page - 1) * perPage;",
  "",
].join("\n");

describe("coding activity in plain words", () => {
  it("names each action and carries an edit's change", () => {
    expect(describeCodingCall("marina_code", { action: "read", path: "a.js" }).label).toBe(
      "Read a.js",
    );
    expect(describeCodingCall("marina_code_run", { command: "bun test" }).label).toBe(
      "Run bun test",
    );
    const edit = describeCodingCall("marina_code_edit", {
      path: "a.js",
      oldText: "const a = 1;\nconst b = 2;\n",
      newText: "const a = 1;\nconst b = 3;\n",
    });
    expect(edit).toMatchObject({ kind: "edit", label: "Edit a.js" });
    expect(edit.diff).toEqual([" const a = 1;", "-const b = 2;", "+const b = 3;"]);
    const write = describeCodingCall("marina_code", {
      action: "write",
      path: "n.txt",
      content: "x\ny\n",
    });
    expect(write).toMatchObject({ label: "Write n.txt (2 lines)", diff: ["+x", "+y"] });
  });

  it("caps a long change and says how much it left out", () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const write = describeCodingCall("marina_code_write", { path: "big.txt", content });
    expect(write.diff).toHaveLength(12);
    expect(write.more).toBe(18);
  });

  it("marks bookkeeping quiet and keeps unknown tools' own names", () => {
    expect(describeCodingCall("marina_code_session_status", {}).quiet).toBe(true);
    expect(describeCodingCall("marina_code", { action: "show", artifactId: "x" }).quiet).toBe(true);
    expect(describeCodingCall("marina_memory", {})).toMatchObject({ quiet: true, label: "memory" });
    expect(describeCodingCall("marina_code_verify", {}).quiet).toBeUndefined();
  });

  it("an addition or removal at the edges is only the change", () => {
    expect(replacementDiff("", "new\n")).toEqual(["+new"]);
    expect(replacementDiff("gone\n", "")).toEqual(["-gone"]);
  });

  it("a session coder is Coder to a person; other names are kept", () => {
    expect(coderDisplayName("code_coder_code_f30d")).toBe("Coder");
    expect(coderDisplayName("Builder")).toBe("Builder");
  });
});

describe("the terminal's person view", () => {
  const stream = (metadata: Record<string, unknown>, text: string): Perception => ({
    kind: "message",
    timestamp: 0,
    data: { text, code: { event: "agent_output", type: "stream", metadata } },
  });

  it("an action is an activity entry; bookkeeping is not shown", () => {
    const edit = stream(
      { kind: "tool", activity: { label: "Edit a.js", diff: ["-x", "+y"] } },
      "  ▸ Edit a.js",
    );
    expect(codePerceptionFormat(edit)).toBe("activity");
    expect(formatCodePerception(edit)).toBe("Edit a.js\n-x\n+y");
    const quiet = stream(
      { kind: "tool", activity: { label: "status", quiet: true } },
      "  ▸ status",
    );
    expect(formatCodePerception(quiet)).toBe("");
  });

  it("the coder's words are labelled by who said them", () => {
    expect(formatCodePerception(stream({ kind: "prose" }, "Coder: Fixed it."))).toBe(
      "[Coder] Fixed it.",
    );
  });

  it("styles an action with its change under the gutter, plainly without colour", () => {
    const plain = styleActivity(
      "Edit a.js\n-x\n+y",
      createTheme({
        color: 0,
        unicode: false,
        links: false,
        background: "dark",
        columns: 80,
      } as never),
    );
    expect(plain).toBe("* Edit a.js\n  L -x\n    +y");
  });
});

describe("the result block", () => {
  it("says it is done, what changed, that checks passed, what it took, and what to type", () => {
    const text = renderRunResult({
      outcome: "submitted",
      verification: "passed",
      runId: "task_run_1",
      elapsedMs: 83_000,
      costUsd: 0.067,
      diff: { content: DIFF, mode: "full" },
    });
    const [head] = text.split("\n");
    expect(head).toBe("──── Done · 1 file changed (+1 −1) · checks passed · 1m 23s · $0.067 ────");
    expect(text).toContain("paginate.js");
    // The edits showed inline already: the block lists files, it does not repeat hunks.
    expect(text).not.toContain("const start");
    expect(text).toContain("/review approve task_run_1");
    expect(text).toContain("/review reject task_run_1");
    expect(text).toContain("undo it: git restore paginate.js");
    expect(text).toContain("Type a follow-up to keep going.");
  });

  it("a blocked run says why and offers no review", () => {
    const text = renderRunResult({
      outcome: "interrupted",
      reason: "blocked",
      detail: "Blocked: the tests need a database",
      runId: "r",
    });
    expect(text.split("\n")[0]).toStartWith("──── Blocked · no file changes");
    expect(text).toContain("Why: the tests need a database");
    expect(text).not.toContain("/review approve");
  });

  it("never claims checks it does not have", () => {
    expect(renderRunResult({ outcome: "submitted" })).toContain("no checks recorded");
    expect(renderRunResult({ outcome: "submitted", verification: "failed" })).toContain(
      "checks failed",
    );
  });
});
