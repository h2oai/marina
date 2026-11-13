// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { sandboxNotices } from "../scripts/code";
import { HostExecForbiddenError, LocalWorkspace } from "../src/coding/local-workspace";
import {
  assertBwrapVersion,
  assertTrustedBinary,
  bunToolEntries,
  codeSandboxMode,
  collectGitlinks,
  labelSetupFailure,
  programConfigPins,
  resolveBwrap,
  resolveSandboxLayout,
  SANDBOX_HOME,
  SANDBOX_SYSTEM_PATHS,
  type SandboxLayout,
  type SandboxLayoutOptions,
  type SandboxTamperError,
  SandboxWorkspace,
  sandboxArgv,
  sandboxEnv,
  sandboxGitPaths,
  sandboxLimits,
  serverStatePaths,
  setSandboxDefaultsForTests,
  UnavailableSandboxWorkspace,
} from "../src/coding/sandbox-workspace";
import { beginCodingRun } from "../src/coding/task-run";
import { VerificationRunner } from "../src/coding/verification-runner";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { codeCommand } from "../src/engine/commands/code";
import {
  applySessionRunner,
  effectiveRunner,
  RUNNER_ARTIFACT_KIND,
  SANDBOX_HOLD_ALERT_PREFIX,
  SANDBOX_HOLD_OWNER,
  sessionRunnerSetting,
} from "../src/engine/commands/code/runner";
import { setPrincipalResolver } from "../src/engine/gate-context";
import { grant } from "../src/engine/safety-gates";
import { isProtectedEnvKey, PROTECTED_ENV_KEYS } from "../src/net/dashboard-api/keys";
import { type CodingSessionRow, MarinaDB } from "../src/persistence/database";
import {
  type CommandInput,
  type Entity,
  type EntityId,
  type RoomContext,
  roomId,
} from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { git, gitInit } from "./git-helpers";
import { cleanupDb, stripAnsi, tempDbPath, until } from "./helpers";
import { scopeProcessState } from "./process-state";

/** bwrap at a fixed path AND able to create its namespaces here (user namespaces may be disabled). */
function bwrapWorks(): boolean {
  const bwrap = ["/usr/bin/bwrap", "/bin/bwrap"].find((path) => existsSync(path));
  if (!bwrap || !existsSync("/usr/bin/prlimit")) return false;
  const probe = Bun.spawnSync(
    [bwrap, "--unshare-all", "--unshare-user", "--disable-userns", "--ro-bind", "/", "/", "true"],
    { stdout: "ignore", stderr: "ignore" },
  );
  return probe.exitCode === 0;
}
const BWRAP = bwrapWorks();

/** A writable directory outside /tmp (the sandbox's /tmp is private), for a stand-in system dir. */
const VAR_TMP = (() => {
  try {
    rmSync(mkdtempSync("/var/tmp/marina-sbx-probe-"), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/**
 * Stand-in launchers so every policy test runs without bubblewrap: the fake
 * bwrap answers `--version`, honours `--chdir`, and execs what follows `--`
 * (the fake prlimit likewise). Commands then run on the host — in tests only.
 */
function fakeLaunchers(): { dir: string; opts: SandboxLayoutOptions } {
  const dir = tmp("marina-sbx-fake-");
  chmodSync(dir, 0o755);
  writeFileSync(
    join(dir, "bwrap"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "bubblewrap 0.13.1"; exit 0; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --chdir) cd "$2" || exit 125; shift 2 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
exec "$@"
`,
  );
  writeFileSync(
    join(dir, "prlimit"),
    `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --) shift; break ;; *) shift ;; esac; done
exec "$@"
`,
  );
  chmodSync(join(dir, "bwrap"), 0o755);
  chmodSync(join(dir, "prlimit"), 0o755);
  return {
    dir,
    opts: {
      bwrapPaths: [join(dir, "bwrap")],
      prlimitPaths: [join(dir, "prlimit")],
      systemPaths: [...SANDBOX_SYSTEM_PATHS, dir],
    },
  };
}

function pairAfter(argv: string[], flag: string, value: string): number {
  for (let i = 0; i < argv.length - 2; i++)
    if (argv[i] === flag && argv[i + 1] === value && argv[i + 2] === value) return i;
  return -1;
}

describe("sandbox argv (pure)", () => {
  const layout: SandboxLayout = {
    bwrap: "/usr/bin/bwrap",
    prlimit: "/usr/bin/prlimit",
    root: "/home/u/proj",
    home: "/home/u",
    system: [{ path: "/usr" }, { path: "/bin", link: "usr/bin" }, { path: "/etc" }],
    tools: [{ path: "/home/u/.bun/bin/bun" }],
    grants: ["/data/in"],
    pins: {
      dirs: ["/home/u/proj/a/mid", "/home/u/proj/a"],
      readOnly: ["/home/u/proj/a/mid/.git", "/home/u/proj/.husky"],
      emptyDirs: ["/home/u/proj/gone"],
    },
    readOnly: ["/home/u/proj/.git", "/home/u/main/.git/modules"],
    hooks: [],
    env: sandboxEnv("/usr/bin:/home/u/.bun/bin"),
    limits: { tmpfsMb: 64, shmMb: 8, nproc: 100, asMb: 2048, fsizeMb: 10 },
  };
  const argv = sandboxArgv(layout, ["sh", "-c", "echo a | tr a b"]);

  it("unshares every namespace incl. user and network, disables nested userns, no caps", () => {
    expect(argv[0]).toBe("/usr/bin/bwrap");
    for (const flag of [
      "--unshare-all",
      "--unshare-user",
      "--disable-userns",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
    ])
      expect(argv).toContain(flag);
    expect(argv).not.toContain("--share-net");
    expect(argv[argv.indexOf("--cap-drop") + 1]).toBe("ALL");
  });

  it("clears the environment and sets only the scrubbed Code Mode env with a scratch HOME", () => {
    const clear = argv.indexOf("--clearenv");
    const set: Record<string, string> = {};
    argv.forEach((arg, i) => {
      if (arg === "--setenv") {
        expect(i).toBeGreaterThan(clear);
        set[argv[i + 1]!] = argv[i + 2]!;
      }
    });
    expect(set).toEqual({
      TERM: "dumb",
      LANG: "en_US.UTF-8",
      CI: "1",
      PATH: "/usr/bin:/home/u/.bun/bin",
      HOME: SANDBOX_HOME,
      TMPDIR: "/tmp",
    });
  });

  it("binds the system read-only, recreates merged-/usr symlinks, and never binds / wholesale", () => {
    expect(pairAfter(argv, "--ro-bind", "/usr")).toBeGreaterThan(0);
    expect(argv.join(" ")).toContain("--symlink usr/bin /bin");
    expect(pairAfter(argv, "--ro-bind", "/")).toBe(-1);
    expect(pairAfter(argv, "--bind", "/")).toBe(-1);
  });

  it("caps every tmpfs with --size", () => {
    const bytes = String(64 * 1024 * 1024);
    for (const target of ["/tmp", "/home/u"]) {
      const at = argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === target);
      expect(argv.slice(at - 2, at)).toEqual(["--size", bytes]);
    }
  });

  it("a capped private /dev/shm, then /dev read-only", () => {
    const shm = argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === "/dev/shm");
    expect(argv.slice(shm - 2, shm)).toEqual(["--size", String(8 * 1024 * 1024)]);
    expect(shm).toBeGreaterThan(argv.indexOf("--dev"));
    expect(argv[argv.indexOf("--remount-ro") + 1]).toBe("/dev");
    expect(argv.indexOf("--remount-ro")).toBeGreaterThan(shm);
  });

  it("pins: directories bound onto themselves shallowest first, then targets read-only, before git metadata", () => {
    const a = pairAfter(argv, "--bind", "/home/u/proj/a");
    const mid = pairAfter(argv, "--bind", "/home/u/proj/a/mid");
    const midGit = pairAfter(argv, "--ro-bind", "/home/u/proj/a/mid/.git");
    const husky = pairAfter(argv, "--ro-bind", "/home/u/proj/.husky");
    const rootGit = pairAfter(argv, "--ro-bind", "/home/u/proj/.git");
    expect(a).toBeGreaterThan(pairAfter(argv, "--bind", "/home/u/proj"));
    expect(mid).toBeGreaterThan(a);
    expect(midGit).toBeGreaterThan(mid);
    expect(husky).toBeGreaterThan(mid);
    expect(rootGit).toBeGreaterThan(Math.max(midGit, husky));
    // An absent gitlink directory: an empty, size-capped, read-only tmpfs.
    const gone = argv.findIndex((x, i) => x === "--tmpfs" && argv[i + 1] === "/home/u/proj/gone");
    expect(argv.slice(gone - 2, gone + 4)).toEqual([
      "--size",
      "4096",
      "--tmpfs",
      "/home/u/proj/gone",
      "--remount-ro",
      "/home/u/proj/gone",
    ]);
    expect(rootGit).toBeGreaterThan(gone);
  });

  it("masks the home BEFORE binding only the Bun executable back", () => {
    const home = argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === "/home/u");
    expect(pairAfter(argv, "--ro-bind", "/home/u/.bun/bin/bun")).toBeGreaterThan(home);
    expect(pairAfter(argv, "--ro-bind", "/home/u/.bun")).toBe(-1);
  });

  it("workspace rw, task roots ro, and the git metadata read-only LAST", () => {
    const rw = pairAfter(argv, "--bind", "/home/u/proj");
    const grantAt = pairAfter(argv, "--ro-bind", "/data/in");
    const git = pairAfter(argv, "--ro-bind", "/home/u/proj/.git");
    const modules = pairAfter(argv, "--ro-bind", "/home/u/main/.git/modules");
    expect(grantAt).toBeGreaterThan(rw);
    expect(git).toBeGreaterThan(grantAt);
    expect(modules).toBeGreaterThan(git);
    const lastMount = Math.max(
      ...argv.map((a, i) => (["--bind", "--ro-bind", "--tmpfs", "--symlink"].includes(a) ? i : -1)),
    );
    expect(lastMount).toBe(modules);
  });

  it("runs the argv unchanged under prlimit, in the workspace", () => {
    expect(argv.slice(argv.indexOf("--chdir"), argv.indexOf("--chdir") + 2)).toEqual([
      "--chdir",
      "/home/u/proj",
    ]);
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual([
      "/usr/bin/prlimit",
      "--nproc=100",
      `--as=${2048 * 1024 * 1024}`,
      `--fsize=${10 * 1024 * 1024}`,
      "--core=0",
      "--",
      "sh",
      "-c",
      "echo a | tr a b",
    ]);
    expect(() => sandboxArgv(layout, [])).toThrow();
  });

  it("reads the operator limits, ignoring junk", () => {
    expect(sandboxLimits({})).toEqual({
      tmpfsMb: 1024,
      shmMb: 64,
      nproc: 4096,
      asMb: 16_384,
      fsizeMb: 4096,
    });
    expect(
      sandboxLimits({ MARINA_CODE_SANDBOX_TMPFS_MB: "8", MARINA_CODE_SANDBOX_NPROC: "-1" }),
    ).toMatchObject({ tmpfsMb: 8, nproc: 4096 });
  });
});

describe("trusted launchers", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp("marina-sbx-launch-");
    chmodSync(dir, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const exe = (name: string, mode = 0o755) => {
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\necho bubblewrap 0.13.1\n");
    chmodSync(path, mode);
    return path;
  };

  it("never resolves bwrap through PATH", () => {
    exe("bwrap");
    const savedPath = process.env.PATH;
    process.env.PATH = `${dir}:${savedPath}`;
    try {
      expect(() => resolveBwrap([], {}, ["/nonexistent/bwrap"])).toThrow(/never via PATH/);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("takes the fixed paths first, then an absolute MARINA_CODE_SANDBOX_BWRAP only", () => {
    const operator = exe("bwrap");
    expect(resolveBwrap([], { MARINA_CODE_SANDBOX_BWRAP: operator }, ["/nonexistent/bwrap"])).toBe(
      operator,
    );
    expect(() =>
      resolveBwrap([], { MARINA_CODE_SANDBOX_BWRAP: "bwrap" }, ["/nonexistent/bwrap"]),
    ).toThrow(/absolute/);
  });

  it("refuses a launcher inside the workspace, group/world-writable, or owned by someone else", () => {
    const ok = exe("bwrap");
    expect(() => assertTrustedBinary(ok, [dir])).toThrow(/inside a workspace/);
    expect(() => assertTrustedBinary(exe("gw", 0o775), [])).toThrow(/group- or world-writable/);
    const uid = process.getuid?.() ?? 0;
    if (uid !== 0)
      expect(() => assertTrustedBinary(ok, [], uid + 4242)).toThrow(
        /neither root nor the server user/,
      );
    // A present-but-untrusted fixed candidate fails closed (never falls through).
    expect(() => resolveBwrap([], { MARINA_CODE_SANDBOX_BWRAP: ok }, [exe("bad", 0o777)])).toThrow(
      /writable/,
    );
  });

  it("refuses a bubblewrap too old for --size / --disable-userns", () => {
    expect(() => assertBwrapVersion("/x/bwrap", "bubblewrap 0.6.1")).toThrow(/0\.10\.0 or newer/);
    expect(() => assertBwrapVersion("/x/bwrap", "bubblewrap 0.10.0")).not.toThrow();
  });
});

describe("sandbox layout refusals (no bubblewrap needed)", () => {
  let root: string;
  let home: string;
  let fake: ReturnType<typeof fakeLaunchers>;
  const layout = (r: string, extra: SandboxLayoutOptions = {}) =>
    resolveSandboxLayout(r, [], { ...fake.opts, home, ...extra });
  beforeEach(() => {
    root = tmp("marina-sbx-layout-");
    home = tmp("marina-sbx-home-");
    fake = fakeLaunchers();
    gitInit(root);
  });
  afterEach(() => {
    for (const d of [root, home, fake.dir]) rmSync(d, { recursive: true, force: true });
  });

  it("needs its own .git and refuses a root holding the home", () => {
    const bare = tmp("marina-sbx-bare-");
    try {
      expect(() => layout(bare)).toThrow(/git repository root/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    expect(() => resolveSandboxLayout(root, [], { ...fake.opts, home: join(root, "h") })).toThrow(
      /contains the home directory/,
    );
    expect(layout(root).bwrap).toBe(join(fake.dir, "bwrap"));
  });

  it("refuses a root that holds the server's own state (DB_PATH, ledger, ~/.marina, .env)", () => {
    expect(() => layout(root, { serverState: [join(root, "marina.db")] })).toThrow(
      /server's own state/,
    );
    const state = serverStatePaths(
      { DB_PATH: "data/world.db", MARINA_SPEND_LEDGER: "/srv/ledger.db" },
      "/home/u",
      "/srv/marina",
    );
    expect(state).toEqual(
      expect.arrayContaining(["/srv/marina/data/world.db", "/home/u/.marina", "/srv/ledger.db"]),
    );
    // A checkout the server runs in holds its live marina.db: never a sandbox root.
    expect(() => layout(root, { serverState: serverStatePaths({}, home, root) })).toThrow(
      /marina\.db/,
    );
  });

  it("refuses writable task roots, and read roots that overlap git metadata or system dirs", () => {
    const input = tmp("marina-sbx-in-");
    try {
      const opts = { ...fake.opts, home };
      const write = { root: input, access: "write" as const, guestPath: "/x" };
      expect(() => resolveSandboxLayout(root, [write], opts)).toThrow(/writable task roots/);
      const read = { root: input, access: "read" as const, guestPath: "/x" };
      expect(resolveSandboxLayout(root, [read], opts).grants).toEqual([input]);
      const usr = { root: "/usr", access: "read" as const, guestPath: "/x" };
      expect(() => resolveSandboxLayout(root, [usr], opts)).toThrow(/system directory/);
      const stateRoot = { root: input, access: "read" as const, guestPath: "/x" };
      expect(() =>
        resolveSandboxLayout(root, [stateRoot], { ...opts, serverState: [join(input, ".marina")] }),
      ).toThrow(/task root that contains the server's own state/);
      const gitRead = { root: join(root, ".git"), access: "read" as const, guestPath: "/x" };
      expect(() => resolveSandboxLayout(root, [gitRead], opts)).toThrow(/overlaps the workspace/);
    } finally {
      rmSync(input, { recursive: true, force: true });
    }
  });

  it("refuses git config includes that resolve inside the work tree (include and includeIf)", () => {
    const outside = join(home, "ok.cfg");
    writeFileSync(outside, "[core]\n");
    git(root, "config", "include.path", outside);
    expect(() => layout(root)).not.toThrow();
    git(root, "config", "include.path", "../evil.cfg");
    expect(() => layout(root)).toThrow(/include\.path .*includes a file inside the writable tree/);
    git(root, "config", "--unset", "include.path");
    git(root, "config", "includeIf.gitdir:/.path", join(root, "sub", "evil.cfg"));
    expect(() => layout(root)).toThrow(/includes/);
  });

  it("refuses a gitdir nested in the work tree outside <root>/.git", () => {
    const nested = tmp("marina-sbx-nested-");
    try {
      mkdirSync(join(nested, "hidden"));
      git(nested, "init", "-q", `--separate-git-dir=${join(nested, "hidden", "gd")}`, nested);
      expect(() => layout(nested)).toThrow(/swap it by renaming its parent/);
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it("binds a linked worktree's gitdir, common dir and <common>/modules read-only", () => {
    git(root, "commit", "--allow-empty", "-q", "-m", "init");
    mkdirSync(join(root, ".git", "modules"));
    const parent = tmp("marina-sbx-wt-");
    const wt = join(parent, "tree");
    try {
      git(root, "worktree", "add", "-q", wt);
      const { paths } = sandboxGitPaths(realpathSync(wt));
      expect(paths[0]).toBe(join(realpathSync(wt), ".git"));
      expect(paths).toContain(join(root, ".git"));
      expect(paths).toContain(join(root, ".git", "modules"));
      expect(paths.some((p) => p.startsWith(join(root, ".git", "worktrees")))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("binds only the Bun executable: never HOME, never a shared bin directory", () => {
    const shared = tmp("marina-sbx-bin-");
    try {
      writeFileSync(join(shared, "bun"), "");
      writeFileSync(join(shared, "other-tool"), "");
      expect(bunToolEntries(home, ["/usr"], join(shared, "bun"))).toEqual([
        { path: join(shared, "bun") },
      ]);
      rmSync(join(shared, "other-tool"));
      expect(bunToolEntries(home, ["/usr"], join(shared, "bun"))).toEqual([{ path: shared }]);
      // A bun directly in HOME: the file alone, never the home directory.
      writeFileSync(join(home, "bun"), "");
      expect(bunToolEntries(home, ["/usr"], join(home, "bun"))).toEqual([
        { path: join(home, "bun") },
      ]);
      // Already in a system directory: nothing extra.
      expect(bunToolEntries(home, [shared], join(shared, "bun"))).toEqual([]);
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });

  it("reads MARINA_CODE_SANDBOX: off | available (default, junk) | default | required", () => {
    expect(codeSandboxMode({})).toBe("available");
    expect(codeSandboxMode({ MARINA_CODE_SANDBOX: "off" })).toBe("off");
    expect(codeSandboxMode({ MARINA_CODE_SANDBOX: "default" })).toBe("default");
    expect(codeSandboxMode({ MARINA_CODE_SANDBOX: "required" })).toBe("required");
    expect(codeSandboxMode({ MARINA_CODE_SANDBOX: "bogus" })).toBe("available");
  });

  it("labels a sandbox that never started", () => {
    const failed = labelSetupFailure({
      exitCode: 1,
      output: "\n--- stderr ---\nbwrap: setting up uid map: Permission denied",
    });
    expect(failed.output).toMatch(/could not start.*did not run.*No host fallback/s);
    const own = { exitCode: 1, output: "test failed" };
    expect(labelSetupFailure(own)).toBe(own);
  });

  it("a workspace that cannot set up the sandbox fails every command; never the host", async () => {
    const ws = new UnavailableSandboxWorkspace(root, new Error("no bwrap"));
    await expect(ws.run(["git", "status"])).rejects.toThrow(/Sandbox runner unavailable: no bwrap/);
    expect(() => ws.assertExecutionReady()).toThrow(/no bwrap/);
    expect(ws.describe().runner?.kind).toBe("sandbox");
  });

  it("the telnet host-exec chokepoint refuses before anything spawns", async () => {
    const ws = new SandboxWorkspace(root, [], { ...fake.opts, home });
    ws.setHostExecForbidden(true);
    await expect(ws.run(["true"])).rejects.toBeInstanceOf(HostExecForbiddenError);
  });
});

describe("submodule gitfiles are checked around every run (fake launcher)", () => {
  let root: string;
  let source: string;
  let home: string;
  let fake: ReturnType<typeof fakeLaunchers>;
  beforeEach(() => {
    fake = fakeLaunchers();
    home = tmp("marina-sbx-home-");
    source = tmp("marina-sbx-subsrc-");
    gitInit(source);
    git(source, "commit", "--allow-empty", "-q", "-m", "sub");
    root = tmp("marina-sbx-super-");
    gitInit(root);
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
    git(root, "commit", "-q", "-m", "add sub");
  });
  afterEach(() => {
    for (const d of [root, source, home, fake.dir]) rmSync(d, { recursive: true, force: true });
  });

  it("an untouched submodule runs normally", async () => {
    const ws = new SandboxWorkspace(root, [], { ...fake.opts, home });
    const result = await ws.run(["sh", "-c", "echo fine"]);
    expect(result.output.trim()).toBe("fine");
  });

  it("a rewritten gitfile fails the command, restores nothing, and reports the tamper", async () => {
    const tampers: SandboxTamperError[] = [];
    const ws = new SandboxWorkspace(root, [], { ...fake.opts, home }, (e) => tampers.push(e));
    const evil = join(home, "evilgit");
    await expect(ws.run(["sh", "-c", `printf 'gitdir: ${evil}\\n' > sub/.git`])).rejects.toThrow(
      /SECURITY: a sandboxed command changed submodule git metadata \(sub\)/,
    );
    expect(tampers.map((e) => e.paths)).toEqual([["sub"]]);
    expect(realpathSync(join(root, "sub", ".git"))).toBe(join(root, "sub", ".git"));
    // Nothing restored; the next run refuses before spawning.
    await expect(ws.run(["true"])).rejects.toThrow(/does not point into/);
  });

  it("a .git directory at a gitlink path is misplaced while <modules>/<name> exists", async () => {
    const ws = new SandboxWorkspace(root, [], { ...fake.opts, home });
    rmSync(join(root, "sub", ".git"));
    mkdirSync(join(root, "sub", ".git"));
    await expect(ws.run(["true"])).rejects.toThrow(/has a \.git directory although .*modules/);
  });

  it("a submodule path with a non-ASCII character is listed raw, pinned and checked", async () => {
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "süb");
    git(root, "commit", "-q", "-m", "umlaut");
    const { records, pins } = await collectGitlinks(root, join(root, ".git"), join(root, ".git"));
    expect(records.find((r) => r.path === "süb")?.state.kind).toBe("file");
    expect(pins.readOnly).toContain(join(root, "süb", ".git"));
    const ws = new SandboxWorkspace(root, [], { ...fake.opts, home });
    await expect(ws.run(["sh", "-c", `printf 'gitdir: ${home}/x\\n' > süb/.git`])).rejects.toThrow(
      /SECURITY.*süb/,
    );
  });

  it("an uninitialised submodule's empty directory is held read-only; an absent one gets an empty tmpfs", async () => {
    git(root, "submodule", "deinit", "-q", "-f", "sub");
    let collected = await collectGitlinks(root, join(root, ".git"), join(root, ".git"));
    expect(collected.records.find((r) => r.path === "sub")?.state.kind).toBe("missing");
    expect(collected.pins.readOnly).toContain(join(root, "sub"));
    rmSync(join(root, "sub"), { recursive: true, force: true });
    collected = await collectGitlinks(root, join(root, ".git"), join(root, ".git"));
    expect(collected.records.find((r) => r.path === "sub")?.state.kind).toBe("absent");
    expect(collected.pins.emptyDirs).toEqual([join(root, "sub")]);
  });

  it("collects nested submodules recursively and pins every directory down to each .git", async () => {
    const mid = tmp("marina-sbx-mid-");
    gitInit(mid);
    git(mid, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "inner");
    git(mid, "commit", "-q", "-m", "mid");
    mkdirSync(join(root, "a"));
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", mid, "a/mid");
    git(
      root,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--recursive",
      "-q",
    );
    try {
      const { records, pins } = await collectGitlinks(root, join(root, ".git"), join(root, ".git"));
      expect(records.map((r) => r.path).sort()).toEqual(["a/mid", "a/mid/inner", "sub"]);
      expect(pins.dirs).toEqual(
        expect.arrayContaining([
          join(root, "a"),
          join(root, "a/mid"),
          join(root, "a/mid/inner"),
          join(root, "sub"),
        ]),
      );
      expect(pins.readOnly).toEqual(
        expect.arrayContaining([
          join(root, "sub/.git"),
          join(root, "a/mid/.git"),
          join(root, "a/mid/inner/.git"),
        ]),
      );
      // A redirected NESTED gitfile is caught too.
      const ws = new SandboxWorkspace(root, [], { ...fake.opts, home });
      await expect(
        ws.run(["sh", "-c", `printf 'gitdir: ${home}/x\\n' > a/mid/inner/.git`]),
      ).rejects.toThrow(/SECURITY.*a\/mid\/inner/);
    } finally {
      rmSync(mid, { recursive: true, force: true });
    }
  });
});

describe("program-naming git config inside the tree is pinned (no bubblewrap needed)", () => {
  let root: string;
  let home: string;
  let fake: ReturnType<typeof fakeLaunchers>;
  const layout = () => resolveSandboxLayout(root, [], { ...fake.opts, home });
  beforeEach(() => {
    root = tmp("marina-sbx-prog-");
    home = tmp("marina-sbx-home-");
    fake = fakeLaunchers();
    gitInit(root);
  });
  afterEach(() => {
    for (const d of [root, home, fake.dir]) rmSync(d, { recursive: true, force: true });
  });

  it("core.hooksPath into the tree (husky) is pinned read-only with its directory chain", () => {
    mkdirSync(join(root, "tools", "hooks"), { recursive: true });
    git(root, "config", "core.hooksPath", "tools/hooks");
    const { pins } = layout();
    expect(pins.dirs).toEqual([join(root, "tools")]);
    expect(pins.readOnly).toEqual([join(root, "tools", "hooks")]);
  });

  it("refuses an in-tree target that does not exist yet, or one reached through a symlink", () => {
    git(root, "config", "core.hooksPath", ".husky");
    expect(() => layout()).toThrow(/does not exist yet/);
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, ".husky"));
    expect(() => layout()).toThrow(/through a symlink/);
  });

  it("command values: in-tree script tokens pinned, shell syntax refused, PATH words and booleans ignored", () => {
    writeFileSync(join(root, "lint.sh"), "#!/bin/sh\n");
    git(root, "config", "hook.lint.command", "./lint.sh");
    expect(layout().pins.readOnly).toEqual([join(root, "lint.sh")]);
    git(root, "config", "--unset", "hook.lint.command");
    git(root, "config", "alias.go", "!sh -c 'cd sub && ./run.sh'");
    expect(() => layout()).toThrow(/shell syntax/);
    git(root, "config", "--unset", "alias.go");
    git(root, "config", "alias.st", "status --short ./x");
    git(root, "config", "core.fsmonitor", "true");
    git(root, "config", "credential.helper", "!/usr/bin/gh auth git-credential");
    expect(layout().pins).toEqual({ dirs: [], readOnly: [], emptyDirs: [] });
    git(root, "config", "core.fsmonitor", "./fsmon");
    expect(() => layout()).toThrow(/does not exist yet/);
  });

  it("scans every key: mergetool cmd and run-time path construction", () => {
    mkdirSync(join(root, "tools"));
    writeFileSync(join(root, "tools", "m"), "#!/bin/sh\n");
    git(root, "config", "mergetool.x.cmd", "./tools/m $LOCAL");
    // `$` in an executable section is refused outright (run-time expansion).
    expect(() => layout()).toThrow(/mergetool\.x\.cmd .*shell expansion/);
    git(root, "config", "mergetool.x.cmd", "./tools/m");
    expect(layout().pins.readOnly).toEqual([join(root, "tools", "m")]);
  });

  it("every section is executable unless the one data-only list says otherwise (hook.*.command)", () => {
    git(root, "config", "hook.lint.command", "$(git rev-parse --show-toplevel)/tools/lint.sh");
    expect(() => layout()).toThrow(/hook\.lint\.command .*shell expansion/);
    git(root, "config", "--unset", "hook.lint.command");
    git(root, "config", "newfeature.thing.run", "`pwd`/x");
    expect(() => layout()).toThrow(/newfeature\.thing\.run .*shell expansion/);
    git(root, "config", "--unset", "newfeature.thing.run");
    // Data-only sections pass through, `$` and all.
    git(root, "config", "user.name", "$HOME person");
    git(root, "config", "format.pretty", "%H $x");
    expect(layout().pins).toEqual({ dirs: [], readOnly: [], emptyDirs: [] });
  });

  it("init.templateDir and ext:: transports are not data", () => {
    // Hook templates git copies into every new repository: a missing in-tree
    // target would let sandboxed code create hooks the person's next clone installs.
    git(root, "config", "init.templateDir", join(root, "git-templates"));
    expect(() => layout()).toThrow(/init\.templatedir/i);
    git(root, "config", "--unset", "init.templateDir");
    git(root, "config", "init.defaultBranch", "main");
    expect(layout().pins).toEqual({ dirs: [], readOnly: [], emptyDirs: [] });
    git(root, "config", "remote.evil.url", "ext::sh -c id");
    expect(() => layout()).toThrow(/ext:: transport/);
  });

  it("content drivers are refused (they read files they do not name); git-lfs's own filters are allowed", () => {
    for (const [key, value] of [
      ["filter.nbs.clean", '"/usr/bin/python3" -m nbstripout_x'],
      ["filter.x.process", "some-filter-daemon"],
      ["diff.t.textconv", "cat"],
      ["diff.t.command", "sh conv.sh"],
      ["diff.external", "./tools/d"],
      ["merge.m.driver", "merge-tool %O %A %B"],
    ] as const) {
      git(root, "config", key, value);
      expect(() => layout()).toThrow(new RegExp(`${key.replace(/\./g, "\\.")} .*content driver`));
      git(root, "config", "--unset", key);
    }
    git(root, "config", "filter.lfs.clean", "git-lfs clean -- %f");
    git(root, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
    git(root, "config", "filter.lfs.process", "git-lfs filter-process");
    git(root, "config", "filter.lfs.required", "true");
    expect(layout().pins).toEqual({ dirs: [], readOnly: [], emptyDirs: [] });
    // An lfs-looking driver whose program lives in the tree is refused.
    git(root, "config", "filter.lfs.process", `${root}/bin/git-lfs filter-process`);
    expect(() => layout()).toThrow(/filter\.lfs\.process .*content driver/);
  });

  it("reports existing git hooks (pre-commit style) without refusing", () => {
    expect(layout().hooks).toEqual([]);
    writeFileSync(
      join(root, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\nexec python -mpre_commit\n",
    );
    chmodSync(join(root, ".git", "hooks", "pre-commit"), 0o755);
    writeFileSync(join(root, ".git", "hooks", "pre-push.sample"), "#!/bin/sh\n");
    chmodSync(join(root, ".git", "hooks", "pre-push.sample"), 0o755);
    git(root, "config", "hook.fmt.command", "prettier --check");
    expect(layout().hooks).toEqual(["fmt", "pre-commit"]);
  });

  it("an ordinary clone's config (remote URLs, refspecs, branch refs) pins and refuses nothing", () => {
    git(root, "config", "remote.origin.url", "https://github.com/acme/app.git");
    git(root, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git(root, "config", "remote.up.url", "git@github.com:acme/app.git");
    git(root, "config", "branch.main.remote", "origin");
    git(root, "config", "branch.main.merge", "refs/heads/main");
    git(root, "config", "safe.directory", join(root, "sub"));
    expect(layout().pins).toEqual({ dirs: [], readOnly: [], emptyDirs: [] });
  });

  it("refusals name the key and file, never the value (it can hold a credential)", () => {
    writeFileSync(
      join(home, ".gitconfig"),
      '[credential]\n\thelper = "!f(){ echo password=s3cr3t-$1; }; f"\n',
    );
    let message = "";
    try {
      layout();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/credential\.helper/);
    expect(message).toContain(join(home, ".gitconfig"));
    expect(message).not.toContain("s3cr3t");
    writeFileSync(join(home, ".gitconfig"), "");
    git(root, "config", "core.sshCommand", "./tools/topsecretname");
    expect(() => layout()).toThrow(/core\.sshcommand/i);
    try {
      layout();
    } catch (error) {
      expect((error as Error).message).not.toContain("topsecretname");
    }
  });

  it("refuses a server PATH with a relative or empty entry", () => {
    for (const PATH of ["node_modules/.bin:/usr/bin", "/usr/bin::/bin", "/usr/bin:"])
      expect(() =>
        resolveSandboxLayout(root, [], { ...fake.opts, home, env: { ...process.env, PATH } }),
      ).toThrow(/relative or empty entry/);
  });

  it("reads the person's global config too (a relative hooksPath there applies to this tree)", () => {
    mkdirSync(join(root, ".githooks"));
    writeFileSync(join(home, ".gitconfig"), "[core]\n\thooksPath = .githooks\n");
    expect(layout().pins.readOnly).toEqual([join(root, ".githooks")]);
  });

  it("module configs: a submodule's fsmonitor naming a script in its work tree is pinned", () => {
    const sub = tmp("marina-sbx-psub-");
    try {
      writeFileSync(join(sub, "fsmon.sh"), "#!/bin/sh\n");
      const pins = programConfigPins(
        [{ file: join(root, ".git", "config"), base: sub }],
        sub,
        home,
      );
      expect(pins.readOnly).toEqual([]);
      git(root, "config", "core.fsmonitor", "./fsmon.sh");
      expect(
        programConfigPins([{ file: join(root, ".git", "config"), base: sub }], sub, home).readOnly,
      ).toEqual([join(sub, "fsmon.sh")]);
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });
});

describe("effective runner with the sandbox", () => {
  const sandbox = { kind: "sandbox" as const };

  it("a stored sandbox runs in the sandbox; MARINA_CODE_SANDBOX=off makes it unavailable, never the host", () => {
    expect(effectiveRunner(sandbox, {}).kind).toBe("sandbox");
    const off = effectiveRunner(sandbox, { MARINA_CODE_SANDBOX: "off" });
    expect(off.kind).toBe("unavailable");
    expect(off.kind === "unavailable" && off.reason).toMatch(/MARINA_CODE_SANDBOX=off/);
  });

  it("an operator-required container wins over a stored sandbox and over required", () => {
    const env = { MARINA_CODE_CONTAINER_IMAGE: "docker.io/library/alpine:latest" };
    expect(effectiveRunner(sandbox, env).kind).toBe("container");
    expect(effectiveRunner(null, { ...env, MARINA_CODE_SANDBOX: "required" }).kind).toBe(
      "container",
    );
    expect(effectiveRunner(sandbox, { MARINA_CODE_CONTAINER_REQUIRED: "true" }).kind).toBe(
      "unavailable",
    );
  });

  it("MARINA_CODE_SANDBOX=default: sessions without a setting run sandboxed; a local pin stays host", () => {
    const env = { MARINA_CODE_SANDBOX: "default" };
    expect(effectiveRunner(null, env).kind).toBe("sandbox");
    expect(effectiveRunner({ kind: "local" }, env).kind).toBe("host");
    expect(effectiveRunner(null, {}).kind).toBe("host");
    expect(
      effectiveRunner(null, { ...env, MARINA_CODE_CONTAINER_IMAGE: "docker.io/library/a:1" }).kind,
    ).toBe("container");
  });

  it("MARINA_CODE_SANDBOX=required: an earlier local or container pin is unavailable, never the host", () => {
    const env = { MARINA_CODE_SANDBOX: "required" };
    expect(effectiveRunner(null, env).kind).toBe("sandbox");
    expect(effectiveRunner(sandbox, env).kind).toBe("sandbox");
    for (const pin of [
      { kind: "local" as const },
      { kind: "container" as const, config: { image: "docker.io/library/a:1" } },
    ]) {
      const runner = effectiveRunner(pin, env);
      expect(runner.kind).toBe("unavailable");
      expect(runner.kind === "unavailable" && runner.reason).toMatch(
        /MARINA_CODE_SANDBOX=required/,
      );
    }
  });

  it("applySessionRunner never returns the host workspace for a sandbox session", () => {
    const fake = fakeLaunchers();
    setSandboxDefaultsForTests(fake.opts);
    const root = tmp("marina-sbx-apply-");
    gitInit(root);
    try {
      const host = new LocalWorkspace(root);
      const session = { id: "s1", execution_target: "local" } as unknown as CodingSessionRow;
      const wrapped = applySessionRunner(host, { listCodingArtifacts: () => [] }, session, {
        MARINA_CODE_SANDBOX: "default",
      });
      expect(wrapped).toBeInstanceOf(SandboxWorkspace);
    } finally {
      setSandboxDefaultsForTests();
      rmSync(root, { recursive: true, force: true });
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });
});

describe("runner lookup survives many newer artifacts", () => {
  const DB = tempDbPath("test_code_sandbox_lookup.db");
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
  });

  it("a stored runner setting is found behind > 200 unrelated artifacts", () => {
    const session = db.createCodingSession({
      id: "code_lookup",
      title: "lookup",
      workspaceRoot: "/tmp/x",
      createdBy: "Tester",
    });
    db.createCodingArtifact({
      sessionId: session.id,
      kind: RUNNER_ARTIFACT_KIND,
      title: "Sandbox runner",
      status: "active",
      contentText: "sandbox",
      metadata: { runner: { kind: "sandbox" } },
      createdBy: "Tester",
    });
    for (let i = 0; i < 250; i++)
      db.createCodingArtifact({
        sessionId: session.id,
        kind: "command_output",
        title: `$ echo ${i}`,
        status: "complete",
        contentText: String(i),
        metadata: {},
        createdBy: "Tester",
      });
    expect(
      db.listCodingArtifacts(session.id, 200).some((a) => a.kind === RUNNER_ARTIFACT_KIND),
    ).toBe(false);
    const setting = sessionRunnerSetting(db, session.id);
    expect(setting).toEqual({ kind: "sandbox" });
    expect(effectiveRunner(setting, {}).kind).toBe("sandbox");
  });
});

describe("protected operator settings", () => {
  it("the dashboard can never write the sandbox or container policy", () => {
    for (const key of [
      "MARINA_CODE_SANDBOX",
      "MARINA_CODE_SANDBOX_BWRAP",
      "MARINA_CODE_SANDBOX_TMPFS_MB",
      "MARINA_CODE_SANDBOX_SHM_MB",
      "MARINA_CODE_SANDBOX_NPROC",
      "MARINA_CODE_SANDBOX_AS_MB",
      "MARINA_CODE_SANDBOX_FSIZE_MB",
      "MARINA_CODE_CONTAINER_REQUIRED",
      "MARINA_CODE_CONTAINER_IMAGE",
      "MARINA_CODE_CONTAINER_INIT",
      "MARINA_CODE_CONTAINER_NETWORK",
      "MARINA_CODE_CONTAINER_EGRESS",
      "MARINA_CODE_CONTAINER_MODEL_API",
    ]) {
      expect(PROTECTED_ENV_KEYS.has(key)).toBe(true);
      // The reference tags them too, so the catalog alone also refuses them.
      expect(isProtectedEnvKey(key, undefined)).toBe(true);
    }
  });
});

describe("marina --sandbox with a native agent", () => {
  it("prints a notice that the native agent keeps its own sandbox; Marina's coder gets none", () => {
    expect(sandboxNotices({ sandbox: true, agent: "codex" })[0]).toMatch(
      /native codex agent runs its commands in its own sandbox, not Marina's/,
    );
    expect(sandboxNotices({ sandbox: true })).toEqual([]);
    expect(sandboxNotices({ sandbox: true, agent: "marina" })).toEqual([]);
    expect(sandboxNotices({ agent: "claude" })).toEqual([]);
  });
});

describe("code workspace runner sandbox (command, fake launcher)", () => {
  const DB = tempDbPath("test_code_sandbox_runner.db");
  let db: MarinaDB;
  let root: string;
  let fake: ReturnType<typeof fakeLaunchers>;
  let principal: "person" | "agent";
  const savedEnv: Record<string, string | undefined> = {};
  const isPolicyKey = (key: string) =>
    key.startsWith("MARINA_CODE_CONTAINER_") || key.startsWith("MARINA_CODE_SANDBOX");
  beforeEach(() => {
    db = new MarinaDB(DB);
    root = tmp("marina-sbx-cmd-");
    gitInit(root);
    fake = fakeLaunchers();
    setSandboxDefaultsForTests(fake.opts);
    principal = "person";
    setPrincipalResolver(() => principal);
    for (const key of Object.keys(process.env)) {
      if (isPolicyKey(key)) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (isPolicyKey(key)) delete process.env[key];
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) process.env[key] = value;
      delete savedEnv[key];
    }
    setSandboxDefaultsForTests();
    setPrincipalResolver(undefined);
    db.close();
    cleanupDb(DB);
    rmSync(root, { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  });

  const setup = async (id: string, gates: string[]) => {
    const who: Entity = {
      id: id as EntityId,
      name: id,
      kind: "agent",
      room: roomId("test/start"),
      createdAt: Date.now(),
      short: id,
      long: "",
      inventory: [],
      properties: {},
    };
    db.saveEntity(who);
    for (const gate of gates) grant(db, who.id, gate);
    const command = codeCommand({
      db,
      getEntity: (eid) => (eid === who.id ? who : undefined),
      workspace: new LocalWorkspace(root),
    });
    const sent: string[] = [];
    const ctx = {
      send: (_t: EntityId, m: string) => sent.push(stripAnsi(m)),
    } as unknown as RoomContext;
    const input = (raw: string): CommandInput => {
      const args = raw.slice(raw.indexOf(" ") + 1);
      return {
        raw,
        verb: "code",
        args,
        tokens: args.split(/\s+/),
        entity: who.id,
        room: roomId("test/start"),
      };
    };
    const say = async (raw: string) => {
      sent.length = 0;
      await command.handler(ctx, input(raw));
      return sent.join("\n");
    };
    const started = await say(`code start ${id} test`);
    const sessionId = () => db.listCodingSessions(id, 1)[0]!.id;
    return { who, say, started, sessionId };
  };

  it("needs code.exec to choose it", async () => {
    const { say } = await setup("e_sbx_nogate", []);
    expect((await say("code workspace runner sandbox")).toLowerCase()).toContain(
      "run or apply code",
    );
  });

  it("stores, shows, runs any command inside, and returns to the host", async () => {
    const { say } = await setup("e_sbx", ["code.exec"]);
    expect(await say("code workspace runner sandbox")).toContain(
      "Commands now run in a local OS sandbox",
    );
    expect(await say("code workspace runner")).toContain("local OS sandbox (bubblewrap)");
    expect(await say("code run allowlist")).toContain("any command is allowed");
    expect(await say(`code run sh -c "echo a | tr a b"`)).toMatch(/^b$/m);
    expect(await say("code workspace runner local")).toContain("run on the host");
    // The host path refuses the same line (allowlist + metacharacters).
    expect(await say(`code run sh -c "echo a | tr a b"`)).not.toMatch(/^b$/m);
  });

  it("stays sandboxed behind > 200 newer artifacts, and retiring finds every runner setting", async () => {
    const { say, sessionId } = await setup("e_sbx_many", ["code.exec"]);
    await say("code workspace runner sandbox");
    for (let i = 0; i < 210; i++)
      db.createCodingArtifact({
        sessionId: sessionId(),
        kind: "note",
        title: `n${i}`,
        status: "active",
        contentText: "x",
        metadata: {},
        createdBy: "e_sbx_many",
      });
    // Still the sandbox: the host would refuse a shell line.
    expect(await say(`code run sh -c "echo a | tr a b"`)).toMatch(/^b$/m);
    await say("code workspace runner local");
    const active = db.listCodingArtifacts(sessionId(), 50, RUNNER_ARTIFACT_KIND, "active");
    expect(active.length).toBe(1);
    expect(JSON.parse(active[0]!.metadata_json ?? "{}").runner).toEqual({ kind: "local" });
  });

  it("the start line names the effective runner", async () => {
    process.env.MARINA_CODE_SANDBOX = "default";
    const { started } = await setup("e_sbx_start", ["code.exec"]);
    expect(started).toContain("Runner: local OS sandbox (bubblewrap)");
  });

  it("MARINA_CODE_SANDBOX=required: local and container are refused, nothing leaves the sandbox", async () => {
    process.env.MARINA_CODE_SANDBOX = "required";
    const { say, started } = await setup("e_sbx_req", ["code.exec", "code.exec.unrestricted"]);
    expect(started).toContain("Runner: local OS sandbox");
    expect(await say("code workspace runner local")).toContain("MARINA_CODE_SANDBOX=required");
    expect(await say("code workspace runner container image:docker.io/library/alpine:1")).toContain(
      "MARINA_CODE_SANDBOX=required",
    );
    expect(await say(`code run sh -c "echo a | tr a b"`)).toMatch(/^b$/m);
  });

  it("MARINA_CODE_SANDBOX=required: a local pin stored by an earlier launch fails, never runs on the host", async () => {
    const { say } = await setup("e_sbx_pin", ["code.exec"]);
    await say("code workspace runner local");
    process.env.MARINA_CODE_SANDBOX = "required";
    expect(await say("code run git status --short")).toMatch(/earlier `local` runner setting/);
    expect(await say("code workspace runner sandbox")).toContain(
      "Commands now run in a local OS sandbox",
    );
    expect(await say(`code run sh -c "echo ok"`)).toMatch(/^ok$/m);
  });

  it("MARINA_CODE_SANDBOX=default: an agent cannot go back to the host; a person can", async () => {
    process.env.MARINA_CODE_SANDBOX = "default";
    const { say } = await setup("e_sbx_def", ["code.exec"]);
    principal = "agent";
    expect(await say("code workspace runner local")).toContain("only a person");
    expect(await say(`code run sh -c "echo a | tr a b"`)).toMatch(/^b$/m);
    principal = "person";
    expect(await say("code workspace runner local")).toContain("run on the host");
  });

  it("a project with git hooks is named plainly in the start line and every sandboxed result", async () => {
    writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
    chmodSync(join(root, ".git", "hooks", "pre-commit"), 0o755);
    process.env.MARINA_CODE_SANDBOX = "default";
    const { say, started } = await setup("e_sbx_hooks", ["code.exec"]);
    expect(started).toContain("git hooks (pre-commit) that run work-tree code");
    expect(await say(`code run sh -c "echo ok"`)).toContain("review the changes before committing");
  });

  it("MARINA_CODE_SANDBOX=off refuses it", async () => {
    process.env.MARINA_CODE_SANDBOX = "off";
    const { say } = await setup("e_sbx_off", ["code.exec"]);
    expect(await say("code workspace runner sandbox")).toContain("MARINA_CODE_SANDBOX=off");
  });

  it("an operator-required container wins: the sandbox is refused", async () => {
    process.env.MARINA_CODE_CONTAINER_REQUIRED = "true";
    const { say } = await setup("e_sbx_reqc", ["code.exec"]);
    expect(await say("code workspace runner sandbox")).toContain("operator requires container");
  });

  it("a hold is keyed by the workspace root: any session, any runner, until a person releases it", async () => {
    const { say } = await setup("e_sbx_hold", ["code.exec"]);
    await say("code workspace runner sandbox");
    db.setCoreMemory(
      SANDBOX_HOLD_OWNER,
      realpathSync(root),
      JSON.stringify({ message: "SECURITY: test hold", paths: ["sub"], session: "x", at: 1 }),
    );
    expect(await say(`code run sh -c "echo ok"`)).toContain("SECURITY: test hold");
    // Not the host either, and not a NEW session on the same tree.
    await say("code workspace runner local");
    expect(await say("code run git status --short")).toContain("SECURITY: test hold");
    const other = await setup("e_sbx_hold2", ["code.exec"]);
    expect(other.started).toContain("held after a sandbox security check");
    expect(await other.say("code run git status --short")).toContain("SECURITY: test hold");
    principal = "agent";
    expect(await say("code workspace runner release")).toContain("only a person");
    principal = "person";
    expect(await say("code workspace runner release")).toContain("hold released");
    expect(await say("code run git status --short")).toContain("[exit 0]");
  });

  it("a detected tamper holds the root and raises an ops-inbox item; release resolves it", async () => {
    const source = tmp("marina-sbx-hsrc-");
    try {
      gitInit(source);
      git(source, "commit", "--allow-empty", "-q", "-m", "s");
      git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
      git(root, "commit", "-q", "-m", "sub");
      const { say } = await setup("e_sbx_tamper", ["code.exec"]);
      await say("code workspace runner sandbox");
      const out = await say(`code run sh -c "printf 'gitdir: /tmp/evil' > sub/.git"`);
      expect(out).toContain("SECURITY");
      const key = `${SANDBOX_HOLD_ALERT_PREFIX}${realpathSync(root)}`;
      const alert = db.listOperationalAlerts("open", 50).find((a) => a.alert_key === key);
      expect(alert?.severity).toBe("critical");
      expect(alert?.assigned_to).toBe("e_sbx_tamper");
      expect(db.getCoreMemory(SANDBOX_HOLD_OWNER, realpathSync(root))).toBeDefined();
      writeFileSync(join(root, "sub", ".git"), "gitdir: ../.git/modules/sub\n");
      expect(await say("code workspace runner release")).toContain("hold released");
      expect(db.listOperationalAlerts("open", 50).some((a) => a.alert_key === key)).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!BWRAP || !VAR_TMP)("SandboxWorkspace (real bubblewrap)", () => {
  let root: string;
  let fakeSystem: string;
  let ws: SandboxWorkspace;
  const saved = process.env.ANTHROPIC_API_KEY;
  const systemPaths = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];
  beforeEach(() => {
    root = tmp("marina-sbx-run-");
    gitInit(root);
    // A stand-in system directory that holds a fake HOME: bound read-only like
    // /usr, so only the home tmpfs keeps the planted secret out of reach.
    fakeSystem = realpathSync(mkdtempSync("/var/tmp/marina-sbx-sys-"));
    mkdirSync(join(fakeSystem, "home"));
    writeFileSync(join(fakeSystem, "home", "secret.txt"), "TOPSECRET\n");
    mkdirSync(join(fakeSystem, "share"));
    writeFileSync(join(fakeSystem, "share", "visible.txt"), "visible\n");
    ws = new SandboxWorkspace(root, [], {
      home: join(fakeSystem, "home"),
      systemPaths: [...systemPaths, fakeSystem],
    });
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-reach-the-sandbox";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeSystem, { recursive: true, force: true });
  });

  it("runs a shell pipeline (sh -c) and any command, no allowlist", async () => {
    const piped = await ws.run(["sh", "-c", "echo a | tr a b"]);
    expect(piped.exitCode).toBe(0);
    expect(piped.output.trim()).toBe("b");
    const sed = await ws.run(["sh", "-c", "printf 'x\\ny\\n' > f.txt && sed -n 2p f.txt"]);
    expect(sed.output.trim()).toBe("y");
  });

  it("writes in the workspace (visible on the host); cannot write outside it", async () => {
    const ok = await ws.run(["sh", "-c", "echo hi > made.txt"]);
    expect(ok.exitCode).toBe(0);
    expect(existsSync(join(root, "made.txt"))).toBe(true);
    const out = await ws.run(["sh", "-c", `echo x > ${fakeSystem}/share/planted.txt`]);
    expect(out.exitCode).not.toBe(0);
    expect(existsSync(join(fakeSystem, "share", "planted.txt"))).toBe(false);
    expect((await ws.run(["sh", "-c", "echo x > /usr/marina-planted"])).exitCode).not.toBe(0);
    const marker = `marina-sbx-${crypto.randomUUID()}`;
    await ws.run(["sh", "-c", `echo x > /tmp/${marker}`]);
    expect(existsSync(join("/tmp", marker))).toBe(false);
  });

  it("cannot read a file in the masked home, though the dir around it is bound", async () => {
    const visible = await ws.run(["cat", `${fakeSystem}/share/visible.txt`]);
    expect(visible.output.trim()).toBe("visible");
    const secret = await ws.run(["cat", `${fakeSystem}/home/secret.txt`]);
    expect(secret.exitCode).not.toBe(0);
    expect(secret.output).not.toContain("TOPSECRET");
  });

  it("hides the real home except the Bun executable, and bun test runs", async () => {
    const real = new SandboxWorkspace(root, [], { systemPaths });
    const home = realpathSync(homedir());
    const listed = await real.run(["sh", "-c", `ls -A ${home} || true`]);
    const bun = realpathSync(process.execPath);
    const allowed = new Set(
      [bun, root]
        .map((p) => relative(home, p).split("/")[0])
        .filter((part): part is string => !!part && !part.startsWith("..")),
    );
    for (const entry of listed.output.split("\n").filter(Boolean))
      expect(allowed.has(entry)).toBe(true);
    if (bun.startsWith(`${home}/`)) {
      // Only Bun itself: the executable alone, or its directory when that holds
      // nothing but bun/bunx (a fresh setup-bun install). Nothing else is visible.
      const siblings = await real.run(["sh", "-c", `ls -A ${join(bun, "..")}`]);
      const seen = siblings.output.split("\n").filter(Boolean).sort();
      expect([["bun"], ["bun", "bunx"]]).toContainEqual(seen);
    }
    writeFileSync(
      join(root, "x.test.ts"),
      'import { expect, it } from "bun:test";\nit("adds", () => expect(6 * 7).toBe(42));\n',
    );
    const tested = await real.run(["bun", "test", "./x.test.ts"], 60_000);
    expect(tested.exitCode).toBe(0);
    expect(tested.output).toContain("1 pass");
  });

  it("cannot write the repository's .git (no planted hooks)", async () => {
    const hook = await ws.run([
      "sh",
      "-c",
      "echo 'echo pwned' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit",
    ]);
    expect(hook.exitCode).not.toBe(0);
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
    expect((await ws.run(["git", "config", "core.fsmonitor", "evil"])).exitCode).not.toBe(0);
  });

  it("has no network", async () => {
    const result = await ws.run(
      [
        "bun",
        "-e",
        "Bun.connect({hostname:'1.1.1.1',port:443,socket:{data(){},open(s){console.log('CONNECTED');s.end();process.exit(0)}}}).catch(e=>{console.log('NONET',e.code??e.message);process.exit(3)})",
      ],
      20_000,
    );
    expect(result.output).not.toContain("CONNECTED");
    expect(result.exitCode).not.toBe(0);
  });

  it("gets none of the server's environment (API keys, MARINA_*)", async () => {
    const result = await ws.run(["env"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("sk-ant-should-never-reach-the-sandbox");
    expect(result.output).not.toMatch(/^(ANTHROPIC|OPENAI|MARINA)_/m);
    expect(result.output).toContain(`HOME=${SANDBOX_HOME}`);
  });

  it("no nested user namespaces; prlimit caps apply; tmpfs is size-capped", async () => {
    expect((await ws.run(["unshare", "-U", "true"])).exitCode).not.toBe(0);
    // Read the soft limits from the kernel: `ulimit -u` is not POSIX (dash lacks it).
    const limits = await ws.run([
      "sh",
      "-c",
      "awk '/^Max processes|^Max core file size/ {print $(NF-2)}' /proc/self/limits",
    ]);
    expect(limits.output.trim().split("\n")).toEqual(["0", "4096"]);
    const small = new SandboxWorkspace(root, [], {
      home: join(fakeSystem, "home"),
      systemPaths: [...systemPaths, fakeSystem],
      env: { ...process.env, MARINA_CODE_SANDBOX_TMPFS_MB: "1" },
    });
    const fill = await small.run([
      "sh",
      "-c",
      "dd if=/dev/zero of=/tmp/fill bs=1024 count=4096 2>&1; echo rc=$?",
    ]);
    expect(fill.output).toMatch(/No space left on device/);
  });

  it("a timeout kills the sandboxed process", async () => {
    const tag = `31.${Math.floor(Math.random() * 1e6)}`;
    const started = Date.now();
    const result = await ws.run(["sh", "-c", `sleep ${tag}`], 300);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    await until(() => Bun.spawnSync(["pgrep", "-f", `sleep ${tag}`]).exitCode !== 0, {
      timeoutMs: 5000,
      message: "the sandboxed sleep outlived its timeout",
    });
  });
});

describe.skipIf(!BWRAP)("pins under real bubblewrap", () => {
  let base: string;
  beforeEach(() => {
    base = tmp("marina-sbx-pinreal-");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("nested submodules and husky hooks cannot be moved or rewritten; /dev is read-only, /dev/shm capped", async () => {
    const inner = join(base, "inner");
    mkdirSync(inner);
    gitInit(inner);
    git(inner, "commit", "--allow-empty", "-q", "-m", "i");
    const mid = join(base, "mid");
    mkdirSync(mid);
    gitInit(mid);
    git(mid, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "inner");
    git(mid, "commit", "-q", "-m", "m");
    const root = join(base, "root");
    mkdirSync(root);
    gitInit(root);
    mkdirSync(join(root, "a"));
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", mid, "a/mid");
    git(root, "commit", "-q", "-m", "r");
    git(
      root,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--recursive",
      "-q",
    );
    mkdirSync(join(root, ".husky"));
    writeFileSync(join(root, ".husky", "pre-commit"), "#!/bin/sh\n");
    git(root, "config", "core.hooksPath", ".husky");
    const ws = new SandboxWorkspace(root, [], { serverState: [] });
    const run = async (line: string) => (await ws.run(["sh", "-c", line])).output;
    expect(await run("mv a a2")).toContain("Device or resource busy");
    expect(await run("mv a/mid a/m2")).toContain("Device or resource busy");
    expect(await run("mv a/mid/inner a/mid/i2")).toContain("Device or resource busy");
    expect(await run("echo x > a/mid/.git")).toContain("Read-only file system");
    expect(await run("echo x > a/mid/inner/.git")).toContain("Read-only file system");
    expect(await run("rm -rf a/mid/.git; mkdir a/mid/.git")).toMatch(/busy|Read-only/);
    expect(await run("echo hi > a/mid/newfile && echo wrote")).toContain("wrote");
    expect(await run("echo x > .husky/pre-commit")).toContain("Read-only file system");
    expect(await run("mv .husky h2")).toContain("Device or resource busy");
    expect(await run("touch /dev/x")).toContain("Read-only file system");
    expect(await run("echo ok > /dev/null && echo devnull-ok")).toContain("devnull-ok");
    expect(await run("df -m /dev/shm | tail -1")).toMatch(/\s64\s/);
    // Builds two nested submodules and runs many sandboxed commands: slower under load.
  }, 30_000);
});

describe.skipIf(!BWRAP)("uninitialised and non-ASCII submodules under real bubblewrap", () => {
  let base: string;
  beforeEach(() => {
    base = tmp("marina-sbx-subreal-");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("no .git can be planted at a deinit-ed, an absent or a non-ASCII gitlink path", async () => {
    const source = join(base, "src");
    mkdirSync(source);
    gitInit(source);
    git(source, "commit", "--allow-empty", "-q", "-m", "s");
    const root = join(base, "root");
    mkdirSync(root);
    gitInit(root);
    for (const path of ["süb", "gone", "off"])
      git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, path);
    git(root, "commit", "-q", "-m", "subs");
    git(root, "submodule", "deinit", "-q", "-f", "off");
    git(root, "submodule", "deinit", "-q", "-f", "gone");
    rmSync(join(root, "gone"), { recursive: true, force: true });
    const ws = new SandboxWorkspace(root, [], { serverState: [] });
    const run = async (line: string) => (await ws.run(["sh", "-c", line])).output;
    expect(await run("echo x > süb/.git")).toContain("Read-only file system");
    expect(await run("echo 'gitdir: ../evil' > off/.git")).toContain("Read-only file system");
    expect(await run("echo 'gitdir: ../evil' > gone/.git")).toContain("Read-only file system");
    expect(await run("echo fine")).toContain("fine");
  });
});

describe("verification checks follow the runner (delivery)", () => {
  let f: ReturnType<typeof createTestEngine>;
  let root: string;
  let fake: ReturnType<typeof fakeLaunchers>;
  let state: DisposableStack;
  const setupDelivery = async (sandbox: boolean) => {
    state = scopeProcessState({
      trustProfile: "shared",
      rateLimitBypass: true,
      env: {
        MARINA_AUTONOMY: "guarded",
        MARINA_CHALLENGES: "off",
        MARINA_CODE_SANDBOX: sandbox ? "required" : "off",
      },
    });
    fake = fakeLaunchers();
    setSandboxDefaultsForTests(fake.opts);
    root = tmp("marina-sbx-delivery-");
    gitInit(root);
    writeFileSync(join(root, "out.txt"), "a\n");
    writeFileSync(
      join(root, "delivery.json"),
      JSON.stringify({
        files: ["out.txt"],
        checks: ['sh -c "cat out.txt | tr a b | grep -qx b"'],
        requirements: [{ text: "out.txt holds a, which tr turns into b", checks: [0] }],
      }),
    );
    f = createTestEngine();
    const owner = f.login("Owner");
    const actor = f.engine.entities.get(owner.entityId)!;
    grant(f.db, owner.entityId, "code.exec");
    f.db.createCodingSession({
      id: "delivery",
      title: "Delivery",
      workspaceRoot: root,
      createdBy: actor.name,
    });
    f.db.updateCodingSession("delivery", { agent: actor.name, writer: actor.name });
    f.engine.commands.registerBuiltin(
      codeCommand({
        db: f.db,
        workspaceRegistry: new WorkspaceRegistry({ roots: [root] }),
        verificationRunner: new VerificationRunner(f.db, (pending) =>
          f.engine.trackBackgroundCommand(pending),
        ),
        getEntity: (id) => f.engine.entities.get(id as EntityId),
        getConnectionProtocol: () => "websocket",
      }),
    );
    const run = beginCodingRun(f.db, {
      session: f.db.getCodingSession("delivery")!,
      owner: actor,
      worker: actor,
      prompt: "Deliver out.txt",
      profile: "marina",
      verificationRequirement: "delivery",
    });
    await f.engine.dispatchCommand(owner.entityId, "code verify delivery manifest:delivery.json", {
      codingTarget: { sessionId: "delivery", runId: run.id },
    });
    await f.engine.drainCommands();
    return {
      checks: f.db.listCodingRunArtifacts(run.id, ["verification"]),
      text: owner.connection.allTextJoined(),
    };
  };
  afterEach(async () => {
    await f.dispose();
    setSandboxDefaultsForTests();
    state.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  });

  it("a shell-pipeline check passes under the sandbox runner", async () => {
    const { checks, text } = await setupDelivery(true);
    expect(checks[0]?.status, text).toBe("complete");
  });

  it("the same check is refused on the host runner (allowlist)", async () => {
    const { checks, text } = await setupDelivery(false);
    expect(checks.some((c) => c.status === "complete")).toBe(false);
    expect(text).toMatch(/metacharacters|not allowed|allowed command/i);
  });
});
