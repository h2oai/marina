// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HOST_GIT_CONFIG_ARGS, hostGitEnv } from "./host-git";

export const CANDIDATE_POLICY = "git-working-bytes-v1";
const MAX_FILES = 8192;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_PINS = 64;

export interface CandidateIdentity {
  version: 1;
  policy: typeof CANDIDATE_POLICY;
  repository: string;
  baseCommit: string | null;
  tree: string;
  /** Retention commit only; never updates an operator branch or HEAD. */
  commit: string;
  fingerprint: string;
  ref: string;
  files: number;
  bytes: number;
  capturedAt: number;
  exclusions: string[];
}

/** Fixed plumbing only: no inherited Git redirects, hooks, credentials or filters.
 * Callers authorize host execution before capture; this is not a public shell runner. */
async function git(
  cwd: string,
  args: string[],
  input?: Uint8Array | string,
  index?: string,
  allowFailure = false,
) {
  const child = Bun.spawn(["git", ...HOST_GIT_CONFIG_ARGS, ...args], {
    cwd,
    env: hostGitEnv(index ? { GIT_INDEX_FILE: index } : {}),
    stdin:
      input === undefined
        ? "ignore"
        : new Blob([typeof input === "string" ? input : new Uint8Array(input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > 4 * 1024 * 1024) {
        child.kill("SIGKILL");
        throw new Error("Candidate Git output exceeded its bound.");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      read(child.stdout),
      read(child.stderr),
    ]);
    if (code !== 0 && !allowFailure)
      throw new Error(`Candidate capture: git ${args[0]} failed: ${stderr.slice(0, 500)}`);
    return { code, text: stdout };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function credentialPath(path: string) {
  return path
    .split("/")
    .some(
      (part) =>
        (/^\.env(?:\.|$)/i.test(part) && !/^\.env\.(example|sample|template)$/i.test(part)) ||
        /^(?:id_rsa|id_ed25519|credentials\.json|\.npmrc|\.netrc)$|\.(?:pem|key|p12|pfx)$/i.test(
          part,
        ),
    );
}

/** Enumerate the operator index without refreshing or modifying it, then read actual bytes.
 * No stat cache, ignore bit, watcher or Marina event can substitute for content. */
async function scan(inputRoot: string, destination?: string) {
  const root = await realpath(inputRoot);
  const top = (await git(root, ["rev-parse", "--show-toplevel"])).text.trim();
  if ((await realpath(top)) !== root)
    throw new Error("Candidate capture requires the Git working-tree root.");
  const sparse = await git(
    root,
    ["config", "--bool", "core.sparseCheckout"],
    undefined,
    undefined,
    true,
  );
  if (sparse.text.trim() === "true")
    throw new Error("Candidate capture does not yet support sparse checkouts.");
  const staged = (await git(root, ["ls-files", "--stage", "-z"])).text.split("\0").filter(Boolean);
  if (staged.some((entry) => !/^\d+ [a-f0-9]+ 0\t/.test(entry) || entry.startsWith("160000 ")))
    throw new Error("Candidate capture refuses unresolved merges and submodules.");
  const flags = (await git(root, ["ls-files", "-v", "-z"])).text.split("\0");
  if (flags.some((entry) => /^[Ss] /.test(entry)))
    throw new Error("Candidate capture refuses skip-worktree entries.");
  const names = [
    ...new Set(
      (await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).text
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  if (names.length > MAX_FILES) throw new Error(`Candidate capture exceeds ${MAX_FILES} paths.`);
  for (const name of names) {
    if (
      isAbsolute(name) ||
      name.split("/").some((part) => ["..", ".git", ""].includes(part.toLowerCase())) ||
      /[\r\n\0\uFFFD]/.test(name)
    )
      throw new Error("Candidate capture refuses an unsafe or newline-containing path.");
  }
  const attributes = await git(
    root,
    ["check-attr", "-z", "--stdin", "filter", "working-tree-encoding", "ident"],
    names.map((name) => `${name}\0`).join(""),
  );
  const attrs = attributes.text.split("\0");
  for (let i = 2; i < attrs.length; i += 3)
    if (!["unspecified", "unset", ""].includes(attrs[i]!))
      throw new Error(
        "Candidate capture does not yet support Git filters, LFS, ident or encoding attributes.",
      );
  const fingerprint = createHash("sha256");
  const entries: { path: string; mode: string }[] = [];
  let bytes = 0;
  for (const name of names) {
    const path = join(root, name);
    let info: Stats;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (credentialPath(name))
      throw new Error(
        `Candidate capture refuses credential-shaped source: ${name}. Keep secrets outside the included source tree.`,
      );
    if (!inside(root, await realpath(dirname(path))))
      throw new Error("Candidate path traverses a symlink outside its workspace.");
    let content: Buffer;
    let mode: string;
    if (info.isSymbolicLink()) {
      content = await readlink(path, { encoding: "buffer" });
      const target = content.toString("utf8");
      if (!Buffer.from(target).equals(content))
        throw new Error("Candidate requires UTF-8 symlink targets.");
      if (isAbsolute(target) || !inside(root, resolve(dirname(path), target)))
        throw new Error(`Candidate symlink escapes its workspace: ${name}`);
      mode = "120000";
    } else {
      if (!info.isFile() || info.size > 16 * 1024 * 1024)
        throw new Error(`Candidate requires a regular file below 16 MiB: ${name}`);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size > 16 * 1024 * 1024)
          throw new Error("Candidate file changed type or exceeded its size bound.");
        // Bound allocation and reads even if another process grows the file.
        content = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < content.length) {
          const { bytesRead } = await file.read(content, offset, content.length - offset, offset);
          if (!bytesRead) throw new Error("Source changed during candidate capture.");
          offset += bytesRead;
        }
        const after = await file.stat();
        const current = await lstat(path);
        if (
          before.ino !== info.ino ||
          current.ino !== before.ino ||
          current.dev !== before.dev ||
          before.mode !== after.mode ||
          before.mode !== info.mode ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          after.size !== content.length ||
          !inside(root, await realpath(dirname(path)))
        )
          throw new Error(
            "Source changed during candidate capture. Retry after the writer settles.",
          );
      } finally {
        await file.close();
      }
      mode = info.mode & 0o111 ? "100755" : "100644";
    }
    bytes += content.length;
    if (bytes > MAX_BYTES) throw new Error("Candidate exceeds 128 MiB of included source.");
    fingerprint
      .update(`${Buffer.byteLength(name)}:${name}\0${mode}\0${content.length}:`)
      .update(content);
    entries.push({ path: name, mode });
    if (destination) {
      const output = join(destination, name);
      await mkdir(dirname(output), { recursive: true });
      if (mode === "120000") await symlink(content.toString(), output);
      else {
        await writeFile(output, content);
        await chmod(output, mode === "100755" ? 0o755 : 0o644);
      }
    }
  }
  const head = await git(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    undefined,
    undefined,
    true,
  );
  return {
    root,
    entries,
    bytes,
    fingerprint: fingerprint.digest("hex"),
    baseCommit: head.code === 0 ? head.text.trim() : null,
  };
}

export async function candidateFingerprint(
  root: string,
  expectedBase?: string | null,
): Promise<string> {
  const current = await scan(root);
  if (expectedBase !== undefined && current.baseCommit !== expectedBase)
    throw new Error("Candidate base commit changed during verification.");
  return current.fingerprint;
}

/** Retired or missing object evidence cannot certify current source. */
export async function observeCandidate(candidate: CandidateIdentity): Promise<string> {
  if (
    !/^refs\/marina\/candidates\/[a-f0-9-]+$/.test(candidate.ref) ||
    !/^[a-f0-9]{40,64}$/.test(candidate.tree) ||
    !/^[a-f0-9]{40,64}$/.test(candidate.commit)
  )
    throw new Error("Invalid retained candidate identity.");
  const retained = (
    await git(candidate.repository, ["rev-parse", "--verify", candidate.ref])
  ).text.trim();
  const tree = (
    await git(candidate.repository, ["rev-parse", "--verify", `${candidate.ref}^{tree}`])
  ).text.trim();
  if (retained !== candidate.commit || tree !== candidate.tree)
    throw new Error("Retained candidate identity changed.");
  await git(candidate.repository, ["cat-file", "-e", `${candidate.tree}^{tree}`]);
  const current = await scan(candidate.repository);
  if (current.baseCommit !== candidate.baseCommit)
    throw new Error("Candidate base commit changed. Reverify against the intended base.");
  return current.fingerprint;
}

/** Capture actual working bytes in an alternate index and pin their tree for review.
 * A private materialization is owned by the caller; its disposal never touches source. */
export async function captureGitCandidate(root: string, repository = root) {
  const directory = await mkdtemp(join(tmpdir(), "marina-candidate-"));
  const materialized = join(directory, "source");
  const index = join(directory, "index");
  let retained: { repository: string; ref: string; commit: string } | undefined;
  try {
    await mkdir(materialized);
    const source = await scan(root, materialized);
    repository = await realpath(repository);
    if (
      (
        await git(repository, [
          "for-each-ref",
          "--format=%(refname)",
          `--count=${MAX_PINS}`,
          "refs/marina/candidates/",
        ])
      ).text
        .trim()
        .split("\n")
        .filter(Boolean).length >= MAX_PINS
    )
      throw new Error(
        `Candidate retention reached ${MAX_PINS} pinned trees. Retire reviewed candidate refs before capturing more.`,
      );
    const confirmed = await scan(root);
    if (confirmed.fingerprint !== source.fingerprint || confirmed.baseCommit !== source.baseCommit)
      throw new Error("Source changed during candidate capture. Retry after the writer settles.");
    await git(repository, ["read-tree", "--empty"], undefined, index);
    const regular = source.entries.filter((entry) => entry.mode !== "120000");
    const paths = regular.map((entry) => JSON.stringify(join(materialized, entry.path))).join("\n");
    const hashes = paths
      ? (
          await git(
            repository,
            ["hash-object", "-w", "--no-filters", "--stdin-paths"],
            `${paths}\n`,
          )
        ).text
          .trim()
          .split("\n")
      : [];
    let cursor = 0;
    const indexEntries: string[] = [];
    for (const entry of source.entries) {
      const oid =
        entry.mode === "120000"
          ? (
              await git(
                repository,
                ["hash-object", "-w", "--no-filters", "--stdin"],
                await readlink(join(materialized, entry.path)),
              )
            ).text.trim()
          : hashes[cursor++]!;
      if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error("Git returned an invalid blob identity.");
      indexEntries.push(`${entry.mode} ${oid}\t${entry.path}\0`);
    }
    await git(repository, ["update-index", "-z", "--index-info"], indexEntries.join(""), index);
    const tree = (await git(repository, ["write-tree"], undefined, index)).text.trim();
    // Retain the base too, so later GC/rebases cannot erase review ancestry.
    const commit = (
      await git(
        repository,
        [
          "-c",
          "user.name=Marina candidate",
          "-c",
          "user.email=candidate@marina.invalid",
          "commit-tree",
          tree,
          ...(source.baseCommit ? ["-p", source.baseCommit] : []),
        ],
        "Marina source candidate (not an operator branch)\n",
      )
    ).text.trim();
    const ref = `refs/marina/candidates/${crypto.randomUUID()}`;
    await git(repository, ["update-ref", ref, commit, ""], undefined, index);
    retained = { repository, ref, commit };
    // Separate Git metadata and index; raw files were copied before hashing. No checkout
    // filters, hooks, shared worktree metadata, dependency links or original-index writes.
    const format = (await git(repository, ["rev-parse", "--show-object-format"])).text.trim();
    await git(materialized, ["init", "--quiet", "--template=", `--object-format=${format}`]);
    const objects = (
      await git(repository, ["rev-parse", "--path-format=absolute", "--git-path", "objects"])
    ).text.trim();
    if (/[\r\n]/.test(objects)) throw new Error("Candidate object directory contains a newline.");
    await mkdir(join(materialized, ".git/objects/info"), { recursive: true });
    await writeFile(join(materialized, ".git/objects/info/alternates"), `${objects}\n`);
    if (source.baseCommit) {
      await git(materialized, ["update-ref", "HEAD", source.baseCommit]);
    }
    await git(materialized, ["read-tree", tree]);
    const candidate: CandidateIdentity = {
      version: 1,
      policy: CANDIDATE_POLICY,
      repository,
      baseCommit: source.baseCommit,
      tree,
      commit,
      fingerprint: source.fingerprint,
      ref,
      files: source.entries.length,
      bytes: source.bytes,
      capturedAt: Date.now(),
      exclusions: [
        "Git-ignored untracked files (including dependencies and generated output)",
        "External environment and services are not part of the source identity",
      ],
    };
    return {
      candidate,
      directory: materialized,
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    try {
      if (retained)
        await git(retained.repository, ["update-ref", "-d", retained.ref, retained.commit]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
