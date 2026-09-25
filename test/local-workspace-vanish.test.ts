// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * An entry can disappear between readdir and stat (a SQLite -shm file another
 * process just checkpointed away). A dangling symlink reproduces that
 * deterministically: readdir lists it, stat throws ENOENT.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspace } from "../src/coding/local-workspace";

let root: string;
let workspace: LocalWorkspace;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "marina-lws-vanish-"));
  writeFileSync(join(root, "README.md"), "hello marina\n");
  symlinkSync(join(root, "gone.db-shm"), join(root, "a.db-shm"));
  workspace = new LocalWorkspace(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("LocalWorkspace tolerates entries that vanish mid-walk", () => {
  it("list skips the vanished entry and keeps the rest", () => {
    expect(workspace.list(".").map((e) => e.path)).toEqual(["README.md"]);
  });

  it("the fallback text walk skips it too", async () => {
    const visited: string[] = [];
    await (
      workspace as unknown as {
        walkTextFiles(dir: string, visit: (p: string) => Promise<void>): Promise<void>;
      }
    ).walkTextFiles(root, async (p) => {
      visited.push(p);
    });
    expect(visited).toEqual([join(root, "README.md")]);
  });
});
