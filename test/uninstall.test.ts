// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `marina uninstall` and setup.sh's move into the one home (scripts/home.ts), on a made-up
// machine in a temporary folder: everything Marina made goes, nothing else does.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyUninstall,
  migrateLegacyInstall,
  namesFolder,
  pathEditsFor,
  planUninstall,
  renderPlan,
} from "../scripts/home";

let user: string;
let env: Record<string, string>;
let home: string;

beforeEach(() => {
  user = mkdtempSync(join(tmpdir(), "marina-uninstall-"));
  home = join(user, ".marina");
  env = { HOME: user, MARINA_HOME: home, PATH: process.env.PATH ?? "" };
});
afterEach(() => rmSync(user, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf8",
  });

/** A setup.sh install of the old layout: code plus a world in ~/marina, no git. */
function oldInstall(dir: string) {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, ".bun-version"), "1.4.4\n");
  writeFileSync(join(dir, "scripts", "marina.ts"), "");
  writeFileSync(join(dir, "marina.db"), "world");
  writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=x\n");
  mkdirSync(join(dir, "data", "assets"), { recursive: true });
  writeFileSync(join(dir, "data", "assets", "photo.png"), "png");
}

describe("PATH lines", () => {
  it("removes only setup's marked line for a folder in the home", () => {
    const text = [
      "alias ll='ls -l'",
      "",
      "# Added by Marina setup",
      `export PATH="${home}/bin:$PATH"`,
      "",
      "# Added by Marina setup",
      `export PATH="${user}/.bun/bin:$PATH"`,
      `export PATH="${home}-other/bin:$PATH"`,
    ].join("\n");
    const edit = pathEditsFor("/rc", text, home)!;
    expect(edit.lines).toEqual([1, 2, 3]);
    expect(namesFolder(`fish_add_path ${home}/bin`, home)).toBe(true);
    expect(namesFolder(`export PATH="${home}-other/bin"`, home)).toBe(false);
  });
});

describe("moving an older install into the home", () => {
  it("moves the world into world/ and the code into app/", () => {
    const old = join(user, "marina");
    oldInstall(old);
    const result = migrateLegacyInstall(old, env);
    expect(result.app).toBe(join(home, "app"));
    expect(readFileSync(join(home, "world", "marina.db"), "utf8")).toBe("world");
    expect(readFileSync(join(home, "world", ".env"), "utf8")).toContain("ANTHROPIC_API_KEY");
    expect(existsSync(join(home, "world", "data", "assets", "photo.png"))).toBe(true);
    expect(existsSync(join(home, "app", "scripts", "marina.ts"))).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  it("never moves someone's own clone (edited tracked files)", () => {
    const clone = join(user, "marina");
    oldInstall(clone);
    git(clone, "init", "-q");
    git(clone, "add", ".bun-version", "scripts/marina.ts");
    git(clone, "commit", "-qm", "x");
    writeFileSync(join(clone, ".bun-version"), "edited\n");
    const result = migrateLegacyInstall(clone, env);
    expect(result.app).toBe(clone);
    expect(result.notes.join()).toContain("your own changes");
    expect(existsSync(join(clone, "marina.db"))).toBe(true);
  });
});

describe("marina uninstall", () => {
  function machine() {
    // The home: code, Bun, the command, a world, a folder world, settings.
    mkdirSync(join(home, "app", "scripts"), { recursive: true });
    writeFileSync(join(home, "app", ".bun-version"), "1.4.4\n");
    writeFileSync(join(home, "app", "scripts", "marina.ts"), "");
    mkdirSync(join(home, "bun", "bin"), { recursive: true });
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "marina"), "#!/bin/sh\n");
    mkdirSync(join(home, "world"), { recursive: true });
    writeFileSync(join(home, "world", "marina.db"), "w");
    mkdirSync(join(home, "projects", "demo-1234"), { recursive: true });
    writeFileSync(join(home, ".env"), "OPENAI_API_KEY=x\n");
    // An older version's cache, an older setup's link, the PATH line.
    mkdirSync(join(user, ".cache", "marina"), { recursive: true });
    mkdirSync(join(user, ".bun", "bin"), { recursive: true });
    symlinkSync(join(user, "marina", "scripts", "marina.ts"), join(user, ".bun", "bin", "marina"));
    writeFileSync(join(user, ".bun", "bin", "bun"), "");
    writeFileSync(
      join(user, ".bashrc"),
      `alias ll='ls -l'\n\n# Added by Marina setup\nexport PATH="${home}/bin:$PATH"\n`,
    );
    // A repository Code Mode made a worktree of.
    const repo = join(user, "code", "app");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-qm", "a");
    const worktree = join(home, "worktrees", "abc", "s1");
    mkdirSync(join(home, "worktrees", "abc"), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "marina/session-s1", worktree);
    writeFileSync(join(worktree, "draft.txt"), "uncommitted");
    // Things that are not Marina's.
    mkdirSync(join(user, "Documents"), { recursive: true });
    writeFileSync(join(user, "Documents", "mine.txt"), "mine");
    return { repo, worktree };
  }

  it("shows everything, then removes all of it and nothing else", () => {
    const { repo } = machine();
    const plan = planUninstall({ env });
    const shown = renderPlan(plan).join("\n");
    expect(shown).toContain(join(home, "world"));
    expect(shown).toContain(join(user, ".cache", "marina"));
    expect(shown).toContain("hold changes nobody committed");
    expect(plan.links.sort()).toEqual(
      [join(home, "bin", "marina"), join(user, ".bun", "bin", "marina")].sort(),
    );
    expect(plan.worktrees).toMatchObject([{ repo, branch: "marina/session-s1", dirty: true }]);

    expect(applyUninstall(plan)).toEqual([]);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(user, ".cache", "marina"))).toBe(false);
    expect(existsSync(join(user, ".bun", "bin", "marina"))).toBe(false);
    // Kept: Bun, the person's files, the repository and its branch.
    expect(existsSync(join(user, ".bun", "bin", "bun"))).toBe(true);
    expect(readFileSync(join(user, "Documents", "mine.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(user, ".bashrc"), "utf8")).toBe("alias ll='ls -l'\n");
    expect(git(repo, "worktree", "list").stdout.trim().split("\n")).toHaveLength(1);
    expect(git(repo, "branch", "--list", "marina/*").stdout).toContain("marina/session-s1");
  });

  it("--keep-data keeps worlds, settings and worktrees; the program goes", () => {
    const { repo, worktree } = machine();
    oldInstall(join(user, "marina"));
    const plan = planUninstall({ env, keepData: true });
    expect(applyUninstall(plan, { keepData: true })).toEqual([]);
    for (const kept of ["world", "projects", ".env", "worktrees"])
      expect(existsSync(join(home, kept))).toBe(true);
    for (const gone of ["app", "bun", "bin"]) expect(existsSync(join(home, gone))).toBe(false);
    // The older install's world moved into the home before its code went, beside the
    // home's own world (never over it).
    expect(existsSync(join(user, "marina"))).toBe(false);
    expect(readFileSync(join(home, "world", "marina.db"), "utf8")).toBe("w");
    expect(readFileSync(join(home, "world-old", "marina.db"), "utf8")).toBe("world");
    expect(existsSync(join(home, "world-old", "data", "assets", "photo.png"))).toBe(true);
    // The worktree is still a worktree.
    expect(readFileSync(join(worktree, "draft.txt"), "utf8")).toBe("uncommitted");
    expect(git(repo, "worktree", "list").stdout).toContain(worktree);
  });

  it("never touches a Marina checkout with someone's own changes", () => {
    machine();
    const clone = join(user, "marina");
    oldInstall(clone);
    git(clone, "init", "-q");
    git(clone, "add", ".bun-version");
    git(clone, "commit", "-qm", "x");
    writeFileSync(join(clone, ".bun-version"), "edited\n");
    const plan = planUninstall({ env });
    expect(plan.remove.some((r) => r.path === clone)).toBe(false);
    expect(plan.keep.some((k) => k.path === clone)).toBe(true);
  });
});
