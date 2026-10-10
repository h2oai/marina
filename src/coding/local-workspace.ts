// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { captureGitCandidate } from "./candidate";
import { prepareCandidateBunDependencies } from "./candidate-dependencies";
import type { ExecApprover } from "./exec-approver";
import { CODE_RUN_HOME, hostGitArgv, hostGitEnv, isGitArgv } from "./host-git";
import { preparationStepKind } from "./verification-plan";

const DEFAULT_MAX_READ_BYTES = 64 * 1024;
const DEFAULT_MAX_LIST_ENTRIES = 200;
const DEFAULT_MAX_SEARCH_RESULTS = 80;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const MAX_RUN_TIMEOUT_MS = 300_000;

const SKIP_DIRS = new Set([".git", ".turbo", ".vite", "coverage", "dist", "node_modules", "tmp"]);
const SHELL_METACHARACTERS = /[;&|`$()><\n\r\\]/;
const CODE_RUN_BUN_SCRIPTS = new Set(["build", "dashboard:build", "lint", "test", "typecheck"]);
const CODE_RUN_GIT_COMMANDS = new Set([
  "branch --show-current",
  "diff --check",
  "diff --cached --check",
  "diff --cached --name-only",
  "diff --cached --stat",
  "diff --name-only",
  "diff --stat",
  "log --oneline -5",
  "ls-files",
  "rev-parse --show-toplevel",
  "status",
  "status --porcelain",
  "status --short",
]);
// Per-session worktree isolation adds exactly these git verbs to the controlled
// exec surface (see src/coding/worktree.ts). `add`/`remove` take dynamic args, so
// they are validated structurally below rather than by exact-string match; the
// managed-path invariant (must live under ~/.marina/worktrees) is enforced by the
// caller before deletion — this layer only bounds the shape of the argv.
const CODE_RUN_GIT_WORKTREE_SUBCOMMANDS = new Set(["add", "list", "prune", "remove"]);
const WORKTREE_MANAGED_BRANCH = /^marina\/session-[A-Za-z0-9._-]+$/;
const CODE_RUN_ENV: Record<string, string> = {
  TERM: "dumb",
  LANG: "en_US.UTF-8",
  CI: "1",
};

export interface WorkspaceEntry {
  path: string;
  type: "file" | "dir" | "other";
  size: number;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface PatchCheck {
  ok: boolean;
  paths: string[];
  output: string;
}

export interface WorkspaceRunResult {
  command: string[];
  exitCode: number;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface CodeRunPolicy {
  bunScripts: string[];
  commands: string[];
  gitCommands: string[];
  timeoutMs: number;
}

export type WorkspaceCapability =
  | "files"
  | "patches"
  | "finite-exec"
  | "processes"
  | "publish"
  | "hibernate"
  | "capture";

export interface WorkspaceDescriptor {
  target: "local" | "flywheel";
  persistence: "host" | "durable-sandbox";
  capabilities: WorkspaceCapability[];
  /** Present when finite commands run inside a container instead of on the host. */
  runner?: { kind: "container"; runtime: string; image: string; sync: "mount" | "patch" };
}

/**
 * Host-side filesystem surface of a workspace. These operations read/mutate the
 * workspace tree directly; for a sandboxed runtime they stay host-side over the
 * shared mount (virtio-fs) rather than crossing into the guest — see
 * the host/guest split protocol.
 */
export interface WorkspaceFiles {
  displayRoot(): string;
  list(input?: string, limit?: number): WorkspaceEntry[];
  read(
    input: string,
    maxBytes?: number,
  ): Promise<{ path: string; content: string; truncated: boolean; size: number }>;
  search(query: string, limit?: number, path?: string): Promise<SearchHit[]>;
  diff(
    input?: string,
    maxBytes?: number,
  ): Promise<{ content: string; truncated: boolean; exitCode: number }>;
  checkPatch(patch: string): Promise<PatchCheck>;
  applyPatch(patch: string): Promise<PatchCheck>;
  editFile(
    path: string,
    oldText: string,
    newText: string,
    opts?: { replaceAll?: boolean },
  ): Promise<{ ok: boolean; output: string; occurrences: number }>;
  writeFile(
    path: string,
    content: string,
  ): Promise<{ ok: boolean; output: string; created: boolean }>;
  reversePatch(patch: string, checkOnly?: boolean): Promise<PatchCheck>;
}

/**
 * Command-execution surface of a workspace. This is the part a sandboxed runtime
 * sends across the guest boundary; the local runtime runs it on the host.
 */
export interface WorkspaceExec {
  captureCandidate?(
    repository?: string,
    beforeCapture?: () => void,
  ): ReturnType<typeof captureGitCandidate>;
  run(command: string[], timeoutMs?: number, maxBytes?: number): Promise<WorkspaceRunResult>;
  /** Finite background checks never consult an interactive or ambient exec approver.
   * Revalidate authority inside the root lock, immediately before spawning. */
  runAllowlisted?(
    command: string[],
    beforeSpawn: () => void,
    timeoutMs?: number,
  ): Promise<WorkspaceRunResult>;
  /** Paths changed against HEAD (tracked, staged and untracked), for verification scoping. */
  changedPaths?(): Promise<string[]>;
  /**
   * Run one fixed verification-preparation argv from the closed table in
   * `verification-plan.ts`: an environment probe anywhere, a dependency install
   * only where `installsPermitted()`. Never a caller-supplied command.
   */
  runPreparationStep?(argv: string[], beforeSpawn?: () => void): Promise<WorkspaceRunResult>;
  /** Whether a dependency install may run here: an isolated runner that persists it, with network. */
  installsPermitted?(): boolean;
  runPolicy(): CodeRunPolicy;
  describe(): WorkspaceDescriptor;
  /**
   * Attach an optional per-call exec approver consulted only for commands that
   * fall off the allowlist. Passing `undefined` clears it (allowlist-only,
   * byte-identical to the default). Not all runtimes support this.
   */
  attachExecApprover?(approver: ExecApprover | undefined, entityId: string): void;
  /**
   * Forbid ALL host-process spawning for this workspace instance. Set true for a
   * telnet-origin caller so no code subcommand — enumerated or not — can reach a
   * subprocess. The guarantee is enforced at the two spawn primitives, so it
   * covers every path by construction rather than an enumerated subcommand list.
   */
  setHostExecForbidden?(forbidden: boolean): void;
}

/**
 * Thrown by the spawn chokepoint when a host-exec-forbidden workspace (a
 * telnet-origin caller) attempts to launch any subprocess. Fail-closed backstop
 * behind the friendly early subcommand-level deny in the `code` command.
 */
export class HostExecForbiddenError extends Error {
  constructor() {
    super(
      "Host execution is not available for this caller (telnet-origin, plaintext/unauthenticated).",
    );
    this.name = "HostExecForbiddenError";
  }
}

function assertHostExecAllowed(hostExecForbidden: boolean): void {
  if (hostExecForbidden) throw new HostExecForbiddenError();
}

/**
 * The full workspace contract consumed by the `code` command. `LocalWorkspace`
 * is the default (host-process) implementation; future sandboxed runtimes
 * implement the same contract (overriding exec, delegating files to the share).
 */
export type WorkspaceRuntime = WorkspaceFiles & WorkspaceExec;

// Serialize mutating git/run operations per workspace root. Two concurrent
// `code apply` commands (or apply + run) from the same write-lock holder would
// otherwise launch overlapping `git apply` / build processes against one
// working tree + index — an index.lock collision / partial-apply. Keyed by the
// realpath root so it holds even across separate LocalWorkspace instances.
const rootLocks = new Map<string, Promise<unknown>>();
function withRootLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = rootLocks.get(root) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run after the prior op settles (either way)
  // Store a rejection-swallowed tail so one failure can't break the chain.
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  rootLocks.set(root, tail);
  void tail.then(() => {
    // Snapshot roots are disposable. Drop only our idle tail, never a queued successor.
    if (rootLocks.get(root) === tail) rootLocks.delete(root);
  });
  return next;
}

export class LocalWorkspace implements WorkspaceRuntime {
  readonly root: string;
  private execApprover?: ExecApprover;
  private execApproverEntityId?: string;
  protected hostExecForbidden = false;

  constructor(root = process.cwd()) {
    this.root = realpathSync(root);
  }

  captureCandidate(
    repository?: string,
    beforeCapture?: () => void,
  ): ReturnType<typeof captureGitCandidate> {
    assertHostExecAllowed(this.hostExecForbidden);
    return withRootLock(this.root, () => {
      assertHostExecAllowed(this.hostExecForbidden);
      beforeCapture?.();
      return captureGitCandidate(this.root, repository);
    });
  }

  attachExecApprover(approver: ExecApprover | undefined, entityId: string): void {
    this.execApprover = approver;
    this.execApproverEntityId = entityId;
  }

  setHostExecForbidden(forbidden: boolean): void {
    this.hostExecForbidden = forbidden;
  }

  displayRoot(): string {
    return this.root;
  }

  describe(): WorkspaceDescriptor {
    return {
      target: "local",
      persistence: "host",
      capabilities: ["files", "patches", "finite-exec"],
    };
  }

  resolvePath(input = "."): string {
    const rel = input.trim() || ".";
    if (rel.startsWith("/") || rel.includes("\0")) {
      throw new Error("Use a relative path inside the workspace.");
    }
    const target = realpathMaybe(resolve(this.root, rel));
    if (!isInside(this.root, target)) {
      throw new Error("Path escapes the workspace root.");
    }
    return target;
  }

  relativePath(abs: string): string {
    const rel = relative(this.root, abs);
    return rel === "" ? "." : rel.split(sep).join("/");
  }

  list(input = ".", limit = DEFAULT_MAX_LIST_ENTRIES): WorkspaceEntry[] {
    const target = this.resolvePath(input);
    const stat = statSync(target);
    if (!stat.isDirectory()) {
      return [entryFor(this.root, target, stat)];
    }
    // An entry can vanish between readdir and stat (a SQLite -shm/-wal file,
    // an editor swap file); skip it rather than failing the whole listing.
    return readdirSync(target)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, limit)
      .flatMap((name) => {
        const path = join(target, name);
        const entry = statSync(path, { throwIfNoEntry: false });
        return entry ? [entryFor(this.root, path, entry)] : [];
      });
  }

  async read(
    input: string,
    maxBytes = DEFAULT_MAX_READ_BYTES,
  ): Promise<{
    path: string;
    content: string;
    truncated: boolean;
    size: number;
  }> {
    const target = this.resolvePath(input);
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error("Path is not a file.");
    const file = Bun.file(target);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const slice = bytes.byteLength > maxBytes ? bytes.slice(0, maxBytes) : bytes;
    return {
      path: this.relativePath(target),
      content: new TextDecoder("utf-8", { fatal: false }).decode(slice),
      truncated: bytes.byteLength > maxBytes,
      size: bytes.byteLength,
    };
  }

  async search(
    query: string,
    limit = DEFAULT_MAX_SEARCH_RESULTS,
    path = ".",
  ): Promise<SearchHit[]> {
    const needle = query.trim();
    if (!needle) return [];

    const target = this.resolvePath(path);
    const scopedPath = this.relativePath(target);
    const rgHits = await this.searchWithRg(needle, limit, scopedPath);
    if (rgHits) return rgHits;

    const hits: SearchHit[] = [];
    const visit = async (path: string) => {
      if (hits.length >= limit) return;
      const file = Bun.file(path);
      const text = await file.text().catch(() => "");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        const line = lines[i]!;
        if (line.toLowerCase().includes(needle.toLowerCase())) {
          hits.push({ path: this.relativePath(path), line: i + 1, text: line.trimEnd() });
        }
      }
    };
    if (statSync(target).isDirectory()) await this.walkTextFiles(target, visit);
    else await visit(target);
    return hits;
  }

  async diff(
    input?: string,
    maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
  ): Promise<{
    content: string;
    truncated: boolean;
    exitCode: number;
    totalBytes?: number;
  }> {
    const args = ["diff", "--"];
    if (input?.trim()) {
      const target = this.resolvePath(input);
      args.push(this.relativePath(target));
    }
    const result = await runCapture(["git", ...args], this.root, maxBytes, this.hostExecForbidden);
    return result;
  }

  async checkPatch(patch: string): Promise<PatchCheck> {
    const paths = validatePatchPaths(this.root, patch);
    const result = await runGitApplyResilient(this.root, patch, true, this.hostExecForbidden);
    return {
      ok: result.exitCode === 0,
      paths,
      output: result.content.trim(),
    };
  }

  async applyPatch(patch: string): Promise<PatchCheck> {
    const paths = validatePatchPaths(this.root, patch);
    return withRootLock(this.root, async () => {
      const result = await runGitApplyResilient(this.root, patch, false, this.hostExecForbidden);
      return {
        ok: result.exitCode === 0,
        paths,
        output: result.content.trim(),
      };
    });
  }

  async editFile(
    path: string,
    oldText: string,
    newText: string,
    opts?: { replaceAll?: boolean },
  ): Promise<{ ok: boolean; output: string; occurrences: number }> {
    const target = this.resolvePath(path);
    assertNotGitMetadata(this.root, target);
    const rel = this.relativePath(target);
    if (!oldText) {
      return { ok: false, output: "oldText must be non-empty.", occurrences: 0 };
    }
    return withRootLock(this.root, async () => {
      const stat = statSync(target, { throwIfNoEntry: false });
      if (!stat?.isFile()) {
        return { ok: false, output: `File not found: ${rel}`, occurrences: 0 };
      }
      const bytes = new Uint8Array(await Bun.file(target).arrayBuffer());
      if (bytes.includes(0)) {
        return { ok: false, output: `Not a text file: ${rel}`, occurrences: 0 };
      }
      const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const occurrences = countOccurrences(content, oldText);
      if (occurrences === 0) {
        return {
          ok: false,
          output: `oldText not found in ${rel}. Read the file and copy the exact text, including whitespace and indentation.`,
          occurrences: 0,
        };
      }
      if (occurrences > 1 && !opts?.replaceAll) {
        return {
          ok: false,
          output: `oldText matches ${occurrences} locations in ${rel}. Include more surrounding context to make it unique, or set replaceAll.`,
          occurrences,
        };
      }
      // Splice by index — String.replace would interpret $-patterns in newText.
      const updated = opts?.replaceAll
        ? content.split(oldText).join(newText)
        : spliceFirst(content, oldText, newText);
      writeFileSync(target, updated);
      const n = opts?.replaceAll ? occurrences : 1;
      return {
        ok: true,
        output: `Replaced ${n} occurrence${n === 1 ? "" : "s"} in ${rel}.`,
        occurrences: n,
      };
    });
  }

  async writeFile(
    path: string,
    content: string,
  ): Promise<{ ok: boolean; output: string; created: boolean }> {
    const target = this.resolvePath(path);
    assertNotGitMetadata(this.root, target);
    const rel = this.relativePath(target);
    return withRootLock(this.root, async () => {
      const stat = statSync(target, { throwIfNoEntry: false });
      if (stat?.isDirectory()) {
        return { ok: false, output: `Path is a directory: ${rel}`, created: false };
      }
      if (stat?.isFile()) {
        const bytes = new Uint8Array(await Bun.file(target).arrayBuffer());
        if (bytes.includes(0)) {
          return {
            ok: false,
            output: `Refusing to overwrite a binary file: ${rel}`,
            created: false,
          };
        }
      }
      const created = !stat;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      const bytes = Buffer.byteLength(content, "utf-8");
      return {
        ok: true,
        output: `${created ? "Created" : "Overwrote"} ${rel} (${bytes} bytes).`,
        created,
      };
    });
  }

  async reversePatch(patch: string, checkOnly = false): Promise<PatchCheck> {
    const paths = validatePatchPaths(this.root, patch);
    return withRootLock(this.root, async () => {
      const result = await runGitApply(
        this.root,
        patch,
        checkOnly,
        true,
        [],
        this.hostExecForbidden,
      );
      return {
        ok: result.exitCode === 0,
        paths,
        output: result.content.trim(),
      };
    });
  }

  async run(
    command: string[],
    timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
  ): Promise<WorkspaceRunResult> {
    // Chokepoint (highest precedence): a host-exec-forbidden (telnet-origin)
    // workspace never spawns — not even an allowlisted command, and never
    // reaching the approver prompt. Backstop behind the friendly early deny.
    assertHostExecAllowed(this.hostExecForbidden);
    // 1) On the allowlist → run unchanged. 2) Off the allowlist but an approver
    // is attached AND approves → run the arbitrary argv, still under the same
    // residual guards (scrubbed env, cwd pinned to root, 300s cap, output cap,
    // per-root lock). 3) Otherwise → throw the existing allowlist error,
    // byte-identical to today. With no approver attached, (2) is unreachable.
    let normalized: string[];
    try {
      normalized = normalizeAllowedCodeCommand(this.root, command);
    } catch (allowlistErr) {
      const argv = command.map((part) => part.trim()).filter(Boolean);
      if (this.execApprover && this.execApproverEntityId !== undefined && argv.length > 0) {
        const decision = await this.execApprover.requestApproval({
          argv,
          cwd: this.root,
          entityId: this.execApproverEntityId,
        });
        if (!decision.approved) throw allowlistErr;
        normalized = argv;
      } else {
        throw allowlistErr;
      }
    }
    return this.runNormalized(normalized, timeoutMs, maxBytes);
  }

  async runAllowlisted(
    command: string[],
    beforeSpawn: () => void,
    timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  ): Promise<WorkspaceRunResult> {
    assertHostExecAllowed(this.hostExecForbidden);
    const normalized = normalizeAllowedCodeCommand(this.root, command);
    return this.runNormalized(normalized, timeoutMs, DEFAULT_MAX_OUTPUT_BYTES, beforeSpawn);
  }

  async changedPaths(): Promise<string[]> {
    assertHostExecAllowed(this.hostExecForbidden);
    const out = new Set<string>();
    const head = await runCapture(
      ["git", "diff", "--name-only", "--no-renames", "HEAD", "--"],
      this.root,
      256 * 1024,
      this.hostExecForbidden,
    );
    // An unborn branch has no HEAD: fall back to the index.
    const tracked =
      head.exitCode === 0
        ? head
        : await runCapture(
            ["git", "diff", "--name-only", "--no-renames", "--cached", "--"],
            this.root,
            256 * 1024,
            this.hostExecForbidden,
          );
    if (tracked.exitCode !== 0) throw new Error("git diff --name-only failed.");
    const untracked = await runCapture(
      ["git", "ls-files", "--others", "--exclude-standard"],
      this.root,
      256 * 1024,
      this.hostExecForbidden,
    );
    for (const line of `${tracked.content}\n${untracked.exitCode === 0 ? untracked.content : ""}`.split(
      "\n",
    ))
      if (line.trim()) out.add(line.trim());
    return [...out];
  }

  /** Host workspaces never install dependencies here; only the hardened Bun candidate path does. */
  installsPermitted(): boolean {
    return false;
  }

  async runPreparationStep(argv: string[], beforeSpawn?: () => void): Promise<WorkspaceRunResult> {
    assertHostExecAllowed(this.hostExecForbidden);
    const kind = preparationStepKind(argv);
    if (!kind) throw new Error(`Not a verification preparation step: ${argv.join(" ")}`);
    if (kind === "install" && !this.installsPermitted())
      throw new Error("Dependency installation is not permitted in this workspace runner.");
    return this.runNormalized(
      [...argv],
      kind === "install" ? MAX_RUN_TIMEOUT_MS : 60_000,
      DEFAULT_MAX_OUTPUT_BYTES,
      beforeSpawn,
    );
  }

  /** Fixed opt-in preparation for a disposable candidate; never widens code run's allowlist. */
  prepareCandidateDependencies(beforeSpawn: () => void) {
    assertHostExecAllowed(this.hostExecForbidden);
    return withRootLock(this.root, () => {
      assertHostExecAllowed(this.hostExecForbidden);
      beforeSpawn();
      return prepareCandidateBunDependencies(this.root, async (command, environment) => {
        beforeSpawn();
        const started = Date.now();
        const result = await runWorkspaceCommand(
          command,
          this.root,
          DEFAULT_RUN_TIMEOUT_MS,
          DEFAULT_MAX_OUTPUT_BYTES,
          this.hostExecForbidden,
          environment,
        );
        return { ...result, command, durationMs: Date.now() - started };
      });
    });
  }

  private runNormalized(
    normalized: string[],
    timeoutMs: number,
    maxBytes: number,
    beforeSpawn?: () => void,
  ): Promise<WorkspaceRunResult> {
    return withRootLock(this.root, async () => {
      beforeSpawn?.();
      const started = Date.now();
      const result = await this.spawnNormalized(normalized, timeoutMs, maxBytes);
      return { ...result, command: normalized, durationMs: Math.max(0, Date.now() - started) };
    });
  }

  /**
   * The single spawn step behind `run` / `runAllowlisted`, called inside the
   * per-root lock AFTER allowlist/approver validation. A runtime that executes
   * elsewhere (a container) overrides only this; validation, the approver, the
   * host-exec chokepoint and the lock stay inherited.
   */
  protected spawnNormalized(
    normalized: string[],
    timeoutMs: number,
    maxBytes: number,
  ): Promise<Omit<WorkspaceRunResult, "command" | "durationMs">> {
    return runWorkspaceCommand(
      normalized,
      this.root,
      Math.min(timeoutMs, MAX_RUN_TIMEOUT_MS),
      maxBytes,
      this.hostExecForbidden,
    );
  }

  runPolicy(): CodeRunPolicy {
    return codeRunPolicy();
  }

  private async searchWithRg(
    query: string,
    limit: number,
    path: string,
  ): Promise<SearchHit[] | null> {
    const result = await runCapture(
      [
        "rg",
        "--with-filename",
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--",
        query,
        path,
      ],
      this.root,
      DEFAULT_MAX_OUTPUT_BYTES,
      this.hostExecForbidden,
    );
    if (result.exitCode > 1) return null;
    const hits: SearchHit[] = [];
    for (const line of result.content.split("\n")) {
      if (!line || hits.length >= limit) break;
      const first = line.indexOf(":");
      const second = first >= 0 ? line.indexOf(":", first + 1) : -1;
      if (first < 0 || second < 0) continue;
      const path = line.slice(0, first).replace(/^\.\//, "");
      const lineNo = Number.parseInt(line.slice(first + 1, second), 10);
      hits.push({ path, line: lineNo, text: line.slice(second + 1).trimEnd() });
    }
    return hits;
  }

  private async walkTextFiles(dir: string, visit: (path: string) => Promise<void>): Promise<void> {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) continue; // removed mid-walk
      if (stat.isSymbolicLink()) continue; // Match rg's no-follow traversal.
      if (stat.isDirectory()) {
        await this.walkTextFiles(path, visit);
      } else if (stat.isFile() && stat.size <= DEFAULT_MAX_READ_BYTES && looksTextual(name)) {
        await visit(path);
      }
    }
  }
}

export function codeRunPolicy(): CodeRunPolicy {
  const bunScripts = [...CODE_RUN_BUN_SCRIPTS].sort((a, b) => a.localeCompare(b));
  const gitCommands = [...CODE_RUN_GIT_COMMANDS].sort((a, b) => a.localeCompare(b));
  return {
    bunScripts,
    gitCommands,
    commands: [
      ...bunScripts.map((script) => `bun run ${script}`),
      "bun test [relative-test-path...]",
      "python -m pytest [relative-path|node-id...] [-q|-x|-v]",
      "python manage.py test [labels...]",
      "python tests/runtests.py [labels...]",
      "bun|npm|pnpm|yarn run test [--] [relative-test-path...]",
      ...["npm", "pnpm", "yarn"].flatMap((pm) => bunScripts.map((script) => `${pm} run ${script}`)),
      "python -m mypy [relative-path...]",
      "pyright [relative-path...]",
      "npx --no-install tsc --noEmit [-p tsconfig]",
      "uv run --frozen --no-sync <allowed python command>",
      "mvn -B -q test [-Dtest=Class,...]",
      "gradle test -q [--tests Class...]",
      "cargo test [filter]",
      "go test ./... [-count=N|-short|-v]",
      ...gitCommands.map((cmd) => `git ${cmd}`),
    ],
    timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
  };
}

function realpathMaybe(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function entryFor(root: string, path: string, stat: Stats): WorkspaceEntry {
  return {
    path: relative(root, path).split(sep).join("/") || ".",
    type: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
    size: Number(stat.size),
  };
}

function looksTextual(name: string): boolean {
  return /\.(astro|css|csv|go|html|json|js|jsx|md|mjs|py|rs|sql|toml|ts|tsx|txt|yaml|yml)$/i.test(
    name,
  );
}

function assertNotGitMetadata(root: string, target: string): void {
  const rel = relative(root, target).split(sep).join("/");
  if (rel === ".git" || rel.startsWith(".git/")) {
    throw new Error("Refusing to modify .git metadata.");
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function spliceFirst(content: string, oldText: string, newText: string): string {
  const idx = content.indexOf(oldText);
  return content.slice(0, idx) + newText + content.slice(idx + oldText.length);
}

function validatePatchPaths(root: string, patch: string): string[] {
  const paths = extractPatchPaths(patch);
  if (paths.length === 0) {
    throw new Error("Patch must be a unified diff with file paths.");
  }
  for (const path of paths) {
    if (path.startsWith("/") || path.includes("\0")) {
      throw new Error(`Patch path is not relative: ${path}`);
    }
    if (path === ".git" || path.startsWith(".git/")) {
      throw new Error("Patch may not modify .git metadata.");
    }
    const target = realpathMaybe(resolve(root, path));
    if (!isInside(root, target)) {
      throw new Error(`Patch path escapes the workspace root: ${path}`);
    }
  }
  return paths;
}

export function normalizeAllowedCodeCommand(root: string, command: string[]): string[] {
  const [binary, ...args] = command.map((part) => part.trim()).filter(Boolean);
  if (!binary) {
    throw new Error("Usage: code run <allowed command>");
  }
  if (binary.includes("/") || binary.includes("\\")) {
    throw new Error("Binary paths are not allowed. Use the binary name only.");
  }
  for (const arg of args) {
    if (SHELL_METACHARACTERS.test(arg)) {
      throw new Error(`Shell metacharacters are not allowed in arguments: ${arg}`);
    }
  }

  if (binary === "bun") {
    return normalizeBunCommand(root, args);
  }
  if (binary === "git") {
    return normalizeGitCommand(args);
  }
  if (binary === "npm" || binary === "pnpm" || binary === "yarn") {
    return normalizePackageScriptCommand(root, binary, args);
  }
  if (binary === "uv") {
    // `uv run --frozen --no-sync <allowlisted python check>`: the project's own
    // environment, never a sync or an arbitrary program.
    if (args[0] !== "run" || args[1] !== "--frozen" || args[2] !== "--no-sync")
      throw new Error('Allowed uv command: "uv run --frozen --no-sync python -m pytest [paths]".');
    const wrapped = normalizeTestRunnerCommand(root, args[3] ?? "", args.slice(4));
    if (!wrapped || (wrapped[0] !== "python" && wrapped[0] !== "python3"))
      throw new Error("uv run wraps an allowed python test or type-check command only.");
    return ["uv", "run", "--frozen", "--no-sync", ...wrapped];
  }
  const testRunner = normalizeTestRunnerCommand(root, binary, args);
  if (testRunner) return testRunner;

  throw new Error(
    'Command is not allowed. Try "code run typecheck", "code run lint", "code run test", "code run bun test test/file.test.ts", "code run python -m pytest tests/", or "code run git status --short".',
  );
}

// Detected test runners for non-JavaScript projects (src/coding/project-detection.ts).
// Like `bun run test`, a project's own test suite executes repository code, so
// these join the allowlist only in fixed shapes: a known binary, a test verb,
// relative selectors that stay inside the workspace, and a few inert flags.
// Nothing here accepts an arbitrary script, an absolute path, or a shell.
const PYTEST_FLAGS = new Set(["-q", "-x", "-v", "-rA", "--no-header", "--tb=short", "--tb=line"]);
const PYTEST_SELECTOR = /^[A-Za-z0-9_./-]+(::[A-Za-z0-9_.[\]-]+)*$/;
const DJANGO_LABEL = /^[A-Za-z0-9_.]+$/;
const DJANGO_FLAG = /^--(verbosity|parallel)=[0-9]{1,2}$/;
const CARGO_FILTER = /^[A-Za-z0-9_:]+$/;
const GO_PACKAGE = /^\.\/([A-Za-z0-9_.-]+\/)*(\.\.\.|[A-Za-z0-9_.-]*)$/;
const GO_FLAG = /^-(count=[0-9]{1,3}|short|v)$/;

function normalizeTestRunnerCommand(root: string, binary: string, args: string[]): string[] | null {
  if (binary === "python" || binary === "python3") {
    if (args[0] === "-m" && args[1] === "pytest") {
      return [binary, "-m", "pytest", ...pytestArgs(root, args.slice(2))];
    }
    if (args[0] === "manage.py" && args[1] === "test") {
      validateRelativeRunPath(root, "manage.py");
      return [binary, "manage.py", "test", ...djangoArgs(args.slice(2))];
    }
    if (args[0] && /(^|\/)runtests\.py$/.test(args[0])) {
      validateRelativeRunPath(root, args[0]);
      if (!existsSync(resolve(root, args[0]))) throw new Error(`No such test runner: ${args[0]}`);
      return [binary, args[0], ...djangoArgs(args.slice(1))];
    }
    if (args[0] === "-m" && args[1] === "mypy") {
      return [binary, "-m", "mypy", ...relativePathArgs(root, args.slice(2), "mypy")];
    }
    throw new Error(
      'Allowed python commands: "python -m pytest [paths]", "python manage.py test [labels]", "python tests/runtests.py [labels]", "python -m mypy [paths]".',
    );
  }
  if (binary === "pyright") {
    return ["pyright", ...relativePathArgs(root, args, "pyright")];
  }
  if (binary === "npx") {
    // The project's own TypeScript compiler, never a download (`--no-install`).
    const [noInstall, tsc, noEmit, ...rest] = args;
    if (noInstall !== "--no-install" || tsc !== "tsc" || noEmit !== "--noEmit")
      throw new Error('Allowed npx command: "npx --no-install tsc --noEmit [-p <tsconfig>]".');
    if (rest.length === 0) return ["npx", "--no-install", "tsc", "--noEmit"];
    if (rest.length === 2 && rest[0] === "-p") {
      validateRelativeRunPath(root, rest[1]!);
      return ["npx", "--no-install", "tsc", "--noEmit", "-p", rest[1]!];
    }
    throw new Error('Allowed npx command: "npx --no-install tsc --noEmit [-p <tsconfig>]".');
  }
  if (binary === "mvn") {
    const [batch, quiet, verb, ...rest] = args;
    if (batch !== "-B" || quiet !== "-q" || verb !== "test")
      throw new Error('Allowed mvn command: "mvn -B -q test [-Dtest=Name,...]".');
    if (rest.length === 0) return ["mvn", "-B", "-q", "test"];
    if (rest.length === 1 && JAVA_TEST_SELECTION.test(rest[0]!))
      return ["mvn", "-B", "-q", "test", rest[0]!];
    throw new Error("mvn test accepts one -Dtest=<Class>[,<Class>...] selector.");
  }
  if (binary === "gradle") {
    if (args[0] !== "test" || args[1] !== "-q")
      throw new Error('Allowed gradle command: "gradle test -q [--tests Name ...]".');
    const rest = args.slice(2);
    for (let i = 0; i < rest.length; i += 2) {
      if (rest[i] !== "--tests" || !JAVA_TEST_NAME.test(rest[i + 1] ?? ""))
        throw new Error("gradle test accepts --tests <Class> selectors only.");
    }
    return ["gradle", "test", "-q", ...rest];
  }
  if (binary === "cargo") {
    if (args[0] !== "test") throw new Error('Allowed cargo command: "cargo test [filter]".');
    const rest = args.slice(1);
    for (const arg of rest) {
      if (arg !== "--quiet" && !CARGO_FILTER.test(arg))
        throw new Error(`cargo test accepts --quiet and a test-name filter only: ${arg}`);
    }
    return ["cargo", "test", ...rest];
  }
  if (binary === "go") {
    if (args[0] !== "test") throw new Error('Allowed go command: "go test ./...".');
    const rest = args.slice(1);
    if (rest.length === 0) throw new Error('go test needs a package pattern, e.g. "./...".');
    for (const arg of rest) {
      if (!GO_PACKAGE.test(arg) && !GO_FLAG.test(arg))
        throw new Error(`go test accepts relative package patterns and -count/-short/-v: ${arg}`);
    }
    return ["go", "test", ...rest];
  }
  return null;
}

function pytestArgs(root: string, args: string[]): string[] {
  for (const arg of args) {
    if (PYTEST_FLAGS.has(arg)) continue;
    if (!PYTEST_SELECTOR.test(arg))
      throw new Error(`pytest accepts relative test paths, node ids and -q/-x/-v: ${arg}`);
    validateRelativeRunPath(root, arg.split("::")[0]!);
  }
  return args;
}

const JAVA_TEST_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JAVA_TEST_SELECTION = /^-Dtest=[A-Za-z_][A-Za-z0-9_]*(,[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Relative, in-workspace path arguments (no flags) for a fixed checker command. */
function relativePathArgs(root: string, args: string[], tool: string): string[] {
  for (const arg of args) {
    if (arg.startsWith("-") || !PYTEST_SELECTOR.test(arg) || arg.includes("::"))
      throw new Error(`${tool} accepts relative paths only: ${arg}`);
    validateRelativeRunPath(root, arg);
  }
  return args;
}

/**
 * `npm|pnpm|yarn run <script>` for the same fixed script names as `bun run`,
 * plus `run test [--] <relative test paths>` so verification can scope a run to
 * the tests relevant to a change. The script itself is the project's own, as
 * with `bun run test`.
 */
function normalizePackageScriptCommand(root: string, binary: string, args: string[]): string[] {
  if (args[0] !== "run" || !args[1] || !CODE_RUN_BUN_SCRIPTS.has(args[1]))
    throw new Error(
      `Allowed ${binary} commands: ${[...CODE_RUN_BUN_SCRIPTS]
        .sort((a, b) => a.localeCompare(b))
        .map((script) => `${binary} run ${script}`)
        .join(", ")}, ${binary} run test [--] [relative-test-path...]`,
    );
  if (args.length === 2) return [binary, "run", args[1]];
  return [binary, "run", "test", ...scopedTestPaths(root, args[1], args.slice(2))];
}

function scopedTestPaths(root: string, script: string, rest: string[]): string[] {
  if (script !== "test") throw new Error("Only the test script accepts test paths.");
  const paths = rest[0] === "--" ? rest.slice(1) : rest;
  if (paths.length === 0) throw new Error("Expected relative test paths after the test script.");
  for (const path of paths) {
    if (path.startsWith("-")) throw new Error(`Test paths must be relative paths: ${path}`);
    validateRelativeRunPath(root, path);
  }
  return rest[0] === "--" ? ["--", ...paths] : paths;
}

function djangoArgs(args: string[]): string[] {
  for (const arg of args) {
    if (!DJANGO_LABEL.test(arg) && !DJANGO_FLAG.test(arg))
      throw new Error(`Django test labels are dotted module names: ${arg}`);
  }
  return args;
}

function normalizeBunCommand(root: string, args: string[]): string[] {
  if (args[0] === "run" && args[1] === "test" && args.length > 2) {
    return ["bun", "run", "test", ...scopedTestPaths(root, "test", args.slice(2))];
  }
  if (args[0] === "run") {
    const script = args[1];
    if (!script || !CODE_RUN_BUN_SCRIPTS.has(script) || args.length !== 2) {
      throw new Error(
        `Allowed bun scripts: ${[...CODE_RUN_BUN_SCRIPTS].sort((a, b) => a.localeCompare(b)).join(", ")}`,
      );
    }
    return ["bun", "run", script];
  }

  if (args[0] === "test") {
    for (const arg of args.slice(1)) {
      if (arg.startsWith("-")) {
        throw new Error("code run bun test only accepts relative test paths in this local mode.");
      }
      validateRelativeRunPath(root, arg);
    }
    return ["bun", ...args];
  }

  throw new Error(
    'Allowed bun commands: "bun run <script>" or "bun test [relative-test-path...]".',
  );
}

function normalizeGitCommand(args: string[]): string[] {
  if (args[0] === "worktree") {
    return normalizeGitWorktreeCommand(args);
  }
  const key = args.join(" ");
  if (!CODE_RUN_GIT_COMMANDS.has(key)) {
    throw new Error(
      `Allowed git commands: ${[...CODE_RUN_GIT_COMMANDS]
        .sort((a, b) => a.localeCompare(b))
        .map((cmd) => `git ${cmd}`)
        .join(", ")}`,
    );
  }
  return ["git", ...args];
}

// Marina-managed worktree git verbs. Shapes accepted (nothing else):
//   git worktree list [--porcelain]
//   git worktree prune
//   git worktree add -b marina/session-<id> <absolute-path> <ref>
//   git worktree remove [--force] <absolute-path>
// SHELL_METACHARACTERS were already rejected upstream, so args here are inert
// tokens; we still bound branch names, ref shape, and require absolute, ".."-free
// paths. The absolute path is intentionally OUTSIDE the repo root (a worktree is),
// so the usual in-root confinement doesn't apply — the caller confines it to the
// managed dir before it ever asks to delete one.
function normalizeGitWorktreeCommand(args: string[]): string[] {
  const sub = args[1];
  if (!sub || !CODE_RUN_GIT_WORKTREE_SUBCOMMANDS.has(sub)) {
    throw new Error("Allowed git worktree subcommands: add, list, prune, remove.");
  }
  const rest = args.slice(2);
  if (sub === "list") {
    if (rest.length === 0) return ["git", "worktree", "list"];
    if (rest.length === 1 && rest[0] === "--porcelain") {
      return ["git", "worktree", "list", "--porcelain"];
    }
    throw new Error("Allowed: git worktree list [--porcelain].");
  }
  if (sub === "prune") {
    if (rest.length !== 0) throw new Error("git worktree prune takes no arguments.");
    return ["git", "worktree", "prune"];
  }
  if (sub === "add") {
    if (rest[0] !== "-b" || rest.length !== 4) {
      throw new Error("Allowed: git worktree add -b <marina/session-branch> <path> <ref>.");
    }
    const [, branch, path, ref] = rest as [string, string, string, string];
    assertManagedWorktreeBranch(branch);
    assertAbsoluteWorktreePath(path);
    assertGitRef(ref);
    return ["git", "worktree", "add", "-b", branch, path, ref];
  }
  // remove
  const force = rest[0] === "--force";
  const pathArgs = force ? rest.slice(1) : rest;
  if (pathArgs.length !== 1) {
    throw new Error("Allowed: git worktree remove [--force] <path>.");
  }
  assertAbsoluteWorktreePath(pathArgs[0]);
  return force
    ? ["git", "worktree", "remove", "--force", pathArgs[0]!]
    : ["git", "worktree", "remove", pathArgs[0]!];
}

function assertManagedWorktreeBranch(branch: string | undefined): void {
  if (!branch || !WORKTREE_MANAGED_BRANCH.test(branch)) {
    throw new Error("git worktree add only creates marina/session-* branches.");
  }
}

function assertAbsoluteWorktreePath(path: string | undefined): void {
  if (!path?.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) {
    throw new Error(`Worktree path must be an absolute path without "..": ${path}`);
  }
}

function assertGitRef(ref: string | undefined): void {
  // Reject a leading '-' so an option-shaped ref (e.g. "--lock") can never be
  // admitted by the allowlist and parsed by git as a flag rather than a commit.
  if (!ref || ref.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error(`Invalid git ref: ${ref}`);
  }
}

function validateRelativeRunPath(root: string, input: string): void {
  if (!input || input.startsWith("/") || input.includes("\0")) {
    throw new Error(`Run path must be relative: ${input}`);
  }
  const target = realpathMaybe(resolve(root, input));
  if (!isInside(root, target)) {
    throw new Error(`Run path escapes the workspace root: ${input}`);
  }
}

function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const parts = line.split(/\s+/);
      addPatchPath(paths, parts[2]);
      addPatchPath(paths, parts[3]);
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      addPatchPath(paths, line.slice(4).trim().split(/\s+/)[0]);
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

function addPatchPath(paths: Set<string>, raw: string | undefined): void {
  if (!raw || raw === "/dev/null") return;
  let path = raw;
  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  ) {
    path = path.slice(1, -1);
  }
  if (path.startsWith("a/") || path.startsWith("b/")) {
    path = path.slice(2);
  }
  if (path) paths.add(path);
}

async function runGitApply(
  cwd: string,
  patch: string,
  checkOnly: boolean,
  reverse = false,
  extraArgs: string[] = [],
  hostExecForbidden = false,
): Promise<{ content: string; truncated: boolean; exitCode: number }> {
  assertHostExecAllowed(hostExecForbidden); // refuse before writing the temp patch file
  const dir = mkdtempSync(join(tmpdir(), "marina-code-patch-"));
  const patchPath = join(dir, "change.patch");
  try {
    writeFileSync(patchPath, patch);
    const args = ["git", "apply", "--whitespace=nowarn", ...extraArgs];
    if (checkOnly) args.push("--check");
    if (reverse) args.push("--reverse");
    args.push(patchPath);
    return await runCapture(args, cwd, DEFAULT_MAX_OUTPUT_BYTES, hostExecForbidden);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// LLM-generated diffs often carry slightly-wrong hunk line counts, which plain
// `git apply` rejects as "corrupt patch". Retry with --recount -C1 (recompute
// counts, relaxed context), then — for real applies inside a git repo — a final
// --3way merge. The winning mode is appended to output so the trail stays honest.
async function runGitApplyResilient(
  cwd: string,
  patch: string,
  checkOnly: boolean,
  hostExecForbidden = false,
): Promise<{ content: string; truncated: boolean; exitCode: number }> {
  const plain = await runGitApply(cwd, patch, checkOnly, false, [], hostExecForbidden);
  if (plain.exitCode === 0) return plain;

  const recount = await runGitApply(
    cwd,
    patch,
    checkOnly,
    false,
    ["--recount", "-C1"],
    hostExecForbidden,
  );
  if (recount.exitCode === 0) {
    return { ...recount, content: withApplyModeNote(recount.content, "--recount -C1") };
  }

  let triedThreeWay = false;
  if (!checkOnly && existsSync(join(cwd, ".git"))) {
    triedThreeWay = true;
    const threeWay = await runGitApply(cwd, patch, false, false, ["--3way"], hostExecForbidden);
    if (threeWay.exitCode === 0) {
      return { ...threeWay, content: withApplyModeNote(threeWay.content, "--3way") };
    }
  }

  const retries = triedThreeWay ? "--recount -C1 and --3way retries" : "--recount -C1 retry";
  return { ...plain, content: withApplyModeNote(plain.content, undefined, retries) };
}

function withApplyModeNote(content: string, mode?: string, failedRetries?: string): string {
  const note = mode
    ? `(succeeded with git apply ${mode})`
    : `(${failedRetries ?? "retries"} also failed)`;
  return content.trim() ? `${content.trimEnd()}\n${note}` : note;
}

/**
 * Bounded process execution: scrubbed env, output cap, timeout with SIGTERM →
 * SIGKILL escalation, and the host-exec chokepoint. Exported for runtimes that
 * spawn a different front-end process (the container runner) under the same
 * guards; `stdin` feeds a fixed payload (e.g. a patch) without a shell.
 */
export async function runWorkspaceCommand(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
  hostExecForbidden = false,
  environment: Record<string, string> = {},
  stdin?: string,
): Promise<Omit<WorkspaceRunResult, "command" | "durationMs">> {
  assertHostExecAllowed(hostExecForbidden); // chokepoint: telnet-origin never spawns
  mkdirSync(CODE_RUN_HOME, { recursive: true });
  // Host git never honours repository-planted fsmonitor / hooks / diff drivers
  // (src/coding/host-git.ts); everything else gets the scrubbed Code Mode env.
  const git = isGitArgv(cmd);
  const argv = git ? hostGitArgv(cmd) : cmd;
  const env: Record<string, string> = git
    ? hostGitEnv(environment)
    : {
        ...CODE_RUN_ENV,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: CODE_RUN_HOME,
        ...environment,
      };

  let timedOut = false;
  let exitCode = -1;
  let stdout = "";
  let stderr = "";
  let truncated = false;

  try {
    const grouped = process.platform !== "win32";
    const proc = Bun.spawn(argv, {
      cwd,
      env,
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
      detached: grouped,
    });
    const stop = (signal: "SIGTERM" | "SIGKILL") => {
      try {
        if (grouped) process.kill(-proc.pid, signal);
        else proc.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    // Drain concurrently so a verbose installer/check cannot fill a pipe while we
    // wait for exit. Retain bounded bytes even when the child keeps writing.
    const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
    const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        const remaining = Math.max(0, maxBytes - size);
        if (chunk.byteLength > remaining) truncated = true;
        if (remaining) chunks.push(chunk.slice(0, remaining));
        size += Math.min(remaining, chunk.byteLength);
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    const output = Promise.all(readers.map(read));
    const completed = Promise.all([proc.exited, output]);
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      completed,
      new Promise<"timeout">((resolve) => {
        timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (timeoutTimer) clearTimeout(timeoutTimer); // don't leak the timer on the fast-exit path

    if (result === "timeout") {
      timedOut = true;
      stop("SIGTERM");
      // Escalate to SIGKILL if the child ignores/traps SIGTERM and doesn't exit
      // within a short grace window — otherwise `await proc.exited` could hang.
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const exitedInGrace = await Promise.race([
        completed.then(() => true),
        new Promise<boolean>((resolve) => {
          graceTimer = setTimeout(() => resolve(false), 3000);
        }),
      ]);
      if (graceTimer) clearTimeout(graceTimer);
      if (!exitedInGrace) {
        stop("SIGKILL");
        // A host command can deliberately detach descendants. Bound our pipe
        // wait too; this is process lifecycle management, not a security sandbox.
        await Promise.all(readers.map((reader) => reader.cancel().catch(() => {})));
        await proc.exited;
      }
    }

    exitCode = proc.exitCode ?? -1;
    [stdout = "", stderr = ""] = await output;
  } catch (err) {
    stderr = err instanceof Error ? err.message : String(err);
    exitCode = 127;
  }

  const content = stderr.trim() ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
  return {
    exitCode,
    output: content.length > maxBytes ? content.slice(0, maxBytes) : content,
    truncated: truncated || content.length > maxBytes,
    timedOut,
  };
}

/**
 * Capture a short host command's output (git diff, rg) under the host-exec
 * chokepoint. The child never inherits the server environment: git gets the
 * hardened argv and env (src/coding/host-git.ts), anything else the scrubbed
 * Code Mode env plus `environment` (e.g. the container runtime CLI's settings).
 */
export async function runCapture(
  cmd: string[],
  cwd: string,
  maxBytes: number,
  hostExecForbidden = false,
  environment: Record<string, string> = {},
): Promise<{ content: string; truncated: boolean; exitCode: number; totalBytes?: number }> {
  assertHostExecAllowed(hostExecForbidden); // chokepoint: telnet-origin never spawns
  const git = isGitArgv(cmd);
  const argv = git ? hostGitArgv(cmd) : cmd;
  const env: Record<string, string> = git
    ? hostGitEnv(environment)
    : {
        ...CODE_RUN_ENV,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: CODE_RUN_HOME,
        ...environment,
      };
  try {
    const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const content = stderr.trim() ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
    const truncated = content.length > maxBytes;
    return {
      content: truncated ? content.slice(0, maxBytes) : content,
      truncated,
      exitCode,
      // Lets a reader say how much was left out instead of truncating silently.
      ...(truncated ? { totalBytes: Buffer.byteLength(content) } : {}),
    };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      truncated: false,
      exitCode: 127,
    };
  }
}
