// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
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
import { join, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_READ_BYTES = 64 * 1024;
const DEFAULT_MAX_LIST_ENTRIES = 200;
const DEFAULT_MAX_SEARCH_RESULTS = 80;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const MAX_RUN_TIMEOUT_MS = 300_000;
const CODE_RUN_HOME = join(tmpdir(), "marina-code-home");

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
}

/**
 * Host-side filesystem surface of a workspace. These operations read/mutate the
 * workspace tree directly; for a sandboxed runtime they stay host-side over the
 * shared mount (virtio-fs) rather than crossing into the guest — see
 * docs/design/web-coding-guest-agent-protocol.md (host/guest split).
 */
export interface WorkspaceFiles {
  displayRoot(): string;
  list(input?: string, limit?: number): WorkspaceEntry[];
  read(
    input: string,
    maxBytes?: number,
  ): Promise<{ path: string; content: string; truncated: boolean; size: number }>;
  search(query: string, limit?: number): Promise<SearchHit[]>;
  diff(
    input?: string,
    maxBytes?: number,
  ): Promise<{ content: string; truncated: boolean; exitCode: number }>;
  checkPatch(patch: string): Promise<PatchCheck>;
  applyPatch(patch: string): Promise<PatchCheck>;
  reversePatch(patch: string, checkOnly?: boolean): Promise<PatchCheck>;
}

/**
 * Command-execution surface of a workspace. This is the part a sandboxed runtime
 * sends across the guest boundary; the local runtime runs it on the host.
 */
export interface WorkspaceExec {
  run(command: string[], timeoutMs?: number, maxBytes?: number): Promise<WorkspaceRunResult>;
  runPolicy(): CodeRunPolicy;
  describe(): WorkspaceDescriptor;
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
  rootLocks.set(
    root,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export class LocalWorkspace implements WorkspaceRuntime {
  readonly root: string;

  constructor(root = process.cwd()) {
    this.root = realpathSync(root);
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
    return readdirSync(target)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, limit)
      .map((name) => {
        const path = join(target, name);
        return entryFor(this.root, path, statSync(path));
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

  async search(query: string, limit = DEFAULT_MAX_SEARCH_RESULTS): Promise<SearchHit[]> {
    const needle = query.trim();
    if (!needle) return [];

    const rgHits = await this.searchWithRg(needle, limit);
    if (rgHits) return rgHits;

    const hits: SearchHit[] = [];
    await this.walkTextFiles(this.root, async (path) => {
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
    });
    return hits;
  }

  async diff(
    input?: string,
    maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
  ): Promise<{
    content: string;
    truncated: boolean;
    exitCode: number;
  }> {
    const args = ["diff", "--"];
    if (input?.trim()) {
      const target = this.resolvePath(input);
      args.push(this.relativePath(target));
    }
    const result = await runCapture(["git", ...args], this.root, maxBytes);
    return result;
  }

  async checkPatch(patch: string): Promise<PatchCheck> {
    const paths = validatePatchPaths(this.root, patch);
    const result = await runGitApply(this.root, patch, true);
    return {
      ok: result.exitCode === 0,
      paths,
      output: result.content.trim(),
    };
  }

  async applyPatch(patch: string): Promise<PatchCheck> {
    const paths = validatePatchPaths(this.root, patch);
    return withRootLock(this.root, async () => {
      const result = await runGitApply(this.root, patch, false);
      return {
        ok: result.exitCode === 0,
        paths,
        output: result.content.trim(),
      };
    });
  }

  async reversePatch(patch: string, checkOnly = false): Promise<PatchCheck> {
    const paths = validatePatchPaths(this.root, patch);
    return withRootLock(this.root, async () => {
      const result = await runGitApply(this.root, patch, checkOnly, true);
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
    const normalized = normalizeAllowedCodeCommand(this.root, command);
    return withRootLock(this.root, async () => {
      const started = Date.now();
      const result = await runWorkspaceCommand(
        normalized,
        this.root,
        Math.min(timeoutMs, MAX_RUN_TIMEOUT_MS),
        maxBytes,
      );
      return { ...result, command: normalized, durationMs: Math.max(0, Date.now() - started) };
    });
  }

  runPolicy(): CodeRunPolicy {
    return codeRunPolicy();
  }

  private async searchWithRg(query: string, limit: number): Promise<SearchHit[] | null> {
    const result = await runCapture(
      ["rg", "--line-number", "--no-heading", "--color", "never", "--", query, "."],
      this.root,
      DEFAULT_MAX_OUTPUT_BYTES,
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
      const stat = statSync(path);
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

function normalizeAllowedCodeCommand(root: string, command: string[]): string[] {
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

  throw new Error(
    'Command is not allowed. Try "code run typecheck", "code run lint", "code run test", "code run bun test test/file.test.ts", or "code run git status --short".',
  );
}

function normalizeBunCommand(root: string, args: string[]): string[] {
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
): Promise<{ content: string; truncated: boolean; exitCode: number }> {
  const dir = mkdtempSync(join(tmpdir(), "marina-code-patch-"));
  const patchPath = join(dir, "change.patch");
  try {
    writeFileSync(patchPath, patch);
    const args = ["git", "apply", "--whitespace=nowarn"];
    if (checkOnly) args.push("--check");
    if (reverse) args.push("--reverse");
    args.push(patchPath);
    return await runCapture(args, cwd, DEFAULT_MAX_OUTPUT_BYTES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runWorkspaceCommand(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<Omit<WorkspaceRunResult, "command" | "durationMs">> {
  mkdirSync(CODE_RUN_HOME, { recursive: true });
  const env: Record<string, string> = {
    ...CODE_RUN_ENV,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: CODE_RUN_HOME,
  };

  let timedOut = false;
  let exitCode = -1;
  let stdout = "";
  let stderr = "";

  try {
    const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      proc.exited,
      new Promise<"timeout">((resolve) => {
        timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (timeoutTimer) clearTimeout(timeoutTimer); // don't leak the timer on the fast-exit path

    if (result === "timeout") {
      timedOut = true;
      proc.kill(); // SIGTERM
      // Escalate to SIGKILL if the child ignores/traps SIGTERM and doesn't exit
      // within a short grace window — otherwise `await proc.exited` could hang.
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const exitedInGrace = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          graceTimer = setTimeout(() => resolve(false), 3000);
        }),
      ]);
      if (graceTimer) clearTimeout(graceTimer);
      if (!exitedInGrace) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }

    exitCode = proc.exitCode ?? -1;
    stdout = await new Response(proc.stdout).text();
    stderr = await new Response(proc.stderr).text();
  } catch (err) {
    stderr = err instanceof Error ? err.message : String(err);
    exitCode = 127;
  }

  const content = stderr.trim() ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
  return {
    exitCode,
    output: content.length > maxBytes ? content.slice(0, maxBytes) : content,
    truncated: content.length > maxBytes,
    timedOut,
  };
}

async function runCapture(
  cmd: string[],
  cwd: string,
  maxBytes: number,
): Promise<{ content: string; truncated: boolean; exitCode: number }> {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const content = stderr.trim() ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
    return {
      content: content.length > maxBytes ? content.slice(0, maxBytes) : content,
      truncated: content.length > maxBytes,
      exitCode,
    };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      truncated: false,
      exitCode: 127,
    };
  }
}
