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
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerWorkspace, resolveContainerRunner } from "../src/coding/container-workspace";
import {
  CODE_RUN_HOME,
  HOST_GIT_CONFIG_ARGS,
  hostGitArgv,
  hostGitDriverOverrides,
  hostGitEnv,
} from "../src/coding/host-git";
import { LocalWorkspace, runCapture } from "../src/coding/local-workspace";
import { prepareAgentWorkspace } from "../src/routing/agent-workspace";
import { captureReviewSnapshot } from "../src/routing/review-snapshot";
import { GIT_SYNC_TIMEOUT_MS, git, gitInit, testGitEnv } from "./git-helpers";

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
    Bun.spawnSync(["git", "diff"], {
      cwd: root,
      env: testGitEnv(),
      stdout: "pipe",
      timeout: GIT_SYNC_TIMEOUT_MS,
    });
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

  it("the routing review snapshot never runs a planted fsmonitor or external diff", async () => {
    writeFileSync(join(root, "untracked.txt"), "u\n");
    const snapshot = await captureReviewSnapshot(root);
    expect(snapshot.text).toContain("+two");
    expect(snapshot.text).toContain("untracked.txt");
    expect(planted()).toBe(false);
  });

  it("a routing worktree workspace never runs planted hooks", async () => {
    const state = join(scratch, "state");
    const result = await prepareAgentWorkspace(scratch, "repo", "worktree", state, "wt-route");
    expect(existsSync(join(result.cwd, "a.txt"))).toBe(true);
    expect(result.dirty).toBe(true);
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

describe("host git never descends into a redirected submodule", () => {
  // A submodule's `.git` gitfile sits in the writable work tree. Code that can
  // write there points it at a gitdir it controls whose config names a clean
  // filter; a host diff that recursed into the submodule would run it.
  function submoduleRepo(): { proj: string; plantedFilter: () => boolean } {
    const filterMarker = join(scratch, "FILTER");
    const filterScript = join(scratch, "filter.sh");
    writeFileSync(filterScript, `#!/bin/sh\necho filter >> "${filterMarker}"\ncat\n`);
    chmodSync(filterScript, 0o755);
    const sub = join(scratch, "subsrc");
    mkdirSync(sub);
    gitInit(sub);
    writeFileSync(join(sub, "s.txt"), "s\n");
    git(sub, "add", ".");
    git(sub, "commit", "-qm", "s");
    const proj = join(scratch, "proj");
    mkdirSync(proj);
    gitInit(proj);
    writeFileSync(join(proj, "a.txt"), "a\n");
    git(proj, "add", ".");
    git(proj, "commit", "-qm", "a");
    git(proj, "-c", "protocol.file.allow=always", "submodule", "-q", "add", sub, "sub");
    git(proj, "commit", "-qm", "sub");
    // What sandboxed or agent-written code can do with workspace write access only:
    cpSync(join(proj, ".git", "modules", "sub"), join(proj, "evilgit"), { recursive: true });
    writeFileSync(join(proj, "sub", ".git"), "gitdir: ../evilgit\n");
    appendFileSync(
      join(proj, "evilgit", "config"),
      `[core]\n\tworktree = ../sub\n[filter "x"]\n\tclean = ${filterScript}\n`,
    );
    writeFileSync(join(proj, "sub", ".gitattributes"), "s.txt filter=x\n");
    writeFileSync(join(proj, "sub", "s.txt"), "s\n");
    const old = new Date("2021-01-01T00:00:00Z");
    utimesSync(join(proj, "sub", "s.txt"), old, old);
    return { proj, plantedFilter: () => existsSync(filterMarker) };
  }

  it("the planted filter is live for a recursing git (the test is meaningful)", () => {
    const { proj, plantedFilter } = submoduleRepo();
    // Every hardening flag except the two submodule guards (pairs of "-c", value).
    const flags: string[] = [];
    for (let i = 0; i < HOST_GIT_CONFIG_ARGS.length; i += 2) {
      const value = HOST_GIT_CONFIG_ARGS[i + 1]!;
      if (!/^(diff\.ignoreSubmodules|submodule\.recurse)=/.test(value)) flags.push("-c", value);
    }
    Bun.spawnSync(
      ["git", ...flags, "diff", "--no-ext-diff", "--name-only", "--no-renames", "HEAD", "--"],
      {
        cwd: proj,
        env: hostGitEnv(),
        stdout: "pipe",
        stderr: "pipe",
        timeout: GIT_SYNC_TIMEOUT_MS,
      },
    );

    expect(plantedFilter()).toBe(true);
  });

  it("changedPaths, diff and allowlisted status never run it", async () => {
    const { proj, plantedFilter } = submoduleRepo();
    const ws = new LocalWorkspace(proj);
    await ws.changedPaths();
    await ws.diff();
    await ws.run(["git", "status", "--short"]);
    expect(plantedFilter()).toBe(false);
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
      // Always the scratch home, never the server's own. Under Code Mode (a candidate
      // verification of Marina itself) the process's HOME already is that scratch home.
      expect(env.HOME).toBe(CODE_RUN_HOME);
      expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    } finally {
      delete process.env.MARINA_TEST_SERVER_SECRET;
    }
  });
});

describe("host git never runs the repository's content drivers", () => {
  // A repository config may name content drivers (a clean filter such as
  // nbstripout's, a textconv, a merge driver) whose programs read files from
  // the work tree, which workspace code can write. Host git hashes, diffs and
  // merges work-tree content with them switched off.
  let repo: string;
  let driverMarker: string;
  const fired = () => existsSync(driverMarker);
  beforeEach(() => {
    repo = join(scratch, "drivers");
    mkdirSync(repo);
    driverMarker = join(scratch, "DRIVER");
    gitInit(repo);
    writeFileSync(join(repo, ".gitattributes"), "*.nb filter=nbs diff=t merge=m\n");
    writeFileSync(join(repo, "n.nb"), "cell\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    appendFileSync(
      join(repo, ".git", "config"),
      '[filter "nbs"]\n\tclean = sh conv.sh\n\tsmudge = sh conv.sh\n' +
        '[diff "t"]\n\ttextconv = sh conv.sh\n\tcommand = sh conv.sh\n' +
        '[merge "m"]\n\tdriver = sh conv.sh %O %A %B\n',
    );
    // Written by workspace code: the program the configured drivers run.
    writeFileSync(
      join(repo, "conv.sh"),
      `echo driver >> "${driverMarker}"\nif [ -f "$1" ]; then cat "$1"; else cat; fi\n`,
    );
    // Same content, new mtime: git must hash the file again (through the clean filter).
    writeFileSync(join(repo, "n.nb"), "cell\n");
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(repo, "n.nb"), later, later);
    writeFileSync(join(repo, "other.nb"), "new\n");
  });

  it("the drivers are live for git hardened without them (the test is meaningful)", () => {
    Bun.spawnSync(hostGitArgv(["git", "diff", "--name-only", "HEAD", "--"]), {
      cwd: repo,
      env: hostGitEnv(),
      stdout: "pipe",
      stderr: "pipe",
      timeout: GIT_SYNC_TIMEOUT_MS,
    });
    expect(fired()).toBe(true);
  });

  it("changedPaths, diff, allowlisted status and show never run them; hashing still works", async () => {
    const ws = new LocalWorkspace(repo);
    const changed = await ws.changedPaths();
    expect(changed).toContain("other.nb");
    expect(changed).not.toContain("n.nb");
    const diff = await ws.diff();
    expect(diff.exitCode).toBe(0);
    expect((await ws.run(["git", "status", "--short"])).exitCode).toBe(0);
    await runCapture(["git", "show", "--textconv", "HEAD"], repo, 65_536);
    await runCapture(["git", "log", "-p", "-1"], repo, 65_536);
    expect(fired()).toBe(false);
  });

  it("the container patch-sync diff (pendingDiff) never runs them", async () => {
    const ws = new ContainerWorkspace(
      repo,
      resolveContainerRunner(
        { image: "docker.io/library/alpine:latest", sync: "patch" },
        {},
        () => "/usr/bin/podman",
      ),
    );
    expect(await ws.pendingDiff()).toContain("other.nb");
    expect(fired()).toBe(false);
  });

  it("a merge through a configured merge driver reports a conflict instead of running it", () => {
    git(repo, "checkout", "-q", "-b", "other");
    writeFileSync(join(repo, "n.nb"), "theirs\n");
    git(repo, "commit", "-qam", "theirs");
    git(repo, "checkout", "-q", "-");
    writeFileSync(join(repo, "n.nb"), "ours\n");
    git(repo, "commit", "-qam", "ours");
    rmSync(driverMarker, { force: true });
    const merge = Bun.spawnSync(hostGitArgv(["git", "merge", "-q", "other"], repo), {
      cwd: repo,
      env: hostGitEnv({
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      }),
      stdout: "pipe",
      stderr: "pipe",
      timeout: GIT_SYNC_TIMEOUT_MS,
    });
    expect(merge.exitCode).not.toBe(0);
    expect(fired()).toBe(false);
  });

  it("hostGitDriverOverrides switches off each named driver, and diff.external when set", () => {
    appendFileSync(join(repo, ".git", "config"), "[diff]\n\texternal = sh conv.sh\n");
    const args = hostGitDriverOverrides(repo);
    for (const value of [
      "filter.nbs.clean=",
      "filter.nbs.smudge=",
      "filter.nbs.process=",
      "filter.nbs.required=false",
    ])
      expect(args).toContain(value);
    // Every program is absolute: git resolves a bare name through PATH.
    for (const pattern of [
      /^diff\.t\.textconv=\/(usr\/)?bin\/cat$/,
      /^diff\.t\.command=\/(usr\/)?bin\/true$/,
      /^diff\.external=\/(usr\/)?bin\/true$/,
      /^merge\.m\.driver=\/(usr\/)?bin\/false$/,
    ])
      expect(args.some((a) => pattern.test(a))).toBe(true);
    expect(hostGitDriverOverrides(scratch)).toEqual([]);
    git(repo, "config", "filter.a=b.clean", "x");
    expect(() => hostGitDriverOverrides(repo)).toThrow(/cannot be overridden safely/);
  });
});
