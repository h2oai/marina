// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateFingerprint, captureGitCandidate } from "../src/coding/candidate";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { until } from "./helpers";

describe("immutable Git source candidates", () => {
  let root: string;
  const snapshots: Awaited<ReturnType<typeof captureGitCandidate>>[] = [];
  function git(...args: string[]) {
    const result = Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      {
        cwd: root,
        env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "marina-candidate-test-"));
    git("init", "--quiet", "--template=");
    writeFileSync(join(root, "source.txt"), "base\n");
    writeFileSync(join(root, "deleted.txt"), "delete me\n");
    writeFileSync(join(root, ".gitignore"), "ignored/\n.env\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
  });
  afterEach(async () => {
    for (const snapshot of snapshots.splice(0)) await snapshot.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  async function capture() {
    const snapshot = await captureGitCandidate(root);
    snapshots.push(snapshot);
    return snapshot;
  }

  it("captures staged, unstaged, untracked, binary, executable and symlink bytes without changing HEAD or index", async () => {
    writeFileSync(join(root, "source.txt"), "staged\n");
    git("add", "source.txt");
    writeFileSync(join(root, "source.txt"), "working\n");
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 255, 10, 1]));
    writeFileSync(join(root, 'unicode λ "space".txt'), "untracked\n");
    writeFileSync(join(root, "run.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(root, "run.sh"), 0o755);
    symlinkSync("source.txt", join(root, "link"));
    rmSync(join(root, "deleted.txt"));
    mkdirSync(join(root, "ignored"));
    writeFileSync(join(root, "ignored", "generated"), "ignored bytes");
    writeFileSync(join(root, ".env"), "PRIVATE_KEY=not-in-snapshot");
    const index = readFileSync(join(root, ".git/index"));
    const head = git("rev-parse", "HEAD");
    // Alternate index must also work while the operator owns the normal index lock.
    writeFileSync(join(root, ".git/index.lock"), "operator lock");
    const snapshot = await capture();
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, ".git/index.lock"), "utf8")).toBe("operator lock");
    expect(readFileSync(join(snapshot.directory, "source.txt"), "utf8")).toBe("working\n");
    expect(readFileSync(join(snapshot.directory, "binary.dat"))).toEqual(
      Buffer.from([0, 255, 10, 1]),
    );
    expect(readlinkSync(join(snapshot.directory, "link"))).toBe("source.txt");
    expect(existsSync(join(snapshot.directory, "deleted.txt"))).toBe(false);
    expect(existsSync(join(snapshot.directory, ".env"))).toBe(false);
    expect(existsSync(join(snapshot.directory, "ignored"))).toBe(false);
    expect(await candidateFingerprint(snapshot.directory)).toBe(snapshot.candidate.fingerprint);
    expect(git("show", `${snapshot.candidate.tree}:source.txt`)).toBe("working");
    expect(git("ls-tree", snapshot.candidate.tree, "run.sh")).toStartWith("100755 blob");
    expect(git("rev-parse", `${snapshot.candidate.ref}^{tree}`)).toBe(snapshot.candidate.tree);
  });

  it("detects direct edits even under assume-unchanged and keeps checked bytes isolated from original ABA changes", async () => {
    git("update-index", "--assume-unchanged", "source.txt");
    const snapshot = await capture();
    writeFileSync(join(root, "source.txt"), "evil\n");
    expect(git("diff", "--name-only")).toBe("");
    expect(await candidateFingerprint(root)).not.toBe(snapshot.candidate.fingerprint);
    const process = Bun.spawn(["bun", "-e", 'console.log(await Bun.file("source.txt").text())'], {
      cwd: snapshot.directory,
      stdout: "pipe",
    });
    expect(await new Response(process.stdout).text()).toBe("base\n\n");
    expect(await process.exited).toBe(0);
    writeFileSync(join(root, "source.txt"), "base\n");
    expect(await candidateFingerprint(root)).toBe(snapshot.candidate.fingerprint);
    writeFileSync(join(root, "new-file.txt"), "new\n");
    expect(await candidateFingerprint(root)).not.toBe(snapshot.candidate.fingerprint);
  });

  it("retains the tree and base across garbage collection and disposes only its materialization", async () => {
    writeFileSync(join(root, "source.txt"), "candidate\n");
    const snapshot = await capture();
    await snapshot.dispose();
    git("gc", "--prune=now");
    expect(git("show", `${snapshot.candidate.ref}:source.txt`)).toBe("candidate");
    expect(git("rev-parse", `${snapshot.candidate.ref}^`)).toBe(snapshot.candidate.baseCommit!);
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("candidate\n");
    expect(existsSync(snapshot.directory)).toBe(false);
  });

  it("supports unborn repositories and does not manufacture an operator index", async () => {
    rmSync(join(root, ".git"), { recursive: true });
    git("init", "--quiet", "--template=");
    const snapshot = await capture();
    expect(snapshot.candidate.baseCommit).toBeNull();
    expect(existsSync(join(root, ".git/index"))).toBe(false);
    expect(await candidateFingerprint(snapshot.directory)).toBe(snapshot.candidate.fingerprint);
  });

  it("captures a linked worktree without touching either real index or branch", async () => {
    const linked = join(root, "linked");
    git("worktree", "add", "--detach", linked, "HEAD");
    const commonIndex = readFileSync(join(root, ".git/index"));
    const linkedIndexPath = Bun.spawnSync(
      ["git", "rev-parse", "--path-format=absolute", "--git-path", "index"],
      { cwd: linked },
    )
      .stdout.toString()
      .trim();
    const linkedIndex = readFileSync(linkedIndexPath);
    writeFileSync(join(linked, "source.txt"), "linked edit\n");
    const snapshot = await captureGitCandidate(linked);
    snapshots.push(snapshot);
    expect(readFileSync(join(snapshot.directory, "source.txt"), "utf8")).toBe("linked edit\n");
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(join(root, ".git/index"))).toEqual(commonIndex);
    expect(readFileSync(linkedIndexPath)).toEqual(linkedIndex);
    expect(await candidateFingerprint(snapshot.directory)).toBe(snapshot.candidate.fingerprint);
  });

  it("refuses escaping symlinks and unignored credentials without pinning a candidate", async () => {
    symlinkSync("../outside", join(root, "escape"));
    await expect(capture()).rejects.toThrow("escapes");
    rmSync(join(root, "escape"));
    writeFileSync(join(root, ".env.local"), "secret");
    await expect(capture()).rejects.toThrow("credential-shaped");
    expect(git("for-each-ref", "refs/marina/candidates/")).toBe("");
  });

  it("refuses Git filters rather than executing them or silently changing source bytes", async () => {
    writeFileSync(join(root, ".gitattributes"), "source.txt filter=trap\n");
    git("config", "filter.trap.clean", "touch FILTER_EXECUTED");
    git("config", "filter.trap.smudge", "touch FILTER_EXECUTED");
    await expect(capture()).rejects.toThrow("filters");
    expect(existsSync(join(root, "FILTER_EXECUTED"))).toBe(false);
  });

  it("refuses sparse and submodule workspaces explicitly", async () => {
    git("update-index", "--skip-worktree", "source.txt");
    await expect(capture()).rejects.toThrow("skip-worktree");
    git("update-index", "--no-skip-worktree", "source.txt");
    git("config", "core.sparseCheckout", "true");
    await expect(capture()).rejects.toThrow("sparse");
    git("config", "core.sparseCheckout", "false");
    git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},nested`);
    await expect(capture()).rejects.toThrow("submodules");
  });

  it("bounds pinned candidates without deleting prior evidence", async () => {
    const head = git("rev-parse", "HEAD");
    for (let i = 0; i < 64; i++) git("update-ref", `refs/marina/candidates/retained-${i}`, head);
    await expect(capture()).rejects.toThrow("retention reached");
    expect(
      git("for-each-ref", "--format=%(refname)", "refs/marina/candidates/").split("\n"),
    ).toHaveLength(64);
  });

  it("waits for the existing workspace writer and releases idle root locks for later captures", async () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "bun check.ts" } }),
    );
    writeFileSync(
      join(root, "check.ts"),
      `await Bun.write(".git/check-started", "yes");
while (!(await Bun.file(".git/check-release").exists())) await Bun.sleep(5);
await Bun.write("source.txt", "after writer\\n");`,
    );
    const workspace = new LocalWorkspace(root);
    const writer = workspace.runAllowlisted(["bun", "run", "test"], () => {});
    let captured = false;
    let pending: Promise<Awaited<ReturnType<typeof captureGitCandidate>>> | undefined;
    try {
      await until(() => existsSync(join(root, ".git/check-started")), { timeoutMs: 3000 });
      pending = new LocalWorkspace(root)
        .captureCandidate(undefined, () => {
          captured = true;
        })
        .then((snapshot) => {
          snapshots.push(snapshot);
          return snapshot;
        });
      await Promise.resolve();
      expect(captured).toBe(false);
    } finally {
      writeFileSync(join(root, ".git/check-release"), "yes");
      await writer;
      await pending;
    }
    expect(captured).toBe(true);
    expect(readFileSync(join((await pending)!.directory, "source.txt"), "utf8")).toBe(
      "after writer\n",
    );
    const next = await workspace.captureCandidate();
    snapshots.push(next);
    expect(readFileSync(join(next.directory, "source.txt"), "utf8")).toBe("after writer\n");
  });
});
