// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspace } from "../src/coding/local-workspace";

let root: string;
let workspace: LocalWorkspace;

function git(...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "marina-lws-edit-"));
  workspace = new LocalWorkspace(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("LocalWorkspace.editFile", () => {
  it("replaces a unique occurrence", async () => {
    writeFileSync(join(root, "app.ts"), "const a = 1;\nconst b = 2;\n");
    const result = await workspace.editFile("app.ts", "const b = 2;", "const b = 3;");
    expect(result.ok).toBe(true);
    expect(result.occurrences).toBe(1);
    expect(readFileSync(join(root, "app.ts"), "utf-8")).toBe("const a = 1;\nconst b = 3;\n");
  });

  it("fails with occurrence count when oldText is not unique", async () => {
    writeFileSync(join(root, "app.ts"), "same\nother\nsame\n");
    const result = await workspace.editFile("app.ts", "same", "changed");
    expect(result.ok).toBe(false);
    expect(result.occurrences).toBe(2);
    expect(result.output).toContain("2 locations");
    expect(result.output).toContain("replaceAll");
    // File untouched on failure.
    expect(readFileSync(join(root, "app.ts"), "utf-8")).toBe("same\nother\nsame\n");
  });

  it("replaces every occurrence with replaceAll", async () => {
    writeFileSync(join(root, "app.ts"), "same\nother\nsame\n");
    const result = await workspace.editFile("app.ts", "same", "changed", { replaceAll: true });
    expect(result.ok).toBe(true);
    expect(result.occurrences).toBe(2);
    expect(readFileSync(join(root, "app.ts"), "utf-8")).toBe("changed\nother\nchanged\n");
  });

  it("fails helpfully when oldText is not found", async () => {
    writeFileSync(join(root, "app.ts"), "const a = 1;\n");
    const result = await workspace.editFile("app.ts", "const missing = 9;", "x");
    expect(result.ok).toBe(false);
    expect(result.occurrences).toBe(0);
    expect(result.output).toContain("not found");
    expect(result.output).toContain("app.ts");
  });

  it("fails when the file does not exist", async () => {
    const result = await workspace.editFile("nope.ts", "a", "b");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("File not found");
  });

  it("refuses binary files", async () => {
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x41, 0x00, 0x42]));
    const result = await workspace.editFile("blob.bin", "A", "B");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Not a text file");
  });

  it("does not interpret $-patterns in newText", async () => {
    writeFileSync(join(root, "app.ts"), "cost = 1;\n");
    const result = await workspace.editFile("app.ts", "cost = 1;", "cost = $& + $1;");
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "app.ts"), "utf-8")).toBe("cost = $& + $1;\n");
  });

  it("rejects paths that escape the workspace root", async () => {
    expect(workspace.editFile("../outside.ts", "a", "b")).rejects.toThrow(/relative|escapes/);
  });

  it("refuses .git metadata", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "[core]\n");
    expect(workspace.editFile(".git/config", "[core]", "[hacked]")).rejects.toThrow(
      /\.git metadata/,
    );
  });
});

describe("LocalWorkspace.writeFile", () => {
  it("creates a new file, including parent directories", async () => {
    const result = await workspace.writeFile("src/deep/new.ts", "export const x = 1;\n");
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.output).toContain("Created");
    expect(readFileSync(join(root, "src/deep/new.ts"), "utf-8")).toBe("export const x = 1;\n");
  });

  it("reports overwrite for an existing file", async () => {
    writeFileSync(join(root, "old.ts"), "before\n");
    const result = await workspace.writeFile("old.ts", "after\n");
    expect(result.ok).toBe(true);
    expect(result.created).toBe(false);
    expect(result.output).toContain("Overwrote");
    expect(readFileSync(join(root, "old.ts"), "utf-8")).toBe("after\n");
  });

  it("fails on directories and binary overwrites", async () => {
    mkdirSync(join(root, "dir"));
    const dirResult = await workspace.writeFile("dir", "x");
    expect(dirResult.ok).toBe(false);
    expect(dirResult.output).toContain("directory");

    writeFileSync(join(root, "blob.bin"), Buffer.from([0x41, 0x00, 0x42]));
    const binResult = await workspace.writeFile("blob.bin", "text");
    expect(binResult.ok).toBe(false);
    expect(binResult.output).toContain("binary");
  });

  it("rejects absolute and escaping paths", async () => {
    expect(workspace.writeFile("/etc/passwd", "x")).rejects.toThrow(/relative/);
    expect(workspace.writeFile("../escape.txt", "x")).rejects.toThrow(/relative|escapes/);
    expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
  });

  it("refuses .git metadata", async () => {
    expect(workspace.writeFile(".git/hooks/pre-commit", "#!/bin/sh\n")).rejects.toThrow(
      /\.git metadata/,
    );
  });
});

describe("LocalWorkspace patch resilience", () => {
  const fileBody = "line one\nline two\nline three\n";
  // Hunk header claims 4 lines but the body has 3 — plain `git apply`
  // rejects this as a corrupt patch; --recount recomputes and applies.
  const wrongCountPatch = [
    "--- a/hello.txt",
    "+++ b/hello.txt",
    "@@ -1,4 +1,4 @@",
    " line one",
    "-line two",
    "+line 2",
    " line three",
    "",
  ].join("\n");

  beforeEach(() => {
    git("init");
    writeFileSync(join(root, "hello.txt"), fileBody);
    git("add", "hello.txt");
    git("commit", "-m", "seed");
  });

  it("applyPatch retries with --recount -C1 and reports the mode", async () => {
    const result = await workspace.applyPatch(wrongCountPatch);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("--recount -C1");
    expect(readFileSync(join(root, "hello.txt"), "utf-8")).toBe("line one\nline 2\nline three\n");
  });

  it("checkPatch validates a wrong-count patch via --recount without mutating", async () => {
    const result = await workspace.checkPatch(wrongCountPatch);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("--recount -C1");
    expect(readFileSync(join(root, "hello.txt"), "utf-8")).toBe(fileBody);
  });

  it("clean patches apply without a retry-mode note", async () => {
    const cleanPatch = [
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1,3 +1,3 @@",
      " line one",
      "-line two",
      "+line 2",
      " line three",
      "",
    ].join("\n");
    const result = await workspace.applyPatch(cleanPatch);
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain("--recount");
    expect(result.output).not.toContain("--3way");
  });

  it("reports honestly when every apply mode fails", async () => {
    const hopelessPatch = [
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1,3 +1,3 @@",
      " completely different",
      "-context that never existed",
      "+replacement",
      " also wrong",
      "",
    ].join("\n");
    const result = await workspace.applyPatch(hopelessPatch);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("also failed");
    expect(readFileSync(join(root, "hello.txt"), "utf-8")).toBe(fileBody);
  });
});
