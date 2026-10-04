// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host git must never execute what code inside a workspace planted in its git
 * metadata: an fsmonitor, a hook, a hooksPath, an external diff driver. These
 * tests plant each one "from inside" (as a test suite run in the workspace
 * could) and drive every host-side git path Code Mode uses.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerWorkspace, resolveContainerRunner } from "../src/coding/container-workspace";
import { HOST_GIT_CONFIG_ARGS, hostGitArgv, hostGitEnv } from "../src/coding/host-git";
import { LocalWorkspace, runCapture } from "../src/coding/local-workspace";
import { git, gitInit, testGitEnv } from "./git-helpers";

let root: string;
let marker: string;
let scratch: string;

function plantScript(name: string, tag: string): string {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/sh\necho ${tag} >> "${marker}"\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "marina-hostgit-")));
  root = join(scratch, "repo");
  mkdirSync(root);
  marker = join(scratch, "PWNED");
  gitInit(root);
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  // Everything below is what code running inside the workspace could write.
  const fsmonitor = plantScript("fsmonitor.sh", "fsmonitor");
  const extDiff = plantScript("extdiff.sh", "extdiff");
  const hooks = join(root, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const hook of [
    "post-checkout",
    "pre-commit",
    "post-index-change",
    "reference-transaction",
  ]) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\necho hook:${hook} >> "${marker}"\n`);
    chmodSync(join(hooks, hook), 0o755);
  }
  appendFileSync(
    join(root, ".git", "config"),
    `[core]\n\tfsmonitor = ${fsmonitor}\n[diff]\n\texternal = ${extDiff}\n`,
  );
  writeFileSync(join(root, "a.txt"), "two\n");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const planted = () => existsSync(marker);

describe("host git hardening", () => {
  it("the planted config is live for an unhardened git (the test is meaningful)", () => {
    Bun.spawnSync(["git", "diff"], { cwd: root, env: testGitEnv(), stdout: "pipe" });
    expect(planted()).toBe(true);
  });

  it("LocalWorkspace.diff never runs a planted fsmonitor or external diff", async () => {
    const result = await new LocalWorkspace(root).diff();
    expect(result.exitCode).toBe(0);
    expect(result.content).toContain("+two");
    expect(planted()).toBe(false);
  });

  it("allowlisted git commands (status, worktree add) never run planted hooks", async () => {
    const ws = new LocalWorkspace(root);
    const status = await ws.run(["git", "status", "--short"]);
    expect(status.exitCode).toBe(0);
    expect(status.command).toEqual(["git", "status", "--short"]);
    const wt = join(scratch, "wt");
    const add = await ws.run(["git", "worktree", "add", "-b", "marina/session-x", wt, "HEAD"]);
    expect(add.exitCode).toBe(0);
    expect(existsSync(join(wt, "a.txt"))).toBe(true);
    expect(planted()).toBe(false);
  });

  it("a planted core.hooksPath is overridden too", async () => {
    const hooks = join(scratch, "evil-hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\necho hookspath >> "${marker}"\n`);
    chmodSync(join(hooks, "post-checkout"), 0o755);
    appendFileSync(join(root, ".git", "config"), `[core]\n\thooksPath = ${hooks}\n`);
    const wt = join(scratch, "wt2");
    await new LocalWorkspace(root).run([
      "git",
      "worktree",
      "add",
      "-b",
      "marina/session-y",
      wt,
      "HEAD",
    ]);
    expect(planted()).toBe(false);
  });

  it("patch check/apply never run planted drivers", async () => {
    const ws = new LocalWorkspace(root);
    const patch = [
      "diff --git a/b.txt b/b.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@ -0,0 +1 @@",
      "+new",
      "",
    ].join("\n");
    expect((await ws.checkPatch(patch)).ok).toBe(true);
    expect((await ws.applyPatch(patch)).ok).toBe(true);
    expect(planted()).toBe(false);
  });

  it("the container patch-sync diff (pendingDiff) never runs planted drivers", async () => {
    writeFileSync(join(root, "untracked.txt"), "u\n");
    const ws = new ContainerWorkspace(
      root,
      resolveContainerRunner(
        { image: "docker.io/library/alpine:latest", sync: "patch" },
        {},
        () => "/usr/bin/podman",
      ),
    );
    const diff = await ws.pendingDiff();
    expect(diff).toContain("+two");
    expect(diff).toContain("untracked.txt");
    expect(planted()).toBe(false);
  });

  it("host git gets the -c overrides and an environment without server secrets", async () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), '#!/bin/sh\necho "ARGS:$*"\nenv\n');
    chmodSync(join(bin, "git"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    process.env.MARINA_TEST_SERVER_SECRET = "sk-should-not-leak";
    process.env.GIT_DIR = "/elsewhere/.git";
    try {
      const out = (await new LocalWorkspace(root).diff()).content;
      expect(out).toContain("core.fsmonitor=false");
      expect(out).toContain("core.hooksPath=/dev/null");
      expect(out).toContain("--no-ext-diff");
      expect(out).toContain("GIT_CONFIG_NOSYSTEM=1");
      expect(out).toContain("GIT_CONFIG_GLOBAL=/dev/null");
      expect(out).not.toContain("sk-should-not-leak");
      expect(out).not.toContain("GIT_DIR=");
      const run = await runCapture(["git", "status"], root, 65_536);
      expect(run.content).toContain("core.hooksPath=/dev/null");
      expect(run.content).not.toContain("sk-should-not-leak");
    } finally {
      process.env.PATH = savedPath;
      delete process.env.MARINA_TEST_SERVER_SECRET;
      delete process.env.GIT_DIR;
    }
  });
});

describe("hostGitArgv / hostGitEnv", () => {
  it("prefixes the overrides once and switches off diff drivers", () => {
    const argv = hostGitArgv(["git", "diff", "HEAD", "--binary"]);
    expect(argv.slice(0, 1 + HOST_GIT_CONFIG_ARGS.length)).toEqual([
      "git",
      ...HOST_GIT_CONFIG_ARGS,
    ]);
    expect(argv.slice(1 + HOST_GIT_CONFIG_ARGS.length)).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
      "--binary",
    ]);
    expect(hostGitArgv(argv)).toEqual(argv);
    expect(hostGitArgv(["rg", "x"])).toEqual(["rg", "x"]);
  });

  it("keeps only PATH from the server environment", () => {
    process.env.MARINA_TEST_SERVER_SECRET = "x";
    try {
      const env = hostGitEnv();
      expect(Object.keys(env)).not.toContain("MARINA_TEST_SERVER_SECRET");
      expect(env.HOME).not.toBe(process.env.HOME);
      expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    } finally {
      delete process.env.MARINA_TEST_SERVER_SECRET;
    }
  });
});
