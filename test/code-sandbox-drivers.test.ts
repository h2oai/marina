// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Repositories with content drivers (nbstripout-style clean filters) and with
// shell-expanded git settings run in the bubblewrap sandbox runner. Marina's own
// git work that needs a driver (diff, staging, candidate and snapshot trees)
// runs INSIDE the sandbox; host git keeps every driver and configured hook off;
// what the person's own git could pick up from the session is reported.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeCandidate } from "../src/coding/candidate";
import { publishEnv, shipChange } from "../src/coding/code-ship";
import { type GitRunner, snapshotCommit, trialHostGit } from "../src/coding/code-trial";
import { HOST_GIT_CONFIG_ARGS, hostGitDriverOverrides, hostGitEnv } from "../src/coding/host-git";
import { LocalWorkspace } from "../src/coding/local-workspace";
import {
  type GitExposure,
  gitExposureNotice,
  gitExposureReport,
  parseBatch,
  parseIndexEntries,
  programConfigPins,
  resolveSandboxLayout,
  SANDBOX_SYSTEM_PATHS,
  type SandboxLayoutOptions,
  SandboxWorkspace,
} from "../src/coding/sandbox-workspace";
import { spawnGit } from "../src/engine/run-version";
import { git, gitInit } from "./git-helpers";

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
/** A writable directory outside /tmp (the sandbox's /tmp is private). */
const VAR_TMP = (() => {
  try {
    rmSync(mkdtempSync("/var/tmp/marina-sbx-probe-"), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const varTmp = (prefix: string) => realpathSync(mkdtempSync(join("/var/tmp", prefix)));

/** Fake launchers (policy tests only): the "sandbox" execs on the host. */
function fakeLaunchers(): { dir: string; opts: SandboxLayoutOptions } {
  const dir = tmp("marina-sbx-fake-");
  chmodSync(dir, 0o755);
  writeFileSync(
    join(dir, "bwrap"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "bubblewrap 0.13.1"; exit 0; fi
while [ $# -gt 0 ]; do case "$1" in --chdir) cd "$2" || exit 125; shift 2 ;; --) shift; break ;; *) shift ;; esac; done
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

describe("drivers and shell expansion are supported and reported (no bubblewrap needed)", () => {
  let root: string;
  let home: string;
  let fake: ReturnType<typeof fakeLaunchers>;
  const layout = () => resolveSandboxLayout(root, [], { ...fake.opts, home, serverState: [] });
  beforeEach(() => {
    root = tmp("marina-sbx-drv-");
    home = tmp("marina-sbx-drvhome-");
    fake = fakeLaunchers();
    gitInit(root);
  });
  afterEach(() => {
    for (const d of [root, home, fake.dir]) rmSync(d, { recursive: true, force: true });
  });

  it("content drivers are no longer refused: each is reported, filters are named", () => {
    for (const [key, value] of [
      ["filter.nbstripout.clean", '"/usr/bin/python3" -m nbstripout'],
      ["filter.x.process", "some-filter-daemon"],
      ["diff.t.textconv", "cat"],
      ["diff.t.command", "sh conv.sh"],
      ["diff.external", "difftool-x"],
      ["merge.m.driver", "merge-tool %O %A %B"],
    ] as const)
      git(root, "config", key, value);
    const resolved = layout();
    expect(resolved.exposures?.map((e) => e.key).sort()).toEqual(
      [
        "diff.external",
        "diff.t.command",
        "diff.t.textconv",
        "filter.nbstripout.clean",
        "filter.x.process",
        "merge.m.driver",
      ].sort(),
    );
    expect(resolved.exposures?.every((e) => e.kind === "content-driver")).toBe(true);
    expect(resolved.contentFilters?.sort()).toEqual(["nbstripout", "x"]);
  });

  it("git-lfs's own filters are neither reported nor staged in the sandbox; an in-tree lfs program is refused", () => {
    git(root, "config", "filter.lfs.clean", "git-lfs clean -- %f");
    git(root, "config", "filter.lfs.process", "git-lfs filter-process");
    expect(layout().exposures).toEqual([]);
    expect(layout().contentFilters).toEqual([]);
    git(root, "config", "filter.lfs.process", `${root}/bin/git-lfs filter-process`);
    expect(() => layout()).toThrow(/git-lfs program inside the work tree/);
  });

  it("shell-expanded settings are reported, their literal in-tree programs still pinned", () => {
    mkdirSync(join(root, "tools"));
    writeFileSync(join(root, "tools", "m"), "#!/bin/sh\n");
    git(root, "config", "mergetool.x.cmd", './tools/m "$LOCAL" "$REMOTE"');
    git(root, "config", "hook.lint.command", "$(git rev-parse --show-toplevel)/tools/lint.sh");
    const resolved = layout();
    expect(resolved.exposures?.map((e) => [e.key, e.kind])).toEqual([
      ["mergetool.x.cmd", "shell-expansion"],
      ["hook.lint.command", "shell-expansion"],
    ]);
    expect(resolved.pins.readOnly).toEqual([join(root, "tools", "m")]);
    // Data-only sections are not reported, `$` and all.
    git(root, "config", "user.name", "$HOME person");
    expect(layout().exposures).toHaveLength(2);
  });

  it("still refused: ext:: transports, includes of in-tree config, shell syntax around an in-tree path", () => {
    git(root, "config", "remote.evil.url", "ext::sh -c id");
    expect(() => layout()).toThrow(/ext:: transport/);
    git(root, "config", "--unset", "remote.evil.url");
    writeFileSync(join(root, "inc.cfg"), "[core]\n");
    git(root, "config", "include.path", join(root, "inc.cfg"));
    expect(() => layout()).toThrow(/includes a file inside the writable tree/);
    git(root, "config", "--unset", "include.path");
    writeFileSync(join(root, "run.sh"), "#!/bin/sh\n");
    git(root, "config", "alias.go", "!sh -c 'cd sub && ./run.sh'");
    expect(() => layout()).toThrow(/shell syntax/);
  });

  it("exposures name the key and file, never the value", () => {
    writeFileSync(
      join(home, ".gitconfig"),
      '[credential]\n\thelper = "!f(){ echo password=s3cr3t-$1; }; f"\n',
    );
    const exposures = layout().exposures ?? [];
    expect(exposures).toEqual([
      { key: "credential.helper", file: join(home, ".gitconfig"), kind: "shell-expansion" },
    ]);
    const notice = gitExposureNotice(gitExposureReport(root, exposures, 0), root) ?? "";
    expect(notice).toContain("credential.helper");
    expect(notice).not.toContain("s3cr3t");
  });

  it("programConfigPins collects into the caller's list", () => {
    git(root, "config", "filter.nb.clean", "strip");
    const exposures: GitExposure[] = [];
    programConfigPins([{ file: join(root, ".git", "config"), base: root }], root, home, exposures);
    expect(exposures.map((e) => e.key)).toEqual(["filter.nb.clean"]);
  });
});

describe("the exposure report (no bubblewrap needed)", () => {
  let root: string;
  beforeEach(() => {
    root = tmp("marina-sbx-exp-");
    gitInit(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const exposures: GitExposure[] = [
    { key: "filter.nb.clean", file: "/x/.git/config", kind: "content-driver" },
  ];

  it("lists files created or changed since the session started, ignored ones included, never .git", async () => {
    writeFileSync(join(root, "old.txt"), "before\n");
    const since = Date.now() + 1500; // past the report's one-second slack
    await Bun.sleep(1600);
    mkdirSync(join(root, "pkg"));
    writeFileSync(join(root, "pkg", "nbstripout.py"), "planted\n");
    writeFileSync(join(root, ".gitignore"), "*.pyc\n");
    writeFileSync(join(root, "nbstripout.pyc"), "planted\n");
    writeFileSync(join(root, ".git", "description"), "touched\n");
    const report = gitExposureReport(root, exposures, since);
    expect(report.files).toEqual([".gitignore", "nbstripout.pyc", "pkg/nbstripout.py"]);
    expect(report.more).toBe(0);
    const notice = gitExposureNotice(report, root) ?? "";
    expect(notice).toContain("filter.nb.clean");
    expect(notice).toContain("nbstripout.pyc");
    expect(notice).not.toContain("old.txt");
    expect(gitExposureReport(root, exposures, since, { listed: 1 }).more).toBe(2);
    expect(gitExposureReport(root, exposures, since, { maxEntries: 2 }).incomplete).toBe(true);
    expect(gitExposureNotice({ ...report, exposures: [] }, root)).toBeNull();
  });
});

describe("parsers for what the sandbox returns (no bubblewrap needed)", () => {
  it("index entries: stage 0, known modes, safe paths only", () => {
    const oid = "a".repeat(40);
    expect(parseIndexEntries(Buffer.from(`100644 ${oid} 0\ta/b.nb\0`))).toEqual([
      { mode: "100644", oid, path: "a/b.nb" },
    ]);
    for (const bad of [
      `100644 ${oid} 1\ta\0`,
      `040000 ${oid} 0\ta\0`,
      `100644 ${oid} 0\t.git/config\0`,
      `100644 ${oid} 0\t../x\0`,
      `100644 ${oid} 0\t/etc/passwd\0`,
    ])
      expect(() => parseIndexEntries(Buffer.from(bad))).toThrow();
  });

  it("cat-file --batch frames, binary-safe; a short or garbled stream is refused", () => {
    const oid = "b".repeat(40);
    const body = Buffer.from([0, 10, 255, 10]);
    const stream = Buffer.concat([
      Buffer.from(`${oid} blob 4\n`),
      body,
      Buffer.from("\n"),
      Buffer.from(`${"c".repeat(40)} missing\n`),
    ]);
    const parsed = parseBatch(stream);
    expect(parsed.get(oid)?.data.equals(body)).toBe(true);
    expect(() => parseBatch(Buffer.from(`${oid} blob 9\nabc\n`))).toThrow(/Malformed/);
    expect(() => parseBatch(Buffer.from("garbage\n"))).toThrow(/Malformed/);
  });
});

describe("host git switches off configured hooks too (no bubblewrap needed)", () => {
  let root: string;
  let mark: string;
  beforeEach(() => {
    root = tmp("marina-sbx-hook-");
    mark = join(tmp("marina-sbx-mark-"), "hook-ran");
    gitInit(root);
    git(root, "commit", "--allow-empty", "-q", "-m", "init");
    git(root, "config", "hook.planted.command", `touch ${mark}`);
    git(root, "config", "hook.planted.event", "reference-transaction");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(mark, ".."), { recursive: true, force: true });
  });

  it("a hook.<name>.command never runs from host git's update-ref (core.hooksPath does not reach it)", () => {
    const run = (argv: string[]) =>
      Bun.spawnSync(argv, { cwd: root, env: hostGitEnv(), stdout: "pipe", stderr: "pipe" });
    const hardened = [
      "git",
      ...HOST_GIT_CONFIG_ARGS,
      ...hostGitDriverOverrides(root),
      "update-ref",
      "refs/heads/x",
      "HEAD",
    ];
    expect(run(hardened).exitCode).toBe(0);
    expect(existsSync(mark)).toBe(false);
    // Control: without the overrides, git runs it.
    expect(
      run(["git", ...HOST_GIT_CONFIG_ARGS, "update-ref", "refs/heads/y", "HEAD"]).exitCode,
    ).toBe(0);
    expect(existsSync(mark)).toBe(true);
  });
});

describe("Marina's other host git never runs a content filter (no bubblewrap needed)", () => {
  let root: string;
  let dir: string;
  let mark: string;
  let saved: string | undefined;
  beforeEach(() => {
    root = tmp("marina-sbx-hostf-");
    dir = tmp("marina-sbx-hostf-aux-");
    mark = join(dir, "filter-ran");
    const filter = join(dir, "filter.sh");
    writeFileSync(filter, `#!/bin/sh\necho ran > ${mark}\ncat\n`);
    chmodSync(filter, 0o755);
    gitInit(root);
    writeFileSync(join(root, ".gitattributes"), "*.nb filter=f\n");
    writeFileSync(join(root, "a.nb"), "one\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    writeFileSync(join(root, "a.nb"), "two\n");
    // The person's GLOBAL config (nbstripout --install --global), which host git must not read.
    writeFileSync(join(dir, "gitconfig"), `[filter "f"]\n\tclean = ${filter}\n`);
    saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("code trial's snapshot (git add -A) ignores the person's global filter", () => {
    snapshotCommit(trialHostGit, root, dir);
    expect(existsSync(mark)).toBe(false);
  });

  it("version stamps (git status on a checkout) never run the repository's filter", () => {
    git(root, "config", "filter.f.clean", join(dir, "filter.sh"));
    delete process.env.GIT_CONFIG_GLOBAL;
    // `diff` hashes the work tree as status would for a same-size edit.
    spawnGit(["diff", "--stat"], root);
    spawnGit(["status", "--porcelain"], root);
    expect(existsSync(mark)).toBe(false);
  });
});

/**
 * A tiny nbstripout: an absolute program outside the tree that strips OUTPUT
 * lines, and that (like `python -m nbstripout`, whose sys.path starts with the
 * current directory) also loads a file from the work tree it does not name.
 */
function stripFilter(dir: string): string {
  const path = join(dir, "bin", "strip-filter");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(
    path,
    "#!/bin/sh\n[ -f ./strip-plugin.sh ] && . ./strip-plugin.sh\nexec sed '/OUTPUT/d'\n",
  );
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(!BWRAP || !VAR_TMP)("a content-filter repository under real bubblewrap", () => {
  let root: string;
  let system: string;
  let marks: string;
  let home: string;
  let ws: SandboxWorkspace;
  const hostMark = (name: string) => join(marks, name);
  const plain = (cwd: string, ...args: string[]) => git(cwd, ...args).trim();
  beforeEach(async () => {
    // The filter program lives in a stand-in system directory (bound read-only in the sandbox).
    system = varTmp("marina-sbx-drvsys-");
    const filter = stripFilter(system);
    // Host-only marker directory: not bound into the sandbox, so only a HOST process can write it.
    marks = varTmp("marina-sbx-marks-");
    home = varTmp("marina-sbx-drvh-");
    root = tmp("marina-sbx-nb-");
    gitInit(root);
    writeFileSync(join(root, ".gitattributes"), "*.nb filter=strip\n");
    git(root, "config", "filter.strip.clean", filter);
    git(root, "config", "filter.strip.smudge", "cat");
    git(root, "config", "filter.strip.required", "true");
    writeFileSync(join(root, "a.nb"), "code\n");
    writeFileSync(join(root, "keep.txt"), "plain\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    // A shell-expanded mergetool and a configured hook whose programs the session can plant.
    git(
      root,
      "config",
      "mergetool.x.cmd",
      '"$(git rev-parse --show-toplevel)/tools/merge.sh" "$LOCAL"',
    );
    git(root, "config", "hook.planted.command", "$(git rev-parse --show-toplevel)/tools/hook.sh");
    git(root, "config", "hook.planted.event", "reference-transaction");
    ws = new SandboxWorkspace(root, [], {
      home,
      systemPaths: [...SANDBOX_SYSTEM_PATHS, system],
      serverState: [],
    });
    // The session: edits a notebook, adds one, and plants programs the filter,
    // the mergetool and the hook would run, each writing a HOST-only marker.
    const planted = (name: string) => `echo ran > ${hostMark(name)} 2>/dev/null || true`;
    const session = await ws.run([
      "sh",
      "-c",
      [
        "printf 'code\\nOUTPUT 1\\nmore\\n' > a.nb",
        "printf 'new\\nOUTPUT x\\n' > b.nb",
        `printf '%s\\n' '${planted("filter-plugin")}' > strip-plugin.sh`,
        "mkdir -p tools",
        `printf '#!/bin/sh\\n%s\\n' '${planted("mergetool")}' > tools/merge.sh`,
        `printf '#!/bin/sh\\n%s\\n' '${planted("hook")}' > tools/hook.sh`,
        "chmod +x tools/merge.sh tools/hook.sh",
      ].join(" && "),
    ]);
    expect(session.exitCode).toBe(0);
  });
  afterEach(() => {
    for (const d of [root, system, marks, home]) rmSync(d, { recursive: true, force: true });
  });
  const noHostMarks = () => {
    for (const name of ["filter-plugin", "mergetool", "hook"])
      expect(existsSync(hostMark(name))).toBe(false);
  };

  it("the session works: commands run, the layout reports the driver and the shell-expanded settings", async () => {
    const out = await ws.run(["sh", "-c", "cat a.nb | wc -l"]);
    expect(out.output.split("\n")[0]?.trim()).toBe("3");
    const keys = (ws.layout().exposures ?? []).map((e) => e.key).sort();
    expect(keys).toEqual([
      "filter.strip.clean",
      "filter.strip.smudge",
      "hook.planted.command",
      "mergetool.x.cmd",
    ]);
    expect(ws.contentFilters()).toEqual(["strip"]);
    noHostMarks();
  });

  it("diff and changed paths are what the person's git would show: filtered, new files included", async () => {
    const diff = await ws.diff();
    expect(diff.exitCode).toBe(0);
    expect(diff.content).toContain("+more");
    expect(diff.content).toContain("+new");
    expect(diff.content).not.toContain("OUTPUT");
    expect(diff.content).toContain("b/b.nb");
    expect((await ws.diff("a.nb")).content).not.toContain("b.nb");
    const changed = await ws.changedPaths();
    expect(changed).toContain("a.nb");
    expect(changed).toContain("b.nb");
    expect(changed).not.toContain("keep.txt");
    noHostMarks();
  });

  it("the candidate's tree holds the filtered blobs; its materialized copy and fingerprint stay raw", async () => {
    const captured = await ws.captureCandidate();
    try {
      const { tree } = captured.candidate;
      expect(plain(root, "cat-file", "-p", `${tree}:a.nb`)).toBe("code\nmore");
      expect(plain(root, "cat-file", "-p", `${tree}:b.nb`)).toBe("new");
      expect(plain(root, "cat-file", "-p", `${tree}:keep.txt`)).toBe("plain");
      expect(readFileSync(join(captured.directory, "a.nb"), "utf8")).toContain("OUTPUT 1");
      expect(await observeCandidate(captured.candidate)).toBe(captured.candidate.fingerprint);
    } finally {
      await captured.dispose();
    }
    noHostMarks();
  });

  it("a snapshot commit and a shipped commit carry the filtered content", async () => {
    const tree = await ws.snapshotTree();
    const scratch = tmp("marina-sbx-snap-");
    try {
      const hostGit: GitRunner = (cwd, argv, env) => {
        const r = Bun.spawnSync(
          ["git", ...HOST_GIT_CONFIG_ARGS, ...hostGitDriverOverrides(cwd), ...argv],
          { cwd, env: hostGitEnv(env), stdout: "pipe", stderr: "pipe" },
        );
        return {
          exitCode: r.exitCode,
          stdout: r.stdout.toString().trim(),
          stderr: r.stderr.toString().trim(),
        };
      };
      const commit = snapshotCommit(hostGit, root, scratch, tree);
      expect(plain(root, "cat-file", "-p", `${commit}:a.nb`)).toBe("code\nmore");
      expect(plain(root, "cat-file", "-p", `${commit}:strip-plugin.sh`)).toContain("echo ran");
      const runner = (cwd: string, argv: string[]) => {
        const r = Bun.spawnSync(argv, { cwd, env: hostGitEnv(), stdout: "pipe", stderr: "pipe" });
        return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
      };
      const ok = () => ({ exitCode: 0, stdout: "https://example.invalid/pr/1\n", stderr: "" });
      const shipped = shipChange(
        { git: runner, push: ok, gh: ok, identity: { name: "P", email: "p@example.invalid" } },
        {
          tree: root,
          branch: "marina/session-x",
          base: "main",
          title: "nb",
          trial: {
            id: "t",
            benchmark: "smoke",
            verdict: "candidate-wins",
            base: {
              sha: "1".repeat(40),
              runs: 1,
              attempts: 1,
              successes: 1,
              accuracy: 1,
              costUsd: 0,
            },
            candidate: { sha: commit, runs: 1, attempts: 1, successes: 1, accuracy: 1, costUsd: 0 },
            delta: 0,
            low: 0,
            high: 0,
            items: 1,
            margin: 0,
            triedBefore: 0,
            warnings: [],
          },
          author: "coder",
          merge: false,
          scratch,
          stagedTree: tree,
        },
      );
      expect(plain(root, "cat-file", "-p", `${shipped.commit}:a.nb`)).toBe("code\nmore");
      expect(plain(root, "cat-file", "-p", `${shipped.commit}:b.nb`)).toBe("new");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    noHostMarks();
  });

  it("a filter that cannot run in the sandbox fails closed instead of showing raw bytes", async () => {
    // Like nbstripout installed under the hidden home: python runs, the module is missing.
    git(root, "config", "filter.strip.clean", "/bin/sh -c 'exit 1'");
    git(root, "config", "filter.strip.required", "false");
    const diff = await ws.diff();
    expect(diff.exitCode).toBe(1);
    expect(diff.content).toContain("could not run inside the sandbox");
    await expect(ws.captureCandidate()).rejects.toThrow(/could not run inside the sandbox/);
    noHostMarks();
  });

  it("no host process Marina starts runs what the session planted", async () => {
    // Host git over the same tree: the session diff a host runner would show, a raw candidate
    // ref update, version stamps. Drivers and configured hooks are off.
    const host = new LocalWorkspace(root);
    expect((await host.diff()).exitCode).toBe(0);
    const updated = Bun.spawnSync(
      [
        "git",
        ...HOST_GIT_CONFIG_ARGS,
        ...hostGitDriverOverrides(root),
        "update-ref",
        "refs/marina/x",
        "HEAD",
      ],
      { cwd: root, env: hostGitEnv(), stdout: "ignore", stderr: "ignore" },
    );
    expect(updated.exitCode).toBe(0);
    // What `gh pr create` starts in the tree under code ship's publish environment.
    const gh = Bun.spawnSync(
      ["sh", "-c", "git status --porcelain && git update-ref refs/marina/y HEAD"],
      {
        cwd: root,
        env: publishEnv(root, { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(gh.exitCode).toBe(0);
    noHostMarks();
  });

  it("the residual risk is real and is reported: the person's own git runs the filter in the tree", async () => {
    const since = Date.now() - 60_000;
    const report = gitExposureReport(root, ws.layout().exposures ?? [], since);
    expect(report.files).toEqual(
      expect.arrayContaining([
        "a.nb",
        "b.nb",
        "strip-plugin.sh",
        "tools/hook.sh",
        "tools/merge.sh",
      ]),
    );
    const notice = gitExposureNotice(report, root) ?? "";
    expect(notice).toContain("filter.strip.clean");
    expect(notice).toContain("strip-plugin.sh");
    // The person's plain git (their own config, filters on) — outside Marina.
    git(root, "diff", "--stat");
    expect(existsSync(hostMark("filter-plugin"))).toBe(true);
  });
});
