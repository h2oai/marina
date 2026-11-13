// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One reasoning-depth setting for every coding runtime: the harness carries
 * `thinking`, and each native adapter maps it to its own control (Claude's
 * `effort`/`thinking`, Codex's `model_reasoning_effort`, pi's `--thinking`).
 * Also: a native one-shot's result lists the files that changed in the folder.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workingTreeFileStats } from "../scripts/code";
import { validateHarness } from "../scripts/code-harness";
import { claudeEffort, codexConfig } from "../src/routing/agent-adapters";
import { git } from "./git-helpers";

const scratch = mkdtempSync(join(tmpdir(), "marina-effort-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("harness thinking", () => {
  it("accepts a thinking level for any runtime and normalizes none to off", () => {
    expect(validateHarness({ version: 1, agent: "claude", thinking: "high" }).thinking).toBe(
      "high",
    );
    expect(validateHarness({ version: 1, agent: "codex", thinking: "none" }).thinking).toBe("off");
    expect(validateHarness({ version: 1, agent: "marina" }).thinking).toBeUndefined();
  });

  it("refuses an unknown level", () => {
    expect(() => validateHarness({ version: 1, agent: "pi", thinking: "max" })).toThrow(
      "Thinking must be",
    );
  });
});

describe("native effort mapping", () => {
  it("maps levels to Claude's effort, with off disabling thinking", () => {
    expect(claudeEffort("high")).toEqual({ effort: "high" });
    expect(claudeEffort("xhigh")).toEqual({ effort: "xhigh" });
    expect(claudeEffort("minimal")).toEqual({ effort: "low" });
    expect(claudeEffort("off")).toEqual({ thinking: { type: "disabled" } });
  });

  it("sets Codex's reasoning effort beside the relay root, and nothing when unset", () => {
    expect(codexConfig({ effort: "medium" })).toEqual({
      config: { model_reasoning_effort: "medium" },
    });
    expect(codexConfig({ effort: "off" })).toEqual({ config: { model_reasoning_effort: "none" } });
    expect(
      codexConfig({
        effort: "high",
        env: { MARINA_RELAY_SOCKET: "/run/user/1/marina-relay-x/relay.sock" },
      }),
    ).toEqual({
      config: {
        model_reasoning_effort: "high",
        "sandbox_workspace_write.writable_roots": ["/run/user/1/marina-relay-x"],
      },
    });
    expect(codexConfig({})).toEqual({});
  });
});

describe("workingTreeFileStats", () => {
  it("counts edited tracked files and new untracked files, skipping ignored ones", () => {
    const repo = join(scratch, "repo");
    git(scratch, "init", "-q", repo);
    writeFileSync(join(repo, "a.ts"), "one\ntwo\n");
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
    writeFileSync(join(repo, "a.ts"), "one\nthree\nfour\n");
    writeFileSync(join(repo, "new.ts"), "x\ny\n");
    writeFileSync(join(repo, "ignored.txt"), "z\n");
    const stats = workingTreeFileStats(repo).sort((a, b) => a.path.localeCompare(b.path));
    expect(stats).toEqual([
      { path: "a.ts", added: 2, removed: 1 },
      { path: "new.ts", added: 2, removed: 0 },
    ]);
  });

  it("returns only untracked files outside a commit", () => {
    const bare = join(scratch, "fresh");
    git(scratch, "init", "-q", bare);
    writeFileSync(join(bare, "only.md"), "hello");
    expect(workingTreeFileStats(bare)).toEqual([{ path: "only.md", added: 1, removed: 0 }]);
  });
});
