// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContainerWorkspace,
  captureRuntimeEnv,
  containerRunArgv,
  containerStorageLocation,
  gitMetadataPaths,
  mountFsType,
  resolveContainerRunner,
  storageWarning,
  UnavailableContainerWorkspace,
} from "../src/coding/container-workspace";
import {
  HostExecForbiddenError,
  LocalWorkspace,
  normalizeAllowedCodeCommand,
} from "../src/coding/local-workspace";
import {
  detectProjectRunner,
  detectWorkspaceRunner,
  diffTouchedPaths,
  touchedLanguage,
} from "../src/coding/project-detection";
import { codeCommand } from "../src/engine/commands/code";
import {
  applySessionRunner,
  effectiveRunner,
  envRunnerConfig,
  operatorContainerPolicy,
} from "../src/engine/commands/code/runner";
import { grant } from "../src/engine/safety-gates";
import { type CodingSessionRow, MarinaDB } from "../src/persistence/database";
import {
  type CommandInput,
  type Entity,
  type EntityId,
  type RoomContext,
  roomId,
} from "../src/types";
import { git, gitInit } from "./git-helpers";
import { cleanupDb, stripAnsi } from "./helpers";

const markers = (...names: string[]) => new Set(names);

describe("test-runner detection", () => {
  it("prefers the touched files' language over a tooling package.json", () => {
    const profile = detectProjectRunner({
      markers: markers("package.json", "setup.py", "tests/runtests.py"),
      packageJson: JSON.stringify({ scripts: { test: "grunt test", lint: "eslint" } }),
      touched: ["django/db/models/query.py", "docs/releases/4.2.txt"],
    });
    expect(profile.language).toBe("python");
    expect(profile.verify).toEqual(["python tests/runtests.py"]);
    expect(profile.reason).toContain("touched python");
  });

  it("picks manage.py for a Django project and pytest for other Python projects", () => {
    expect(detectProjectRunner({ markers: markers("manage.py") }).verify).toEqual([
      "python manage.py test",
    ]);
    expect(detectProjectRunner({ markers: markers("pyproject.toml") }).verify).toEqual([
      "python -m pytest",
    ]);
  });

  it("detects Rust and Go projects, and keeps JavaScript scripts for JS changes", () => {
    expect(detectProjectRunner({ markers: markers("Cargo.toml") }).verify).toEqual(["cargo test"]);
    expect(detectProjectRunner({ markers: markers("go.mod") }).verify).toEqual(["go test ./..."]);
    const js = detectProjectRunner({
      markers: markers("package.json", "pyproject.toml"),
      packageJson: JSON.stringify({ scripts: { typecheck: "tsc", test: "bun test" } }),
      touched: ["src/a.ts", "src/b.tsx"],
    });
    expect(js.language).toBe("javascript");
    expect(js.verify).toEqual(["typecheck", "test"]);
  });

  it("falls back to markers when touched files name no runnable language", () => {
    const profile = detectProjectRunner({
      markers: markers("pyproject.toml"),
      touched: ["README.md"],
    });
    expect(profile.verify).toEqual(["python -m pytest"]);
    expect(detectProjectRunner({ markers: markers() }).language).toBe("unknown");
  });

  it("reads touched paths from diff headers and votes on language", () => {
    const diff =
      "diff --git a/x/y.py b/x/y.py\n+1\ndiff --git a/z.ts b/z.ts\ndiff --git a/w.py b/w.py\n";
    expect(diffTouchedPaths(diff)).toEqual(["x/y.py", "z.ts", "w.py"]);
    expect(touchedLanguage(diffTouchedPaths(diff))).toBe("python");
  });

  it("detects a workspace from its files without a git repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "marina-detect-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
      writeFileSync(join(root, "pyproject.toml"), "[project]\nname='x'\n");
      const profile = await detectWorkspaceRunner(new LocalWorkspace(root));
      // No changes to vote with: the first present language by marker order wins.
      expect(profile.language).toBe("python");
      expect(profile.verify).toEqual(["python -m pytest"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("test-runner allowlist shapes", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "marina-allow-")));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "tests", "runtests.py"), "");
    writeFileSync(join(root, "manage.py"), "");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("accepts the detected runners with relative selectors and inert flags", () => {
    expect(
      normalizeAllowedCodeCommand(root, [
        "python",
        "-m",
        "pytest",
        "tests/test_a.py::TestA::test_b[case-1]",
        "-q",
      ]),
    ).toEqual(["python", "-m", "pytest", "tests/test_a.py::TestA::test_b[case-1]", "-q"]);
    expect(normalizeAllowedCodeCommand(root, ["python", "tests/runtests.py", "queries"])).toEqual([
      "python",
      "tests/runtests.py",
      "queries",
    ]);
    expect(
      normalizeAllowedCodeCommand(root, ["python3", "manage.py", "test", "app.tests"]),
    ).toEqual(["python3", "manage.py", "test", "app.tests"]);
    expect(normalizeAllowedCodeCommand(root, ["cargo", "test", "parser::tests"])).toEqual([
      "cargo",
      "test",
      "parser::tests",
    ]);
    expect(normalizeAllowedCodeCommand(root, ["go", "test", "./...", "-count=1"])).toEqual([
      "go",
      "test",
      "./...",
      "-count=1",
    ]);
  });

  it("refuses arbitrary interpreters, scripts, flags and escapes", () => {
    const refuse = (argv: string[]) =>
      expect(() => normalizeAllowedCodeCommand(root, argv)).toThrow();
    refuse(["python", "-c", "import os"]);
    refuse(["python", "setup.py", "install"]);
    refuse(["python", "-m", "pip", "install", "x"]);
    refuse(["python", "-m", "pytest", "/etc/passwd"]);
    refuse(["python", "-m", "pytest", "../outside.py"]);
    refuse(["python", "-m", "pytest", "--rootdir=/"]);
    refuse(["python", "tests/runtests.py", "--settings=evil"]);
    refuse(["pytest", "tests"]);
    refuse(["cargo", "run"]);
    refuse(["cargo", "test", "--", "--nocapture"]);
    refuse(["go", "test", "-exec", "sh"]);
    refuse(["go", "run", "./..."]);
  });
});

const IMAGE = "docker.io/library/alpine:latest";
const fakeWhich = (present: string[]) => (binary: string) =>
  present.includes(binary) ? `/usr/bin/${binary}` : null;

describe("container runner configuration", () => {
  it("validates the image, workdir and runtime and never guesses a host fallback", () => {
    const ok = resolveContainerRunner({ image: IMAGE }, {}, fakeWhich(["podman"]));
    expect(ok).toMatchObject({
      runtime: "podman",
      sync: "mount",
      workdir: "/work",
      network: false,
    });
    expect(() =>
      resolveContainerRunner({ image: "-v /:/host" }, {}, fakeWhich(["podman"])),
    ).toThrow(/image/);
    expect(() =>
      resolveContainerRunner({ image: IMAGE, workdir: "rel" }, {}, fakeWhich(["podman"])),
    ).toThrow(/workdir/);
    expect(() => resolveContainerRunner({ image: IMAGE }, {}, fakeWhich([]))).toThrow(
      /never fall back/,
    );
    expect(() =>
      resolveContainerRunner({ image: IMAGE, init: "a\nb" }, {}, fakeWhich(["docker"])),
    ).toThrow(/single line/);
    const docker = resolveContainerRunner(
      { image: IMAGE },
      { MARINA_CODE_CONTAINER_RUNTIME: "docker" },
      fakeWhich(["docker", "podman"]),
    );
    expect(docker.runtime).toBe("docker");
  });

  it("clamps resource limits", () => {
    const runner = resolveContainerRunner(
      { image: IMAGE, cpus: 999, memoryMb: 1, timeoutMs: 10 ** 9 },
      {},
      fakeWhich(["podman"]),
    );
    expect(runner.cpus).toBe(16);
    expect(runner.memoryMb).toBe(256);
    expect(runner.timeoutMs).toBe(1_800_000);
  });

  it("mount sync: no network, dropped capabilities, read-only rootfs, worktree as the only mount", () => {
    const runner = resolveContainerRunner({ image: IMAGE }, {}, fakeWhich(["podman"]));
    const argv = containerRunArgv(runner, "/repo", ["python", "-m", "pytest"], "marina-run-x");
    expect(argv.slice(0, 3)).toEqual(["podman", "run", "--rm"]);
    expect(argv).toContain("--cap-drop=ALL");
    expect(argv[argv.indexOf("--network") + 1]).toBe("none");
    expect(argv[argv.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(argv).toContain("--read-only");
    expect(argv).toContain("--userns=keep-id");
    // The worktree read-write, with its git metadata bound read-only on top.
    const mounts = argv.flatMap((a, i) => (a === "-v" ? [argv[i + 1]] : []));
    expect(mounts).toEqual(["/repo:/work:rw", "/repo/.git:/work/.git:ro"]);
    // The validated command is passed as argv after the image, never through a shell.
    expect(argv.slice(argv.indexOf(IMAGE) + 1)).toEqual(["python", "-m", "pytest"]);
  });

  it("docker runs as the host uid/gid; network is opt-in", () => {
    const runner = resolveContainerRunner(
      { image: IMAGE, runtime: "docker", network: true },
      {},
      fakeWhich(["docker"]),
    );
    const argv = containerRunArgv(runner, "/repo", ["go", "test", "./..."], "n", {
      uid: 1234,
      gid: 99,
    });
    expect(argv[argv.indexOf("--user") + 1]).toBe("1234:99");
    expect(argv[argv.indexOf("--network") + 1]).toBe("bridge");
  });

  it("patch sync mounts nothing from the host and applies the diff before the argv", () => {
    const runner = resolveContainerRunner(
      {
        image: IMAGE,
        sync: "patch",
        workdir: "/testbed",
        shell: "bash",
        init: "source /opt/conda/bin/activate testbed",
      },
      {},
      fakeWhich(["podman"]),
    );
    const argv = containerRunArgv(runner, "/repo", ["python", "-m", "pytest", "a b"], "n", {
      applyPatch: true,
    });
    expect(argv).not.toContain("-v");
    expect(argv).not.toContain("--read-only");
    expect(argv).toContain("-i");
    const tail = argv.slice(argv.indexOf(IMAGE) + 1);
    expect(tail[0]).toBe("bash");
    expect(tail[1]).toBe("-c");
    expect(tail[2]).toContain("source /opt/conda/bin/activate testbed");
    expect(tail[2]).toContain("git apply");
    expect(tail[2]).toContain('exec "$@"');
    // argv survives intact (including a space inside one argument).
    expect(tail.slice(3)).toEqual(["marina-run", "python", "-m", "pytest", "a b"]);
  });
});

describe("container runtime storage (operator environment)", () => {
  it("captures only the runtime-CLI variables from an environment", () => {
    const captured = captureRuntimeEnv({
      HOME: "/home/op",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DOCKER_HOST: "unix:///run/docker.sock",
      OPENROUTER_API_KEY: "secret",
      PATH: "/usr/bin",
      CONTAINERS_STORAGE_CONF: "",
    });
    expect(captured).toEqual({
      HOME: "/home/op",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DOCKER_HOST: "unix:///run/docker.sock",
    });
  });

  it("an operator storage override becomes podman global flags before `run`", () => {
    const runner = resolveContainerRunner(
      { image: IMAGE },
      { MARINA_CODE_CONTAINER_STORAGE: "/srv/containers", MARINA_CODE_CONTAINER_RUNROOT: "/run/c" },
      fakeWhich(["podman"]),
    );
    expect(runner).toMatchObject({ storageRoot: "/srv/containers", runRoot: "/run/c" });
    const argv = containerRunArgv(runner, "/repo", ["go", "test", "./..."], "n");
    expect(argv.slice(0, 6)).toEqual([
      "podman",
      "--root",
      "/srv/containers",
      "--runroot",
      "/run/c",
      "run",
    ]);
    expect(() =>
      resolveContainerRunner(
        { image: IMAGE },
        { MARINA_CODE_CONTAINER_STORAGE: "relative/store" },
        fakeWhich(["podman"]),
      ),
    ).toThrow(/absolute path/);
    expect(() =>
      resolveContainerRunner(
        { image: IMAGE, runtime: "docker" },
        { MARINA_CODE_CONTAINER_STORAGE: "/srv/containers" },
        fakeWhich(["docker"]),
      ),
    ).toThrow(/podman/);
  });

  it("locates the store from the operator env and warns when it would land in memory or /tmp", () => {
    const podman = { runtime: "podman" as const };
    expect(containerStorageLocation(podman, { HOME: "/home/op" }, 1000)).toBe(
      "/home/op/.local/share/containers/storage",
    );
    expect(
      containerStorageLocation(podman, { HOME: "/home/op", XDG_DATA_HOME: "/data" }, 1000),
    ).toBe("/data/containers/storage");
    expect(containerStorageLocation(podman, {}, 0)).toBe("/var/lib/containers/storage");
    expect(containerStorageLocation({ ...podman, storageRoot: "/srv/c" }, {}, 1000)).toBe("/srv/c");
    expect(containerStorageLocation({ runtime: "docker" }, { HOME: "/home/op" }, 1000)).toBeNull();

    const mounts = [
      "/dev/nvme0n1p2 / ext4 rw 0 0",
      "/dev/nvme0n1p3 /home btrfs rw 0 0",
      "tmpfs /tmp tmpfs rw 0 0",
      "tmpfs /home/op/ram tmpfs rw 0 0",
    ].join("\n");
    expect(mountFsType("/home/op/.local/share/containers/storage", mounts)).toBe("btrfs");
    expect(mountFsType("/tmp/marina-code-home/.local", mounts)).toBe("tmpfs");
    expect(storageWarning("/home/op/.local/share/containers/storage", mounts)).toBeNull();
    expect(storageWarning("/home/op/ram/containers", mounts)).toMatch(/tmpfs.*memory/);
    expect(storageWarning("/tmp/marina-code-home/.local/share/containers/storage", mounts)).toMatch(
      /tmpfs/,
    );
    expect(storageWarning(null, mounts)).toBeNull();
  });

  it("the runtime CLI gets the operator's storage env; the container's env stays isolated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marina-fake-rt-env-"));
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "marina-cw-env-")));
    gitInit(repo); // mount sync binds the repository's .git read-only
    const script = join(dir, "podman");
    writeFileSync(
      script,
      '#!/bin/sh\necho "RT_HOME:$HOME"\necho "RT_XDG:$XDG_RUNTIME_DIR"\necho "RT_KEY:[$OPENROUTER_API_KEY]"\nfor a in "$@"; do echo "ARG:$a"; done\n',
    );
    chmodSync(script, 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${dir}:${savedPath}`;
    try {
      const ws = new ContainerWorkspace(
        repo,
        resolveContainerRunner({ image: IMAGE, runtime: "podman" }),
        { HOME: "/home/op", XDG_RUNTIME_DIR: "/run/user/4242" },
      );
      const result = await ws.run(["git", "status", "--short"]);
      expect(result.exitCode).toBe(0);
      // The runtime CLI resolves the operator's store, not the scratch HOME host commands get.
      expect(result.output).toContain("RT_HOME:/home/op");
      expect(result.output).not.toContain("marina-code-home");
      expect(result.output).toContain("RT_XDG:/run/user/4242");
      // Secrets in the server env never reach the runtime CLI.
      expect(result.output).toContain("RT_KEY:[]");
      // Inside the container: only the explicit, fixed values; no host env passthrough.
      expect(result.output).toContain("ARG:HOME=/tmp");
      expect(result.output).not.toContain("ARG:HOME=/home/op");
      expect(result.output).not.toContain("ARG:--env-host");
      expect(ws.storageLocation()).toBe("/home/op/.local/share/containers/storage");
    } finally {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/** A stand-in runtime that records its argv and stdin, so no real container is needed. */
function fakeRuntimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "marina-fake-rt-"));
  const script = join(dir, "podman");
  writeFileSync(
    script,
    '#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\nif [ ! -t 0 ]; then echo "STDIN:$(cat | head -c 200 | tr "\\n" "|")"; fi\n',
  );
  chmodSync(script, 0o755);
  return dir;
}

describe("ContainerWorkspace execution (fake runtime)", () => {
  let root: string;
  let rtDir: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "marina-cw-")));
    rtDir = fakeRuntimeDir();
    savedPath = process.env.PATH;
    process.env.PATH = `${rtDir}:${savedPath}`;
    gitInit(root);
    writeFileSync(join(root, "a.py"), "x = 1\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(rtDir, { recursive: true, force: true });
  });

  it("runs an allowlisted command through the runtime with the hardened flags", async () => {
    const ws = new ContainerWorkspace(
      root,
      resolveContainerRunner({ image: IMAGE, runtime: "podman" }),
    );
    const result = await ws.run(["git", "status", "--short"]);
    expect(result.exitCode).toBe(0);
    expect(result.command).toEqual(["git", "status", "--short"]);
    expect(result.output).toContain("ARG:run");
    expect(result.output).toContain("ARG:--cap-drop=ALL");
    expect(result.output).toContain("ARG:none");
    expect(result.output).toContain(`ARG:${root}:/work:rw`);
    expect(result.output).toContain(`ARG:${root}/.git:/work/.git:ro`);
    expect(ws.describe().runner).toMatchObject({ kind: "container", image: IMAGE, sync: "mount" });
  });

  it("mount sync refuses a root without its own .git (the container could plant one)", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "marina-cw-nogit-")));
    try {
      const ws = new ContainerWorkspace(
        bare,
        resolveContainerRunner({ image: IMAGE, runtime: "podman" }),
      );
      await expect(ws.run(["git", "status", "--short"])).rejects.toThrow(/git repository root/);
      symlinkSync(join(root, ".git"), join(bare, ".git"));
      await expect(ws.run(["git", "status", "--short"])).rejects.toThrow(/symlinked/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("binds a worktree's .git file, and a gitdir inside the worktree, read-only", () => {
    expect(gitMetadataPaths(root)).toEqual([".git"]);
    const wt = realpathSync(mkdtempSync(join(tmpdir(), "marina-cw-wt-")));
    try {
      // A linked worktree: .git is a file pointing outside the worktree.
      writeFileSync(join(wt, ".git"), `gitdir: ${root}/.git/worktrees/x\n`);
      expect(gitMetadataPaths(wt)).toEqual([".git"]);
      // A gitdir redirected inside the worktree must be read-only as well.
      mkdirSync(join(wt, "meta"));
      writeFileSync(join(wt, "meta", "commondir"), "../common\n");
      writeFileSync(join(wt, ".git"), "gitdir: meta\n");
      expect(gitMetadataPaths(wt)).toEqual([".git", "meta", "common"]);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("keeps the allowlist: an off-list command never reaches the runtime", async () => {
    const ws = new ContainerWorkspace(
      root,
      resolveContainerRunner({ image: IMAGE, runtime: "podman" }),
    );
    await expect(ws.run(["python", "-c", "print(1)"])).rejects.toThrow(/not allowed/i);
  });

  it("patch sync feeds tracked and untracked changes on stdin", async () => {
    writeFileSync(join(root, "a.py"), "x = 2\n");
    writeFileSync(join(root, "new_test.py"), "def test(): pass\n");
    const ws = new ContainerWorkspace(
      root,
      resolveContainerRunner({
        image: IMAGE,
        runtime: "podman",
        sync: "patch",
        workdir: "/testbed",
      }),
    );
    const diff = await ws.pendingDiff();
    expect(diff).toContain("a/a.py");
    expect(diff).toContain("new_test.py");
    const result = await ws.run(["git", "status", "--short"]);
    expect(result.output).toContain("ARG:-i");
    expect(result.output).toContain("STDIN:diff --git");
    expect(result.output).not.toContain(`ARG:${root}:`);
  });

  it("refuses to spawn for a telnet-origin caller", async () => {
    const ws = new ContainerWorkspace(
      root,
      resolveContainerRunner({ image: IMAGE, runtime: "podman" }),
    );
    ws.setHostExecForbidden(true);
    await expect(ws.run(["git", "status", "--short"])).rejects.toBeInstanceOf(
      HostExecForbiddenError,
    );
  });

  it("an unresolvable runner fails every command and never runs it on the host", async () => {
    const ws = new UnavailableContainerWorkspace(root, new Error("No container runtime found"));
    await expect(ws.run(["git", "status", "--short"])).rejects.toThrow(/unavailable/);
    // File operations still work.
    expect((await ws.read("a.py")).content).toContain("x = 1");
  });
});

describe("code workspace runner (command)", () => {
  const DB = "test_code_container_runner.db";
  let db: MarinaDB;
  let root: string;
  let rtDir: string;
  let savedPath: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    db = new MarinaDB(DB);
    root = realpathSync(mkdtempSync(join(tmpdir(), "marina-runner-cmd-")));
    gitInit(root);
    rtDir = fakeRuntimeDir();
    savedPath = process.env.PATH;
    process.env.PATH = `${rtDir}:${savedPath}`;
    // Start from no operator container policy, whatever the developer's env holds.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MARINA_CODE_CONTAINER_")) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (key.startsWith("MARINA_CODE_CONTAINER_")) delete process.env[key];
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) process.env[key] = value;
      delete savedEnv[key];
    }
    process.env.PATH = savedPath;
    db.close();
    cleanupDb(DB);
    rmSync(root, { recursive: true, force: true });
    rmSync(rtDir, { recursive: true, force: true });
  });

  const entity = (id: string, name: string): Entity => ({
    id: id as EntityId,
    name,
    kind: "agent",
    room: roomId("test/start"),
    createdAt: Date.now(),
    short: name,
    long: "",
    inventory: [],
    properties: {},
  });
  const input = (who: Entity, raw: string): CommandInput => {
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
  const ctxFor = (sent: string[]) =>
    ({ send: (_t: EntityId, m: string) => sent.push(stripAnsi(m)) }) as unknown as RoomContext;

  it("sets a container runner, routes runs into it, and returns to the host", async () => {
    const who = entity("e_runner", "Runner");
    db.saveEntity(who);
    grant(db, who.id, "code.exec");
    // A session-chosen image (no operator image) needs the override gate.
    grant(db, who.id, "code.exec.unrestricted");
    const command = codeCommand({
      db,
      getEntity: (id) => (id === who.id ? who : undefined),
      workspace: new LocalWorkspace(root),
    });
    const sent: string[] = [];
    const ctx = ctxFor(sent);
    await command.handler(ctx, input(who, "code start Runner test"));
    sent.length = 0;
    await command.handler(
      ctx,
      input(who, `code workspace runner container image:${IMAGE} runtime:podman`),
    );
    expect(sent.join("\n")).toContain("Commands now run in");
    sent.length = 0;
    await command.handler(ctx, input(who, "code run git status --short"));
    expect(sent.join("\n")).toContain("ARG:--cap-drop=ALL");
    sent.length = 0;
    await command.handler(ctx, input(who, "code workspace runner"));
    expect(sent.join("\n")).toContain(`container image ${IMAGE}`);
    sent.length = 0;
    await command.handler(ctx, input(who, "code workspace runner local"));
    expect(sent.join("\n")).toContain("run on the host");
    sent.length = 0;
    await command.handler(ctx, input(who, "code run git status --short"));
    expect(sent.join("\n")).not.toContain("ARG:");
  });

  it("refuses to configure a runner without code.exec", async () => {
    const who = entity("e_nogate", "NoGate");
    db.saveEntity(who);
    const command = codeCommand({
      db,
      getEntity: (id) => (id === who.id ? who : undefined),
      workspace: new LocalWorkspace(root),
    });
    const sent: string[] = [];
    const ctx = ctxFor(sent);
    await command.handler(ctx, input(who, "code start Gate test"));
    sent.length = 0;
    await command.handler(ctx, input(who, `code workspace runner container image:${IMAGE}`));
    expect(sent.join("\n").toLowerCase()).toContain("run or apply code");
  });

  const setup = async (id: string, gates: string[]) => {
    const who = entity(id, id);
    db.saveEntity(who);
    for (const gate of gates) grant(db, who.id, gate);
    const command = codeCommand({
      db,
      getEntity: (eid) => (eid === who.id ? who : undefined),
      workspace: new LocalWorkspace(root),
    });
    const sent: string[] = [];
    const ctx = ctxFor(sent);
    await command.handler(ctx, input(who, `code start ${id} test`));
    const say = async (raw: string) => {
      sent.length = 0;
      await command.handler(ctx, input(who, raw));
      return sent.join("\n");
    };
    return { who, say };
  };

  it("operator image: refuses local, image, network and init overrides; limits are allowed", async () => {
    process.env.MARINA_CODE_CONTAINER_IMAGE = IMAGE;
    process.env.MARINA_CODE_CONTAINER_RUNTIME = "podman";
    const { say } = await setup("e_policy", ["code.exec", "code.exec.unrestricted"]);
    expect(await say("code workspace runner local")).toContain("operator requires container");
    expect(await say("code workspace runner container image:docker.io/evil/img")).toMatch(
      /cannot change image/,
    );
    expect(await say(`code workspace runner container image:${IMAGE} network:on`)).toMatch(
      /cannot change network/,
    );
    expect(await say("code workspace runner container runtime:docker")).toMatch(
      /cannot change runtime/,
    );
    expect(await say("code workspace runner container -- curl x | sh")).toContain(
      "MARINA_CODE_CONTAINER_INIT",
    );
    // Commands still run in the operator's container (never on the host).
    expect(await say("code run git status --short")).toContain("ARG:--cap-drop=ALL");
    expect(await say("code workspace runner container cpus:4")).toContain(
      `Commands now run in ${IMAGE}`,
    );
    expect(await say("code workspace runner")).toContain("operator policy");
  });

  it("MARINA_CODE_CONTAINER_REQUIRED=false is the operator's explicit opt-out", async () => {
    process.env.MARINA_CODE_CONTAINER_IMAGE = IMAGE;
    process.env.MARINA_CODE_CONTAINER_REQUIRED = "false";
    const { say } = await setup("e_optout", ["code.exec"]);
    expect(await say("code workspace runner local")).toContain("run on the host");
    expect(await say("code run git status --short")).not.toContain("ARG:");
  });

  it("no operator image: init is refused; a chosen image or network needs the override gate", async () => {
    const { say } = await setup("e_nogate2", ["code.exec"]);
    expect(await say(`code workspace runner container image:${IMAGE} -- echo hi`)).toContain(
      "MARINA_CODE_CONTAINER_INIT",
    );
    const refused = await say(`code workspace runner container image:${IMAGE} runtime:podman`);
    expect(refused).toMatch(/arbitrary|code\.exec\.unrestricted|approv/i);
    expect(refused).not.toContain("Commands now run");
    expect(await say("code run git status --short")).not.toContain("ARG:");
    const gated = await setup("e_gated", ["code.exec", "code.exec.unrestricted"]);
    expect(
      await gated.say(`code workspace runner container image:${IMAGE} runtime:podman network:on`),
    ).toContain("Network on");
    // The gate pass is recorded with the setting, so network survives on use.
    expect(await gated.say("code workspace runner")).toContain("network on");
  });
});

describe("effective runner (operator policy applied on every use)", () => {
  const container = (config: Record<string, unknown>) =>
    ({ kind: "container", config: { image: IMAGE, ...config } }) as const;

  it("operator image: a stored local pin, image, network or init never outranks it", () => {
    const env = { MARINA_CODE_CONTAINER_IMAGE: IMAGE, MARINA_CODE_CONTAINER_INIT: "true" };
    expect(operatorContainerPolicy(env).required).toBe(true);
    expect(effectiveRunner({ kind: "local" }, env)).toMatchObject({
      kind: "container",
      config: { image: IMAGE },
    });
    const stored = effectiveRunner(
      container({ image: "evil/img", network: true, gated: true, init: "curl x|sh", cpus: 4 }),
      env,
    );
    expect(stored).toEqual({
      kind: "container",
      config: { ...envRunnerConfig(env)!, cpus: 4 },
    });
  });

  it("without a policy: init is stripped and network needs the recorded gate", () => {
    const plain = effectiveRunner(container({ network: true, init: "curl x|sh" }), {});
    expect(plain).toEqual({ kind: "container", config: { image: IMAGE, network: false } });
    const gated = effectiveRunner(container({ network: true, gated: true }), {});
    expect(gated).toEqual({ kind: "container", config: { image: IMAGE, network: true } });
    expect(effectiveRunner({ kind: "local" }, {})).toEqual({ kind: "host" });
    expect(effectiveRunner(null, {})).toEqual({ kind: "host" });
  });

  it("verification installs follow the policy-applied network setting, never the host", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "marina-policy-install-")));
    const rtDir = fakeRuntimeDir();
    const savedPath = process.env.PATH;
    process.env.PATH = `${rtDir}:${savedPath}`;
    try {
      gitInit(root);
      const session = { id: "s1", execution_target: "local" } as unknown as CodingSessionRow;
      const stored = (runner: Record<string, unknown>) =>
        ({
          listCodingArtifacts: () => [
            {
              kind: "workspace_runner",
              status: "active",
              metadata_json: JSON.stringify({ runner }),
            },
          ],
        }) as unknown as MarinaDB;
      const host = new LocalWorkspace(root);
      const operator = {
        MARINA_CODE_CONTAINER_IMAGE: IMAGE,
        MARINA_CODE_CONTAINER_RUNTIME: "podman",
      };
      const permitted = (db: MarinaDB | undefined, env: NodeJS.ProcessEnv) =>
        applySessionRunner(host, db, session, env).installsPermitted?.() === true;
      // Operator image without network: no install, even if a stored setting asks for network.
      expect(permitted(undefined, operator)).toBe(false);
      expect(permitted(stored({ image: IMAGE, network: true, gated: true }), operator)).toBe(false);
      // The operator turns network on: installs may run in the (mounted) container.
      expect(permitted(undefined, { ...operator, MARINA_CODE_CONTAINER_NETWORK: "on" })).toBe(true);
      // No operator image: network only with the recorded override-gate pass.
      const env = { MARINA_CODE_CONTAINER_RUNTIME: "podman" };
      expect(permitted(stored({ image: IMAGE, network: true }), env)).toBe(false);
      expect(permitted(stored({ image: IMAGE, network: true, gated: true }), env)).toBe(true);
      // An install where none is permitted is refused before anything spawns.
      const ws = applySessionRunner(host, undefined, session, operator);
      await expect(
        ws.runPreparationStep?.(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]) ??
          Promise.resolve(),
      ).rejects.toThrow(/not permitted/);
    } finally {
      process.env.PATH = savedPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(rtDir, { recursive: true, force: true });
    }
  });

  it("REQUIRED without an image: never the host", () => {
    const env = { MARINA_CODE_CONTAINER_REQUIRED: "true" };
    expect(effectiveRunner(null, env).kind).toBe("unavailable");
    expect(effectiveRunner({ kind: "local" }, env).kind).toBe("unavailable");
    expect(effectiveRunner(container({}), env)).toMatchObject({ kind: "container" });
  });
});

// Opt-in: a real runtime and a locally present image with git (no pulls in CI).
const IT_IMAGE = process.env.MARINA_TEST_CONTAINER_IMAGE;
const itRuntime = Bun.which("podman") ? "podman" : Bun.which("docker") ? "docker" : null;
describe.skipIf(!IT_IMAGE || !itRuntime)("ContainerWorkspace (real runtime, opt-in)", () => {
  it("mount sync: the container sees the host worktree, including uncommitted files", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "marina-cw-it-")));
    try {
      gitInit(root);
      writeFileSync(join(root, "probe_marker.txt"), "hello\n");
      const ws = new ContainerWorkspace(
        root,
        resolveContainerRunner({
          image: IT_IMAGE!,
          runtime: itRuntime as "podman" | "docker",
          timeoutMs: 120_000,
        }),
      );
      const result = await ws.run(["git", "status", "--short"]);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("probe_marker.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("operator default runner (MARINA_CODE_CONTAINER_*)", () => {
  const session = (id: string) =>
    ({ id, execution_target: "local" }) as unknown as CodingSessionRow;
  const noArtifacts = { listCodingArtifacts: () => [] };

  it("reads the env default and applies it only to sessions without an explicit setting", () => {
    const env = {
      MARINA_CODE_CONTAINER_IMAGE: IMAGE,
      MARINA_CODE_CONTAINER_SYNC: "patch",
      MARINA_CODE_CONTAINER_WORKDIR: "/testbed",
      MARINA_CODE_CONTAINER_SHELL: "bash",
      MARINA_CODE_CONTAINER_INIT: "source /opt/conda/bin/activate testbed",
      MARINA_CODE_CONTAINER_RUNTIME: "podman",
    };
    expect(envRunnerConfig(env)).toMatchObject({
      image: IMAGE,
      sync: "patch",
      workdir: "/testbed",
      shell: "bash",
      network: false,
    });
    expect(envRunnerConfig({})).toBeNull();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "marina-envrunner-")));
    try {
      const host = new LocalWorkspace(root);
      const wrapped = applySessionRunner(host, noArtifacts, session("s1"), env);
      // A container workspace, or (without a runtime) an unavailable one — never the host.
      expect(wrapped).not.toBe(host);
      expect(applySessionRunner(host, noArtifacts, session("s1"), {})).toBe(host);
      const pinned = {
        listCodingArtifacts: () => [
          {
            kind: "workspace_runner",
            status: "active",
            metadata_json: JSON.stringify({ runner: { kind: "local" } }),
          },
        ],
      } as unknown as MarinaDB;
      // Operator policy wins: a stored `local` pin does not leave the operator image...
      expect(applySessionRunner(host, pinned, session("s1"), env)).not.toBe(host);
      // ...unless the operator explicitly allows it.
      expect(
        applySessionRunner(host, pinned, session("s1"), {
          ...env,
          MARINA_CODE_CONTAINER_REQUIRED: "false",
        }),
      ).toBe(host);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
