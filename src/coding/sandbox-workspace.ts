// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local OS-sandbox Code Mode workspace (bubblewrap). Files stay on the host
 * (the same LocalWorkspace surface: read, search, patch, diff); FINITE
 * COMMANDS run inside a `bwrap` sandbox, and the sandbox — not the argv shape —
 * is the boundary: any command runs, including `sh -c '<line>'` pipelines.
 *
 * Security model (docs/architecture/security.md → "Local sandbox runner"):
 * - Selection is gated like any execution change (`code.exec` at the router,
 *   telnet refused); the telnet host-exec chokepoint still applies to every
 *   spawn (`bwrap` is a host process). `MARINA_CODE_SANDBOX=required` leaves
 *   no in-world way back to the host.
 * - Trusted launchers: `bwrap` and `prlimit` come from fixed absolute paths
 *   (never PATH), must be owned by root or the server user, not group- or
 *   world-writable, and outside the workspace and task roots.
 * - Every namespace unshared (`--unshare-all --unshare-user`, network included:
 *   only a private loopback), nested user namespaces disabled
 *   (`--disable-userns`), `--die-with-parent`, `--new-session` (no TIOCSTI),
 *   `--cap-drop ALL`, a fresh /proc, a minimal /dev, size-capped tmpfs mounts,
 *   and `prlimit` limits on processes, address space, file size and cores.
 * - `--clearenv`, then only the scrubbed Code Mode environment and a scratch
 *   HOME: no API keys, tokens or MARINA_* settings.
 * - The system directories read-only, one by one (never `/` wholesale, so
 *   /run, /var, /home, /root and /mnt are absent: no agent or bus sockets).
 *   The user's home is masked with an empty tmpfs; only the Bun executable is
 *   bound back read-only.
 * - The workspace root read-write; task roots read-only (write grants are
 *   refused); git metadata read-only LAST, so nothing shadows it. A root
 *   without its own `.git`, a nested gitdir, a git config that includes a file
 *   from the work tree, or a root holding the server's own state is refused.
 *   Submodule gitfiles are checked before and after every command.
 * - Content drivers (nbstripout-style filters) and shell-expanded git settings
 *   are supported, not pinned: Marina's own git work that needs a filter runs
 *   inside the sandbox (`stagedEntries`, `diff`), host git never runs any of
 *   them, and the files a session wrote that the person's own git could hand
 *   to them are reported (`gitExposureReport`).
 * - Never a silent host fallback: a missing or untrusted launcher, or a
 *   sandbox that fails to set up, fails the command with a readable error.
 * - No seccomp filter and no CPU limit (bubblewrap has no cgroups).
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CandidateCaptureOptions } from "./candidate";
import { gitMetadataPaths } from "./container-workspace";
import { gitConfigEnv, hostGitArgv, hostGitEnv } from "./host-git";
import type {
  CodeRunPolicy,
  WorkspaceDescriptor,
  WorkspaceDiff,
  WorkspaceRunResult,
} from "./local-workspace";
import {
  CODE_RUN_ENV,
  codeRunPolicy,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_RUN_TIMEOUT_MS,
  HostExecForbiddenError,
  LocalWorkspace,
  MAX_BUDGETED_RUN_TIMEOUT_MS,
  runCapture,
  runWorkspaceCommand,
} from "./local-workspace";
import { insideRoot, type WorkspaceFileGrant } from "./workspace-file-grants";

/** `MARINA_CODE_SANDBOX`: refused, choosable, the default, or the only runner. */
export type CodeSandboxMode = "off" | "available" | "default" | "required";

export function codeSandboxMode(env: NodeJS.ProcessEnv = process.env): CodeSandboxMode {
  const raw = env.MARINA_CODE_SANDBOX?.trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0" || raw === "no") return "off";
  if (raw === "default") return "default";
  if (raw === "required") return "required";
  return "available";
}

/** What the coder is told about a sandbox session (policy readouts, prompts). */
export const SANDBOX_RUN_NOTE =
  "Commands run in a local OS sandbox (bubblewrap): any command is allowed, including rg, sed, find and `sh -c '<line>'` pipelines with | && ; >. No network; your home directory is hidden (HOME is a scratch dir); the system is read-only; only the workspace is writable, and .git is read-only, so git commands that write (commit, checkout, stash) fail here.";

/** Directories bound read-only into every sandbox when they exist on the host. */
export const SANDBOX_SYSTEM_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
  "/opt",
  "/nix",
] as const;

/** Fixed launcher locations: never resolved through PATH. */
export const BWRAP_PATHS = ["/usr/bin/bwrap", "/bin/bwrap"] as const;
export const PRLIMIT_PATHS = ["/usr/bin/prlimit", "/bin/prlimit"] as const;
/** `--size` (0.10) and `--disable-userns` (0.8) are required. */
export const MIN_BWRAP_VERSION = [0, 10, 0] as const;

/** Scratch HOME inside the sandbox's private /tmp. */
export const SANDBOX_HOME = "/tmp/home";

/** Operator-tunable resource limits (env-only). */
export interface SandboxLimits {
  /** Size of each tmpfs (/tmp, the masked home), MiB. */
  tmpfsMb: number;
  /** Size of the private /dev/shm tmpfs, MiB. */
  shmMb: number;
  /** RLIMIT_NPROC: processes for the sandbox's user. */
  nproc: number;
  /** RLIMIT_AS: address space per process, MiB. */
  asMb: number;
  /** RLIMIT_FSIZE: largest file a process may write, MiB. */
  fsizeMb: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  tmpfsMb: 1024,
  shmMb: 64,
  nproc: 4096,
  asMb: 16_384,
  fsizeMb: 4096,
};

export function sandboxLimits(env: NodeJS.ProcessEnv = process.env): SandboxLimits {
  const read = (key: string, fallback: number, max: number) => {
    const raw = env[key]?.trim();
    if (!raw || !/^\d+$/.test(raw)) return fallback;
    const value = Number(raw);
    return value >= 1 && value <= max ? value : fallback;
  };
  return {
    tmpfsMb: read("MARINA_CODE_SANDBOX_TMPFS_MB", DEFAULT_SANDBOX_LIMITS.tmpfsMb, 1_048_576),
    shmMb: read("MARINA_CODE_SANDBOX_SHM_MB", DEFAULT_SANDBOX_LIMITS.shmMb, 1_048_576),
    nproc: read("MARINA_CODE_SANDBOX_NPROC", DEFAULT_SANDBOX_LIMITS.nproc, 1_048_576),
    asMb: read("MARINA_CODE_SANDBOX_AS_MB", DEFAULT_SANDBOX_LIMITS.asMb, 16_777_216),
    fsizeMb: read("MARINA_CODE_SANDBOX_FSIZE_MB", DEFAULT_SANDBOX_LIMITS.fsizeMb, 16_777_216),
  };
}

/** A system entry: a directory bound read-only, or a symlink recreated as one (merged /usr). */
export interface SandboxSystemEntry {
  path: string;
  link?: string;
}

/** Everything the bwrap argv depends on, resolved from the host first (so the builder is pure). */
export interface SandboxLayout {
  /** Absolute path of the trusted bwrap binary. */
  bwrap: string;
  /** Absolute path of the trusted prlimit binary (visible inside through a system bind). */
  prlimit: string;
  /** Workspace realpath, bound read-write. */
  root: string;
  /** The host user's home, masked with an empty tmpfs. */
  home: string;
  system: SandboxSystemEntry[];
  /** Files (the Bun executable) or symlinks recreated over the masked home. */
  tools: SandboxSystemEntry[];
  /** Read-only task roots at their host paths. */
  grants: string[];
  /**
   * Pinned paths inside the work tree: each directory is bound onto itself
   * (a mount point cannot be renamed or replaced) and each target read-only —
   * submodule `.git` links and the in-tree programs git config names.
   */
  pins: SandboxPins;
  /** Absolute git metadata paths bound read-only over themselves, LAST. */
  readOnly: string[];
  /** Git hooks the project already has (reported, not refused). */
  hooks: string[];
  /** Content drivers and shell-expanded settings (supported, reported: `gitExposureReport`). */
  exposures?: GitExposure[];
  /** Filter drivers (git-lfs's aside) git config defines: Marina stages and diffs in the sandbox. */
  contentFilters?: string[];
  /** The person's own config files (global, system, includes): their driver definitions apply inside. */
  personConfigFiles?: string[];
  /** The person's global attributes file (`core.attributesFile`, else the XDG default), if any. */
  personAttributes?: string;
  /** The command's whole environment (after `--clearenv`). */
  env: Record<string, string>;
  limits: SandboxLimits;
  /**
   * A host directory bound at /tmp instead of the size-capped tmpfs: only for a finite
   * Marina-owned run (a gate or base check on a snapshot), created and removed by its owner.
   */
  scratchTmp?: string;
}

const MIB = 1024 * 1024;

/** Directories to bind onto themselves (shallowest first) and read-only targets. */
export interface SandboxPins {
  dirs: string[];
  readOnly: string[];
  /** Paths that do not exist: an empty read-only tmpfs is mounted there. */
  emptyDirs: string[];
}

export function emptyPins(): SandboxPins {
  return { dirs: [], readOnly: [], emptyDirs: [] };
}

function addPins(into: SandboxPins, from: SandboxPins): void {
  for (const dir of from.dirs) if (!into.dirs.includes(dir)) into.dirs.push(dir);
  for (const path of from.readOnly) if (!into.readOnly.includes(path)) into.readOnly.push(path);
  for (const path of from.emptyDirs) if (!into.emptyDirs.includes(path)) into.emptyDirs.push(path);
}

/**
 * The bwrap argv for one command. Pure, so every isolation flag is unit-tested
 * without bubblewrap. Mount order is load-bearing: later mounts shadow earlier
 * ones — tmpfs home, then the Bun binary, the workspace and task roots, and
 * the read-only git metadata last so nothing can shadow it.
 */
export function sandboxArgv(layout: SandboxLayout, command: readonly string[]): string[] {
  if (command.length === 0 || !command[0]) throw new Error("Cannot run an empty command.");
  const tmpfsBytes = String(layout.limits.tmpfsMb * MIB);
  const argv = [
    layout.bwrap,
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
  ];
  for (const [key, value] of Object.entries(layout.env)) argv.push("--setenv", key, value);
  for (const entry of layout.system) {
    if (entry.link !== undefined) argv.push("--symlink", entry.link, entry.path);
    else argv.push("--ro-bind", entry.path, entry.path);
  }
  // A private /dev/shm with its own cap, then /dev read-only: /dev/null still
  // works, nothing new can be created in /dev.
  argv.push("--proc", "/proc", "--dev", "/dev");
  argv.push("--size", String(layout.limits.shmMb * MIB), "--tmpfs", "/dev/shm");
  argv.push("--remount-ro", "/dev");
  if (layout.scratchTmp) argv.push("--bind", layout.scratchTmp, "/tmp", "--dir", SANDBOX_HOME);
  else argv.push("--size", tmpfsBytes, "--tmpfs", "/tmp", "--dir", SANDBOX_HOME);
  argv.push("--size", tmpfsBytes, "--tmpfs", layout.home);
  for (const tool of layout.tools) {
    if (tool.link !== undefined) argv.push("--symlink", tool.link, tool.path);
    else argv.push("--ro-bind", tool.path, tool.path);
  }
  argv.push("--bind", layout.root, layout.root);
  for (const grant of layout.grants) argv.push("--ro-bind", grant, grant);
  const depth = (path: string) => path.split("/").length;
  for (const dir of [...layout.pins.dirs].sort((a, b) => depth(a) - depth(b)))
    argv.push("--bind", dir, dir);
  for (const path of layout.pins.readOnly) argv.push("--ro-bind", path, path);
  for (const path of layout.pins.emptyDirs)
    argv.push("--size", "4096", "--tmpfs", path, "--remount-ro", path);
  for (const path of layout.readOnly) argv.push("--ro-bind", path, path);
  argv.push(
    "--chdir",
    layout.root,
    "--",
    layout.prlimit,
    `--nproc=${layout.limits.nproc}`,
    `--as=${layout.limits.asMb * MIB}`,
    `--fsize=${layout.limits.fsizeMb * MIB}`,
    "--core=0",
    "--",
    ...command,
  );
  return argv;
}

/** The system entries present on this host. */
export function hostSystemEntries(paths: readonly string[] = SANDBOX_SYSTEM_PATHS) {
  const entries: SandboxSystemEntry[] = [];
  for (const path of paths) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) entries.push({ path, link: readlinkSync(path) });
    else if (stat.isDirectory()) entries.push({ path });
  }
  return entries;
}

/** Canonical system directories (merged-/usr aliases resolved), for overlap checks. */
function canonicalSystemDirs(entries: readonly SandboxSystemEntry[]): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    out.add(entry.path);
    const real = realpathMaybe(entry.path);
    out.add(real);
  }
  return [...out];
}

/**
 * Check a launcher binary: owned by root or the server user, not group- or
 * world-writable, in a directory that is not world-writable, outside every
 * forbidden root (the workspace and task roots).
 */
export function assertTrustedBinary(
  path: string,
  forbidden: readonly string[],
  uid: number = process.getuid?.() ?? 0,
): string {
  if (!isAbsolute(path)) throw new Error(`Sandbox launcher path must be absolute: ${path}`);
  const real = realpathSync(path);
  for (const root of forbidden)
    if (insideRoot(root, real))
      throw new Error(`Refused: the sandbox launcher ${real} is inside a workspace or task root.`);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`Refused: the sandbox launcher ${real} is not a file.`);
  if (stat.uid !== 0 && stat.uid !== uid)
    throw new Error(
      `Refused: the sandbox launcher ${real} is owned by uid ${stat.uid}, neither root nor the server user.`,
    );
  if ((stat.mode & 0o022) !== 0)
    throw new Error(`Refused: the sandbox launcher ${real} is group- or world-writable.`);
  const dir = statSync(dirname(real));
  if ((dir.mode & 0o002) !== 0)
    throw new Error(
      `Refused: the sandbox launcher's directory ${dirname(real)} is world-writable.`,
    );
  return real;
}

/** The first existing candidate, checked; a present-but-untrusted one fails closed. */
function firstTrusted(
  name: string,
  candidates: readonly string[],
  forbidden: readonly string[],
  missing: string,
): string {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return assertTrustedBinary(candidate, forbidden);
  }
  throw new Error(`${missing} (looked for ${name} at ${candidates.join(", ")}; never via PATH)`);
}

/** bwrap: /usr/bin/bwrap, else /bin/bwrap, else MARINA_CODE_SANDBOX_BWRAP (absolute). */
export function resolveBwrap(
  forbidden: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  candidates: readonly string[] = BWRAP_PATHS,
): string {
  const operator = env.MARINA_CODE_SANDBOX_BWRAP?.trim();
  if (operator && !isAbsolute(operator))
    throw new Error(`MARINA_CODE_SANDBOX_BWRAP must be an absolute path: ${operator}`);
  return firstTrusted(
    "bwrap",
    [...candidates, ...(operator ? [operator] : [])],
    forbidden,
    "The sandbox runner needs bubblewrap (`bwrap`), which is not installed on this host. Install it (e.g. apt/dnf/pacman install bubblewrap) or set MARINA_CODE_SANDBOX_BWRAP, or choose `code workspace runner local`. Sandbox runs never fall back to host execution.",
  );
}

const bwrapVersions = new Map<string, string>();

/** Fail closed on a bubblewrap too old for `--size` / `--disable-userns`. */
export function assertBwrapVersion(bwrap: string, versionText?: string): void {
  let text = versionText ?? bwrapVersions.get(bwrap);
  if (text === undefined) {
    const probe = Bun.spawnSync([bwrap, "--version"], {
      env: { PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    });
    text = probe.stdout.toString();
    bwrapVersions.set(bwrap, text);
  }
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  const version = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  const below = (v: number[]) => {
    for (let i = 0; i < 3; i++)
      if (v[i]! !== MIN_BWRAP_VERSION[i]) return v[i]! < MIN_BWRAP_VERSION[i]!;
    return false;
  };
  if (!version || below(version))
    throw new Error(
      `The sandbox runner needs bubblewrap ${MIN_BWRAP_VERSION.join(".")} or newer (for --size and --disable-userns); ${bwrap} reports ${text.trim() || "no version"}. No host fallback.`,
    );
}

/**
 * The Bun executable for the sandbox: nothing when it already lives in a
 * system directory; its directory when that holds only `bun`/`bunx`; else the
 * executable file alone. Never HOME itself, a directory containing HOME, or a
 * shared bin such as ~/.local/bin.
 */
export function bunToolEntries(
  home: string,
  systemDirs: readonly string[],
  execPath: string = process.execPath,
): SandboxSystemEntry[] {
  const real = realpathSync(execPath);
  if (systemDirs.some((dir) => insideRoot(dir, real))) return [];
  const dir = dirname(real);
  const entries: SandboxSystemEntry[] = [];
  const onlyBun = readdirSync(dir).every((name) => name === "bun" || name === "bunx");
  if (onlyBun && dir !== home && !insideRoot(dir, home)) entries.push({ path: dir });
  else entries.push({ path: real });
  // A launcher symlink on PATH (e.g. ~/.bun/bin/bun → …) keeps working.
  if (execPath !== real && isAbsolute(execPath) && !insideRoot(dir, execPath))
    entries.push({ path: execPath, link: real });
  return entries;
}

/**
 * Absolute git metadata paths to bind read-only: `.git` and any inside-root
 * gitdir (`gitMetadataPaths`, which refuses a missing or symlinked `.git`),
 * plus a worktree's gitdir, common dir, `<common>/modules` and object
 * alternates. A gitdir or common dir inside the root anywhere but
 * `<root>/.git` is refused: renaming its parent would swap it.
 */
export function sandboxGitPaths(root: string): { paths: string[]; gitDir: string; common: string } {
  const paths = gitMetadataPaths(root).map((rel) => join(root, rel));
  const dotGit = join(root, ".git");
  const out = [...paths];
  const add = (path: string) => {
    if (!existsSync(path)) return;
    const real = realpathSync(path);
    if (!out.includes(real)) out.push(real);
  };
  const checkNested = (path: string, what: string) => {
    const real = realpathMaybe(path);
    if (insideRoot(root, real) && !insideRoot(dotGit, real))
      throw new Error(
        `The git ${what} ${real} lives inside the work tree but outside ${dotGit}; sandboxed code could swap it by renaming its parent.`,
      );
  };
  let gitDir = dotGit;
  if (lstatSync(dotGit).isFile()) {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match) throw new Error("Unreadable .git file in the workspace root.");
    gitDir = realpathMaybe(resolve(root, match[1]!.trim()));
    checkNested(gitDir, "directory");
    add(gitDir);
  }
  let common = gitDir;
  const commonFile = join(gitDir, "commondir");
  if (existsSync(commonFile)) {
    const value = readFileSync(commonFile, "utf8").trim();
    if (value) {
      common = realpathMaybe(resolve(gitDir, value));
      checkNested(common, "common directory");
      add(common);
    }
  }
  add(join(common, "modules"));
  for (const dir of new Set([gitDir, common])) {
    const alternates = join(dir, "objects", "info", "alternates");
    if (!existsSync(alternates)) continue;
    for (const line of readFileSync(alternates, "utf8").split("\n")) {
      const value = line.trim();
      if (value && !value.startsWith("#") && isAbsolute(value)) add(value);
    }
  }
  return { paths: out, gitDir, common };
}

/**
 * `key → value` pairs of one config file whose key matches `pattern`, read
 * with hardened host git (`--file … --no-includes --null`): nothing in the
 * file is executed, and subsection names with spaces survive.
 */
export function readGitConfigKeys(
  configFile: string,
  pattern: string | null,
): { key: string; value: string }[] {
  if (!existsSync(configFile)) return [];
  const probe = Bun.spawnSync(
    hostGitArgv([
      "git",
      "config",
      "--file",
      configFile,
      "--no-includes",
      "--null",
      ...(pattern === null ? ["--list"] : ["--get-regexp", pattern]),
    ]),
    { cwd: "/", env: hostGitEnv(), stdout: "pipe", stderr: "pipe" },
  );
  if (probe.exitCode === 1 && pattern !== null) return []; // no matching keys
  if (probe.exitCode !== 0)
    // Never echo git's message: it can quote a config value.
    throw new Error(`Cannot read git config ${configFile}; refused.`);
  const pairs: { key: string; value: string }[] = [];
  for (const entry of probe.stdout.toString().split("\0")) {
    if (!entry) continue;
    const newline = entry.indexOf("\n");
    // A key with no value (`[alias] x`) has no newline.
    pairs.push(
      newline < 0
        ? { key: entry, value: "" }
        : { key: entry.slice(0, newline), value: entry.slice(newline + 1) },
    );
  }
  return pairs;
}

/** `include.path` / `includeIf.*.path` values of one config file. */
export function gitIncludePaths(configFile: string): string[] {
  return readGitConfigKeys(configFile, "^include")
    .filter(({ key }) => key.toLowerCase().endsWith(".path"))
    .map(({ value }) => value);
}

function expandHome(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

/**
 * Refuse a git config (local, worktree or common, the person's global and
 * system config, and what those include) whose include targets resolve inside
 * the work tree or a task root: the sandbox could write that file, and host
 * git would read it as config. Returns every config file visited.
 */
export function assertNoWorkTreeIncludes(
  configFiles: readonly string[],
  writable: readonly string[],
  home: string,
): string[] {
  const seen = new Set<string>();
  const visit = (file: string, depth: number) => {
    const real = realpathMaybe(file);
    if (seen.has(real) || depth > 10) return;
    seen.add(real);
    for (const { key, value } of readGitConfigKeys(real, "^include")) {
      if (!key.toLowerCase().endsWith(".path")) continue;
      const expanded = expandHome(value, home);
      const target = realpathMaybe(
        isAbsolute(expanded) ? expanded : resolve(dirname(real), expanded),
      );
      for (const root of writable)
        if (insideRoot(root, target))
          throw new Error(
            `Git config key ${key} in ${real} includes a file inside the writable tree; sandboxed code could write git config that host git would run. Remove that include first.`,
          );
      visit(target, depth + 1);
    }
  };
  for (const file of configFiles) visit(file, 0);
  return [...seen].filter((file) => existsSync(file));
}

/**
 * THE one reviewable list of git configuration that is data only: git never
 * runs it as a program or reads it as a path to execute. Every other key is
 * treated as executable (shell expansion refused, in-tree paths pinned or
 * refused) — new git features (`hook.<name>.command`, …) are covered by default.
 */
export const DATA_ONLY_GIT_CONFIG = {
  /** Whole sections. */
  sections: new Set([
    "user",
    "author",
    "committer",
    "branch",
    "color",
    "column",
    "advice",
    "i18n",
    "log",
    "format",
    "pretty",
    "status",
    "safe",
    "pull",
    "push",
    "fetch",
    "rebase",
    "tag",
    "blame",
    "gc",
    "pack",
    "index",
    "feature",
    "transfer",
    "rerere",
    "checkout",
    "clone",
    "commit",
  ]),
  /** Single keys inside otherwise-executable sections (`<section>.*.<var>` for subsections). */
  keys: [
    /^remote\..+\.(url|pushurl|fetch|push|mirror|tagopt|prune|skipdefaultupdate|skipfetchall|promisor|partialclonefilter)$/,
    /^submodule\..+\.(url|active|branch|ignore|shallow|fetchrecursesubmodules)$/,
    // `init` is not data-only: init.templateDir names the hook templates git copies.
    /^init\.defaultbranch$/,
    /^core\.(bare|repositoryformatversion|filemode|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|quotepath|compression)$/,
  ] as readonly RegExp[],
} as const;

/** Whether git may execute (or read as a path to run) the value of this key. */
export function isExecutableGitConfigKey(name: string, value: string): boolean {
  const section = name.slice(0, name.indexOf("."));
  if (DATA_ONLY_GIT_CONFIG.sections.has(section)) return false;
  if (DATA_ONLY_GIT_CONFIG.keys.some((pattern) => pattern.test(name))) return false;
  // A plain alias is git arguments (pathspecs), not a program; `!alias` runs the shell.
  if (section === "alias" && !value.trim().startsWith("!")) return false;
  return true;
}

/**
 * Content drivers: programs git runs over work-tree content with the work tree
 * as their current directory. They may read work-tree files they do not name
 * (an interpreter's `-m module`, a tool's own config), so no pin can hold what
 * they run. The sandbox supports them: Marina's own git work that needs them
 * (diff, staging, snapshots) runs INSIDE the sandbox, host git keeps them
 * switched off (`hostGitDriverOverrides`), and the person's own later git is
 * told which files the session wrote (`gitExposureReport`).
 */
export const CONTENT_DRIVER_KEY =
  /^(filter\..+\.(clean|smudge|process)|diff\..+\.(textconv|command)|diff\.external|merge\..+\.driver)$/;
/** git-lfs's own filters: a fixed program, arguments that name no work-tree file. */
const SAFE_CONTENT_DRIVERS = [
  /^(?<program>git-lfs|\/[^\s]*\/git-lfs) clean -- %f$/,
  /^(?<program>git-lfs|\/[^\s]*\/git-lfs) smudge -- %f$/,
  /^(?<program>git-lfs|\/[^\s]*\/git-lfs) filter-process$/,
];

/**
 * A git setting the sandbox supports but cannot pin: a content driver, or an
 * executable setting with shell expansion. Named by key and file only, never
 * by value (a global config can hold a credential).
 */
export interface GitExposure {
  key: string;
  file: string;
  kind: "content-driver" | "shell-expansion";
}

/** The filter driver a `filter.<name>.<var>` key defines, if it is one. */
function filterDriverName(key: string): string | null {
  const match = /^filter\.(.+)\.(clean|smudge|process)$/i.exec(key);
  return match ? match[1]! : null;
}

const SHELL_EXPANSION = /[$`]/;
const SHELL_SYNTAX = /[;&|`$()<>'"\\\n*?[\]{}]/;
/** Values that are URLs or refspecs, not filesystem paths. */
const NOT_A_PATH = /^(\+|refs\/|[a-z][a-z0-9+.-]*:\/\/|[^/\s]+@[^/\s]+:)|:/i;
/** Keys whose value names a directory, even as a bare word. */
const PATH_KEYS = new Set(["core.hookspath"]);
/** Keys that name paths git only compares, never runs or reads as config. */
const IGNORED_KEYS = new Set([
  "safe.directory",
  // Locations git reads data from, not programs: the gitlink pins hold the
  // work trees, and attributes/excludes only select drivers config defines.
  "core.worktree",
  "core.excludesfile",
  "core.attributesfile",
]);

/**
 * Pin one path that lies inside `root`: every directory from the root down is
 * bound onto itself and the target read-only. Refuses a missing target or a
 * symlink anywhere on the way (the sandbox could re-point it). `why` names
 * the source; config-derived pins never quote the value or the path.
 */
export function pinPath(
  root: string,
  target: string,
  why: string,
  opts: { quiet?: boolean } = {},
): SandboxPins {
  const named = opts.quiet ? "a path" : target;
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`Cannot pin ${named} for ${why}: it is not inside the work tree.`);
  const parts = rel.split(sep);
  const pins = emptyPins();
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat)
      throw new Error(
        `${why} names ${named} inside the work tree that does not exist yet; sandboxed code could create it and host git would run it. Create it (or remove the setting) before using the sandbox runner.`,
      );
    if (stat.isSymbolicLink())
      throw new Error(
        `${why} reaches ${named} through a symlink inside the work tree; sandboxed code could re-point it. Refused.`,
      );
    if (index < parts.length - 1) {
      if (!stat.isDirectory())
        throw new Error(`Cannot pin ${named} for ${why}: a parent is not a directory.`);
      pins.dirs.push(current);
    }
  }
  pins.readOnly.push(target);
  return pins;
}

/**
 * Hold a path that does not exist: its parent chain (which must exist, with
 * no symlink) is bound onto itself and an empty read-only tmpfs is mounted at
 * the path (bwrap creates the empty mount-point directory).
 */
export function pinAbsent(root: string, target: string, why: string): SandboxPins {
  const parent = dirname(target);
  const pins = parent === root ? emptyPins() : pinPath(root, parent, why);
  // The parent itself is a directory to bind, not a read-only target.
  pins.readOnly = [];
  if (parent !== root) pins.dirs.push(parent);
  pins.emptyDirs.push(target);
  return pins;
}

/**
 * Pins for every config value that reaches into the work tree. EVERY key of
 * every visited config file is scanned (git runs config commands with the
 * work-tree root as cwd):
 * - shell expansion (`$`, backtick) in a section git may execute or read as a
 *   path refuses the layout — the in-tree path is only built at run time;
 * - every path-like token (contains `/`, or starts with `.` or `~`; URLs and
 *   refspecs excepted) that resolves inside the root is pinned read-only with
 *   its directory chain (`core.hooksPath` counts even as a bare word, so
 *   husky's `.husky` is read-only inside the sandbox);
 * - in an executable section, a path that does not exist yet, a symlink on the
 *   way, or other shell syntax around an in-tree path refuses the layout.
 * Refusals name the key and the file only, never the value (a global config
 * can hold a credential).
 */
export function programConfigPins(
  sources: readonly { file: string; base: string }[],
  root: string,
  home: string,
  /** Receives every content driver and shell-expanded setting (supported, reported). */
  exposures: GitExposure[] = [],
): SandboxPins {
  const pins = emptyPins();
  const inside = (path: string) => insideRoot(root, path) || insideRoot(root, realpathMaybe(path));
  for (const { file, base } of sources) {
    for (const { key, value } of readGitConfigKeys(file, null)) {
      const name = key.toLowerCase();
      if (IGNORED_KEYS.has(name) || name.startsWith("include")) continue;
      const executable = isExecutableGitConfigKey(name, value);
      const why = `git config key ${key} in ${file}`;
      // An `ext::` transport URL runs its command on the person's fetch or push.
      if (/^\s*ext::/i.test(value))
        throw new Error(
          `${why} uses the ext:: transport, which runs a command when git fetches or pushes. Refused.`,
        );
      // Reported rather than pinned: a content driver may read files it does
      // not name, and a shell-expanded path is only built at run time.
      let reported = false;
      if (CONTENT_DRIVER_KEY.test(name)) {
        const safe = SAFE_CONTENT_DRIVERS.map((pattern) => pattern.exec(value.trim())).find(
          Boolean,
        );
        const program = safe?.groups?.program ?? "";
        if (safe && isAbsolute(program) && inside(program))
          throw new Error(
            `${why} names a git-lfs program inside the work tree, which sandboxed code can replace. Refused.`,
          );
        if (safe) continue;
        exposures.push({ key, file, kind: "content-driver" });
        reported = true;
      } else if (executable && SHELL_EXPANSION.test(value)) {
        exposures.push({ key, file, kind: "shell-expansion" });
        reported = true;
      }
      const literal = (token: string) => {
        const expanded = expandHome(token, home);
        return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
      };
      const command = value.trim().replace(/^!/, "");
      const tokens = PATH_KEYS.has(name)
        ? [command]
        : command
            .split(/[\s;&|`$()<>'"=,]+/)
            .filter(Boolean)
            .filter(
              (token) =>
                (token.includes("/") || token.startsWith(".") || token.startsWith("~")) &&
                !NOT_A_PATH.test(token),
            );
      const paths = tokens.map(literal).filter((path) => path !== root && inside(path));
      if (paths.length === 0) continue;
      if (reported) {
        // Best effort: hold the literal in-tree programs it names (a missing
        // one, or one behind a symlink, is left to the report).
        for (const path of paths)
          try {
            addPins(pins, pinPath(root, path, why, { quiet: true }));
          } catch {
            // allow-empty-catch: not pinnable; the exposure report names what the session wrote
          }
        continue;
      }
      if (executable && SHELL_SYNTAX.test(command))
        throw new Error(
          `${why} names a path inside the work tree through shell syntax; it cannot be pinned safely. Refused.`,
        );
      for (const path of paths) {
        if (!executable && !existsSync(path)) continue; // data, not run: nothing to hold
        addPins(pins, pinPath(root, path, why, { quiet: true }));
      }
    }
  }
  return pins;
}

/**
 * Git hooks this project already has: executable, non-`.sample` files in the
 * hooks directory (`<common>/hooks`, or any `core.hooksPath` the configs name)
 * and `hook.<name>.command` settings. Generated hooks (pre-commit's, husky's)
 * run work-tree code from the work-tree root on the person's next commit, so
 * the sandbox says so plainly; it does not refuse them.
 */
export function projectGitHooks(
  configFiles: readonly string[],
  common: string,
  root: string,
  home: string,
): string[] {
  const hooks = new Set<string>();
  const dirs = new Set([join(common, "hooks")]);
  for (const file of configFiles)
    for (const { key, value } of readGitConfigKeys(
      file,
      "^(core\\.hookspath|hook\\..+\\.command)$",
    )) {
      if (key.toLowerCase() === "core.hookspath") {
        const expanded = expandHome(value.trim(), home);
        if (expanded) dirs.add(isAbsolute(expanded) ? expanded : resolve(root, expanded));
      } else hooks.add(key.slice("hook.".length, -".command".length));
    }
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // allow-empty-catch: no hooks directory, no hooks
    }
    for (const name of names) {
      if (name.endsWith(".sample")) continue;
      const stat = statSync(join(dir, name), { throwIfNoEntry: false });
      if (stat?.isFile() && (stat.mode & 0o111) !== 0) hooks.add(name);
    }
  }
  return [...hooks].sort();
}

/** The plain notice for a project with git hooks (start line, results). */
export function gitHooksNotice(hooks: readonly string[]): string {
  return `This project has git hooks (${hooks.join(", ")}) that run work-tree code on your next commit; review the changes before committing.`;
}

/** Paths that hold the server's own state, which a sandbox root may never contain. */
export function serverStatePaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  cwd: string = process.cwd(),
): string[] {
  const paths = [
    resolve(cwd, env.DB_PATH || "marina.db"),
    join(home, ".marina"),
    ...(env.MARINA_SPEND_LEDGER?.trim() ? [resolve(cwd, env.MARINA_SPEND_LEDGER.trim())] : []),
  ];
  // The server's own `.env` (a checkout run with `bun run start`).
  if (existsSync(join(cwd, ".env"))) paths.push(join(cwd, ".env"));
  return paths.map(realpathMaybe);
}

/** The scrubbed environment every sandboxed command gets (the host runner's, scratch HOME). */
export function sandboxEnv(path: string = process.env.PATH ?? ""): Record<string, string> {
  return {
    ...CODE_RUN_ENV,
    PATH: path || "/usr/local/bin:/usr/bin:/bin",
    HOME: SANDBOX_HOME,
    TMPDIR: "/tmp",
  };
}

/** The person's global attributes file: `core.attributesFile` in their config, else the XDG default. */
function personAttributesFile(
  files: readonly string[],
  home: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  let named: string | undefined;
  // Later files win (system, then global): `configFiles` lists the global ones before /etc.
  for (const file of [...files].reverse())
    for (const { value } of readGitConfigKeys(file, "^core\\.attributesfile$"))
      if (value.trim()) named = expandHome(value.trim(), home);
  const path =
    named ?? join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "git", "attributes");
  return isAbsolute(path) && lstatSync(path, { throwIfNoEntry: false })?.isFile()
    ? path
    : undefined;
}

export interface SandboxLayoutOptions {
  /** Bind this host directory at /tmp instead of the tmpfs (`SandboxLayout.scratchTmp`). */
  scratchTmp?: string;
  home?: string;
  execPath?: string;
  /** Read-only system directories (default `SANDBOX_SYSTEM_PATHS`). */
  systemPaths?: readonly string[];
  /** Test seams: launcher candidates (default the fixed paths). */
  bwrapPaths?: readonly string[];
  prlimitPaths?: readonly string[];
  /** Server-state paths (default `serverStatePaths()`). */
  serverState?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the layout for a root on this host. Throws (never guesses) when a
 * launcher is missing or untrusted, the root has no own `.git` or a nested
 * gitdir, a git include points into the tree, a write grant is configured, a
 * mount would overlap the home, the git metadata or a system directory, or the
 * root holds the server's own state.
 */
export function resolveSandboxLayout(
  root: string,
  fileGrants: readonly WorkspaceFileGrant[] = [],
  opts: SandboxLayoutOptions = {},
): SandboxLayout {
  const env = opts.env ?? process.env;
  const home = realpathMaybe(opts.home ?? homedir());
  if (!home || home === "/")
    throw new Error("The sandbox runner cannot mask a home directory of `/`.");
  if (insideRoot(root, home))
    throw new Error(
      `The sandbox runner refuses a workspace that contains the home directory (${home}): the home must stay hidden.`,
    );
  // A relative (or empty = current directory) PATH entry would let a bare
  // program name in git config resolve to a file sandboxed code can write.
  const pathEntries = (env.PATH ?? "").split(":");
  if (pathEntries.some((entry) => !entry || !isAbsolute(entry)))
    throw new Error(
      "The sandbox runner refuses a server PATH with a relative or empty entry: a program name in git config would then resolve to a file in the work tree, which sandboxed code can write. Make every PATH entry absolute.",
    );
  const serverState = opts.serverState ?? serverStatePaths(env, home);
  for (const state of serverState)
    if (insideRoot(root, state))
      throw new Error(
        `The sandbox runner refuses a workspace that contains the server's own state (${state}): its database, spend ledger, settings and keys must stay out of reach of sandboxed code. Use a separate checkout or point DB_PATH elsewhere.`,
      );
  const system = hostSystemEntries(opts.systemPaths);
  const systemDirs = canonicalSystemDirs(system);
  if (systemDirs.some((dir) => insideRoot(root, dir)))
    throw new Error(
      `The sandbox runner refuses a workspace that is or contains a system directory: ${root}`,
    );
  const git = primaryGitPaths(root);
  const grants: string[] = [];
  for (const grant of fileGrants) {
    if (grant.access === "write")
      throw new Error(
        `The sandbox runner does not take writable task roots yet (${grant.root}); use the host or a container runner for task outputs.`,
      );
    const real = realpathSync(grant.root);
    if (real !== grant.root) throw new Error("Task file root changed before sandbox execution.");
    const overlaps = (path: string) => insideRoot(path, real) || insideRoot(real, path);
    if (overlaps(root) || git.paths.some(overlaps))
      throw new Error(`Task root ${real} overlaps the workspace or its git metadata.`);
    if (insideRoot(real, home))
      throw new Error(
        `The sandbox runner refuses a task root that contains the home directory (${real}).`,
      );
    if (systemDirs.some(overlaps))
      throw new Error(`Task root ${real} overlaps a system directory.`);
    // A read root over ~/.marina would expose instance .env files and databases.
    for (const state of serverState)
      if (insideRoot(real, state))
        throw new Error(
          `The sandbox runner refuses a task root that contains the server's own state (${state}).`,
        );
    grants.push(real);
  }
  const forbidden = [root, ...grants];
  const bwrap = resolveBwrap(forbidden, env, opts.bwrapPaths);
  assertBwrapVersion(bwrap);
  const prlimit = firstTrusted(
    "prlimit",
    opts.prlimitPaths ?? PRLIMIT_PATHS,
    forbidden,
    "The sandbox runner needs prlimit (util-linux) to cap processes, memory and file sizes; it is not installed. No host fallback.",
  );
  if (!systemDirs.some((dir) => insideRoot(dir, prlimit)))
    throw new Error(`prlimit (${prlimit}) is not inside a system directory the sandbox binds.`);
  // The repository's config and the person's own (global, system): the
  // person's later host git reads all of them.
  const configFiles = assertNoWorkTreeIncludes(
    [
      join(git.gitDir, "config"),
      join(git.gitDir, "config.worktree"),
      join(git.common, "config"),
      join(git.common, "config.worktree"),
      join(home, ".gitconfig"),
      join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "git", "config"),
      "/etc/gitconfig",
    ],
    forbidden,
    home,
  );
  const exposures: GitExposure[] = [];
  const pins = programConfigPins(
    configFiles.map((file) => ({ file, base: root })),
    root,
    home,
    exposures,
  );
  const repoConfigs = new Set(
    [git.gitDir, git.common].flatMap((dir) =>
      ["config", "config.worktree"].map((name) => realpathMaybe(join(dir, name))),
    ),
  );
  const personConfigFiles = configFiles.filter((file) => !repoConfigs.has(realpathMaybe(file)));
  const contentFilters = [
    ...new Set(
      exposures
        .map((exposure) => filterDriverName(exposure.key))
        .filter((name): name is string => name !== null),
    ),
  ];
  const personAttributes = personAttributesFile(personConfigFiles, home, env);
  return {
    bwrap,
    prlimit,
    root,
    home,
    system,
    tools: bunToolEntries(home, systemDirs, opts.execPath).filter(
      (tool) => !insideRoot(root, tool.path),
    ),
    grants,
    pins,
    readOnly: git.paths,
    hooks: projectGitHooks(configFiles, git.common, root, home),
    exposures,
    contentFilters,
    personConfigFiles,
    ...(personAttributes ? { personAttributes } : {}),
    env: sandboxEnv(env.PATH),
    limits: sandboxLimits(env),
    ...(opts.scratchTmp ? { scratchTmp: checkScratchTmp(opts.scratchTmp, root, home) } : {}),
  };
}

/** A scratch /tmp must be a real directory of its own: not a link, not the home or the root. */
function checkScratchTmp(path: string, root: string, home: string): string {
  if (!isAbsolute(path)) throw new Error(`The sandbox scratch /tmp must be absolute: ${path}`);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    throw new Error(`The sandbox scratch /tmp is not a directory: ${path}`);
  const real = realpathSync(path);
  if (
    insideRoot(root, real) ||
    insideRoot(real, root) ||
    insideRoot(real, home) ||
    insideRoot(home, real)
  )
    throw new Error(`The sandbox scratch /tmp overlaps the workspace or the home: ${real}`);
  return real;
}

/** The workspace's own git metadata; a root without (or with a symlinked) `.git` is refused. */
function primaryGitPaths(root: string): ReturnType<typeof sandboxGitPaths> {
  try {
    return sandboxGitPaths(root);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The sandbox runner needs the workspace root to be a git repository root with its own .git, which it binds read-only so sandboxed code cannot plant hooks or config that host git would run (run \`git init\` there first). ${reason}`,
    );
  }
}

function realpathMaybe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realpathMaybe(parent), basename(path));
  }
}

/** The state of one submodule's `.git` (gitfile, directory or absent). */
export type GitlinkState =
  | { kind: "file"; content: string }
  /** The gitlink's directory itself does not exist. */
  | { kind: "absent" }
  | { kind: "dir"; dev: number; ino: number; config: string }
  | { kind: "missing" }
  | { kind: "other"; detail: string };

/** One level's gitlinks (`git ls-files -s`, mode 160000) and their names, via hardened host git. */
async function levelGitlinks(
  workTree: string,
  gitDir: string,
  hostExecForbidden: boolean,
): Promise<{ path: string; name: string }[]> {
  // -z and quotePath=false: a path with a quote or a non-ASCII character comes
  // out raw (the default C-quotes it, and the quoted name matches no file).
  const listed = await runCapture(
    [
      "git",
      "-c",
      "core.quotePath=false",
      `--git-dir=${gitDir}`,
      `--work-tree=${workTree}`,
      "ls-files",
      "-s",
      "-z",
    ],
    workTree,
    8 * MIB,
    hostExecForbidden,
  );
  if (listed.exitCode !== 0) throw new Error("git ls-files -s failed; cannot check submodules.");
  if (listed.truncated) throw new Error("The index listing is too large to check submodules.");
  const paths: string[] = [];
  for (const line of listed.content.split("\0")) {
    const tab = line.indexOf("\t");
    if (tab < 0 || !line.startsWith("160000 ")) continue;
    paths.push(line.slice(tab + 1));
  }
  if (paths.length === 0) return [];
  // Names come from the INDEX's .gitmodules (the work-tree copy is writable).
  const names = new Map<string, string>();
  const config = await runCapture(
    [
      "git",
      `--git-dir=${gitDir}`,
      "config",
      "--blob",
      ":.gitmodules",
      "--null",
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ],
    workTree,
    MIB,
    hostExecForbidden,
  );
  if (config.exitCode === 0)
    for (const entry of config.content.split("\0")) {
      const newline = entry.indexOf("\n");
      if (newline < 0) continue;
      const key = entry.slice(0, newline);
      names.set(entry.slice(newline + 1), key.slice("submodule.".length, -".path".length));
    }
  return paths.map((path) => ({ path, name: names.get(path) ?? path }));
}

/** A gitlink as recorded before a run: its path from the workspace root and its `.git` state. */
export interface GitlinkRecord {
  path: string;
  state: GitlinkState;
}

/**
 * Every gitlink, recursively (a submodule's own index lists nested ones), with
 * the pins that hold it in place: each directory from the root down to the
 * gitlink bound onto itself (a mount point cannot be renamed) and its `.git`
 * read-only. A gitfile that does not point into `<modules>/…`, a `.git`
 * directory where `<modules>/<name>` exists, or a symlink on the way refuses
 * the run. Module configs are returned so their program settings get pinned.
 */
export async function collectGitlinks(
  root: string,
  gitDir: string,
  common: string,
  hostExecForbidden = false,
): Promise<{
  records: GitlinkRecord[];
  pins: SandboxPins;
  moduleConfigs: { file: string; base: string }[];
}> {
  const records: GitlinkRecord[] = [];
  const pins = emptyPins();
  const moduleConfigs: { file: string; base: string }[] = [];
  const misplaced = (path: string, why: string) =>
    new Error(
      `Refused: submodule ${path} ${why}; inspect the repository before running sandboxed commands in it.`,
    );
  const visit = async (workTree: string, dir: string, modules: string, depth: number) => {
    if (depth > 8) throw new Error("Submodules nest deeper than 8 levels; refused.");
    for (const { path, name } of await levelGitlinks(workTree, dir, hostExecForbidden)) {
      const abs = join(workTree, path);
      const rel = relative(root, abs);
      if (!rel || rel.startsWith("..") || isAbsolute(rel))
        throw misplaced(path, "lies outside the work tree");
      const state = gitlinkState(root, rel);
      records.push({ path: rel, state });
      if (state.kind === "missing") {
        // Not initialised (deinit leaves an empty directory): hold the whole
        // directory read-only, so no `.git` can appear there during the run.
        addPins(pins, pinPath(root, abs, `submodule ${rel}`));
        continue;
      }
      if (state.kind === "absent") {
        // No directory at all: an empty read-only tmpfs takes its place.
        addPins(pins, pinAbsent(root, abs, `submodule ${rel}`));
        continue;
      }
      if (state.kind === "other") throw misplaced(rel, `has an unexpected .git (${state.detail})`);
      const modulesReal = realpathMaybe(modules);
      if (state.kind === "dir") {
        if (existsSync(join(modules, name)))
          throw misplaced(rel, `has a .git directory although ${join(modules, name)} exists`);
        addPins(pins, pinPath(root, join(abs, ".git"), `submodule ${rel}`));
        moduleConfigs.push({ file: join(abs, ".git", "config"), base: abs });
        await visit(abs, join(abs, ".git"), join(abs, ".git", "modules"), depth + 1);
        continue;
      }
      const match = /^gitdir:\s*(.+)$/m.exec(state.content);
      const target = match ? realpathMaybe(resolve(abs, match[1]!.trim())) : "";
      if (!target || target === modulesReal || !insideRoot(modulesReal, target))
        throw misplaced(rel, `has a gitfile that does not point into ${modules}`);
      addPins(pins, pinPath(root, join(abs, ".git"), `submodule ${rel}`));
      moduleConfigs.push({ file: join(target, "config"), base: abs });
      await visit(abs, target, join(target, "modules"), depth + 1);
    }
  };
  await visit(root, gitDir, join(common, "modules"), 0);
  return { records, pins, moduleConfigs };
}

export function gitlinkState(root: string, path: string): GitlinkState {
  const dir = join(root, path);
  const dirStat = lstatSync(dir, { throwIfNoEntry: false });
  if (!dirStat) return { kind: "absent" };
  if (!dirStat.isDirectory())
    return {
      kind: "other",
      detail: dirStat.isSymbolicLink() ? `symlink ${readlinkSync(dir)}` : "not a directory",
    };
  const dotGit = join(dir, ".git");
  const stat = lstatSync(dotGit, { throwIfNoEntry: false });
  if (!stat) return { kind: "missing" };
  if (stat.isFile()) return { kind: "file", content: readFileSync(dotGit, "utf8") };
  if (stat.isDirectory()) {
    const config = join(dotGit, "config");
    const hash = existsSync(config)
      ? createHash("sha256").update(readFileSync(config)).digest("hex")
      : "";
    return { kind: "dir", dev: stat.dev, ino: stat.ino, config: hash };
  }
  return {
    kind: "other",
    detail: stat.isSymbolicLink() ? `symlink ${readlinkSync(dotGit)}` : "special file",
  };
}

function sameState(a: GitlinkState, b: GitlinkState): boolean {
  // An absent gitlink directory comes back as an empty one: bwrap creates the
  // mount point for its read-only tmpfs. Nothing can be written there.
  const empty = (state: GitlinkState) => state.kind === "absent" || state.kind === "missing";
  if (empty(a) && empty(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** git's own words when a filter program could not run or failed. */
const FILTER_FAILURE =
  /(external filter [^\n]*failed[^\n]*|cannot fork to run external filter[^\n]*|cannot run [^\n]*)/;

/** Bound on one of Marina's own git runs in the sandbox (staging, diff). */
const SANDBOX_GIT_TIMEOUT_MS = 120_000;

/**
 * Command-line config for git inside the sandbox. git-lfs's filters stay off
 * there as in host git (its clean writes `.git/lfs`, which is read-only), so
 * an LFS file is staged as stored; hooks and fsmonitor do not run; no gc.
 */
const SANDBOX_GIT_CONFIG_ENV = gitConfigEnv([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
]);

/**
 * `git add -A` into a private index and object directory; entries and the
 * objects the repository lacks out. Git copies every object it hashes into the
 * private directory (it cannot freshen the read-only alternate), so the ones
 * the repository already has are left out by asking the repository alone.
 * `head` starts from HEAD keeping the index's stat data (`read-tree -m`), so
 * unchanged files are not hashed again.
 */
const STAGE_SCRIPT = `set -e
mkdir -p /tmp/objects /tmp/out
if [ "$1" = head ]; then git read-tree -m HEAD; fi
git add -A
git ls-files -s -z > /tmp/out/entries
(cd /tmp/objects && find . -type f) | sed -n 's#^[.]/\\([0-9a-f][0-9a-f]\\)/\\([0-9a-f]*\\)$#\\1\\2#p' > /tmp/out/new
GIT_OBJECT_DIRECTORY="$GIT_ALTERNATE_OBJECT_DIRECTORIES" GIT_ALTERNATE_OBJECT_DIRECTORIES= git cat-file --batch-check < /tmp/out/new | sed -n 's/ missing$//p' > /tmp/out/missing
git cat-file --batch < /tmp/out/missing > /tmp/out/blobs`;

/** The unstaged diff, new files included (intent-to-add in a private index copy). */
const DIFF_SCRIPT = `set -e
mkdir -p /tmp/objects /tmp/out
git ls-files -z --others --exclude-standard -- "$@" > /tmp/out/untracked
xargs -0 -r git add -N -- < /tmp/out/untracked
git diff --no-ext-diff --no-textconv -- "$@" > /tmp/out/diff`;

/** Paths changed from HEAD (the index on an unborn branch), and untracked ones. */
const CHANGED_SCRIPT = `set -e
mkdir -p /tmp/objects /tmp/out
git diff --name-only --no-renames HEAD -- > /tmp/out/tracked 2>/dev/null || git diff --name-only --no-renames --cached -- > /tmp/out/tracked
git ls-files --others --exclude-standard > /tmp/out/untracked`;

/** One config value in git's quoted syntax. */
function gitConfigValue(value: string): string {
  return `"${value
    .replace(/[\\"]/g, (c) => `\\${c}`)
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
}

/**
 * The global config git inside the sandbox reads (the person's home is hidden
 * there): only the content-driver definitions of the person's own config files
 * and their global attributes, so staging matches what their git would stage.
 */
export function writeSandboxGitConfig(scratch: string, layout: SandboxLayout): void {
  const lines: string[] = [];
  for (const file of layout.personConfigFiles ?? [])
    for (const { key, value } of readGitConfigKeys(file, "^(filter|diff|merge)\\.")) {
      const first = key.indexOf(".");
      const last = key.lastIndexOf(".");
      if (first === last) {
        lines.push(
          `[${key.slice(0, first)}]`,
          `\t${key.slice(last + 1)} = ${gitConfigValue(value)}`,
        );
        continue;
      }
      const sub = key.slice(first + 1, last);
      if (/[\n\0]/.test(sub)) continue;
      lines.push(
        `[${key.slice(0, first)} ${gitConfigValue(sub)}]`,
        `\t${key.slice(last + 1)} = ${gitConfigValue(value)}`,
      );
    }
  if (layout.personAttributes) {
    const stat = lstatSync(layout.personAttributes, { throwIfNoEntry: false });
    if (stat?.isFile() && stat.size <= MIB) {
      writeFileSync(join(scratch, "attributes"), readFileSync(layout.personAttributes));
      lines.push("[core]", `\tattributesFile = ${gitConfigValue("/tmp/attributes")}`);
    }
  }
  writeFileSync(join(scratch, "gitconfig"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

/** A file the sandbox wrote in its scratch /tmp: a regular file (no symlink followed), bounded. */
function readScratchBounded(scratch: string, rel: string, max: number) {
  const fd = openSync(join(scratch, rel), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`The sandbox's ${rel} is not a regular file.`);
    const data = Buffer.alloc(Math.min(stat.size, max));
    let offset = 0;
    while (offset < data.length) {
      const read = readSync(fd, data, offset, data.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return { data: data.subarray(0, offset), size: stat.size };
  } finally {
    closeSync(fd);
  }
}

function readScratch(scratch: string, rel: string, max: number): Buffer {
  const { data, size } = readScratchBounded(scratch, rel, max);
  if (size > max) throw new Error(`The sandbox's ${rel} exceeds ${max} bytes.`);
  return data;
}

const INDEX_MODES = new Set(["100644", "100755", "120000", "160000"]);

/** `git ls-files -s -z` output: mode, oid, stage 0 and a safe relative path, or a refusal. */
export function parseIndexEntries(data: Buffer): { mode: string; oid: string; path: string }[] {
  const entries: { mode: string; oid: string; path: string }[] = [];
  for (const record of data.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([^\0]+)$/.exec(record);
    if (!match || !INDEX_MODES.has(match[1]!))
      throw new Error("Git in the sandbox staged an unexpected entry; nothing was captured.");
    const path = match[3]!;
    if (
      isAbsolute(path) ||
      /[\r\n\uFFFD]/.test(path) ||
      path.split("/").some((part) => ["", ".", "..", ".git"].includes(part.toLowerCase()))
    )
      throw new Error("Git in the sandbox staged an unsafe path; nothing was captured.");
    entries.push({ mode: match[1]!, oid: match[2]!, path });
  }
  return entries;
}

/** `git cat-file --batch` output: `<oid> <type> <size>\n<bytes>\n` per object. */
export function parseBatch(data: Buffer): Map<string, { type: string; data: Buffer }> {
  const out = new Map<string, { type: string; data: Buffer }>();
  let offset = 0;
  while (offset < data.length) {
    const newline = data.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("Malformed object stream from the sandbox.");
    const header = data.subarray(offset, newline).toString("latin1");
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) (blob|tree|commit|tag) (\d{1,12})$/.exec(header);
    if (!match) {
      if (/^[a-f0-9]{40,64} missing$/.test(header)) {
        offset = newline + 1;
        continue;
      }
      throw new Error("Malformed object stream from the sandbox.");
    }
    const size = Number(match[3]);
    const start = newline + 1;
    if (start + size + 1 > data.length || data[start + size] !== 0x0a)
      throw new Error("Malformed object stream from the sandbox.");
    out.set(match[1]!, { type: match[2]!, data: data.subarray(start, start + size) });
    offset = start + size + 1;
  }
  return out;
}

/** Hardened host git with optional stdin; never a driver, hook or the person's config. */
async function hostGit(
  cwd: string,
  args: string[],
  input?: string | Uint8Array,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: Buffer }> {
  const child = Bun.spawn(hostGitArgv(["git", ...args], cwd), {
    cwd,
    env: hostGitEnv(extraEnv),
    stdin:
      input === undefined
        ? "ignore"
        : new Blob([typeof input === "string" ? input : new Uint8Array(input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), SANDBOX_GIT_TIMEOUT_MS);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.slice(0, 400)}`);
    return { stdout: Buffer.from(stdout) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the person's own git could pick up from this session. The sandbox
 * supports content drivers and shell-expanded settings, and Marina never runs
 * them outside it; but the person's git runs them on their computer with this
 * work tree as the current directory (a content driver on their next `git
 * status`, `diff` or `add`). No pin holds what such a program reads, so every
 * file created or changed since `sinceMs` (ctime: no sandboxed process can
 * set it back) is listed, ignored files included.
 */
export interface GitExposureReport {
  exposures: GitExposure[];
  files: string[];
  /** Files past the listed ones. */
  more: number;
  /** The walk stopped at its entry bound: more may have changed. */
  incomplete: boolean;
}

const EXPOSURE_LISTED = 20;
const EXPOSURE_MAX_ENTRIES = 200_000;

export function gitExposureReport(
  root: string,
  exposures: readonly GitExposure[],
  sinceMs: number,
  opts: { listed?: number; maxEntries?: number } = {},
): GitExposureReport {
  const listed = opts.listed ?? EXPOSURE_LISTED;
  const maxEntries = opts.maxEntries ?? EXPOSURE_MAX_ENTRIES;
  const files: string[] = [];
  let count = 0;
  let seen = 0;
  let incomplete = false;
  // ctime has coarse granularity on some filesystems; a second of slack over-reports.
  const since = sinceMs - 1000;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // allow-empty-catch: an unreadable directory has nothing to list
    }
    for (const name of names) {
      if (++seen > maxEntries) {
        incomplete = true;
        break;
      }
      if (name === ".git") continue;
      const path = join(dir, name);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) stack.push(path);
      else if (stat.ctimeMs >= since) {
        count++;
        if (files.length < listed) files.push(relative(root, path));
      }
    }
    if (incomplete) break;
  }
  files.sort();
  return { exposures: [...exposures], files, more: count - files.length, incomplete };
}

/** The plain notice for a report, or null when nothing applies. */
export function gitExposureNotice(report: GitExposureReport, root: string): string | null {
  if (report.exposures.length === 0) return null;
  const keys = [...new Set(report.exposures.map((exposure) => exposure.key))];
  const settings = `Your git settings ${keys.join(", ")} run programs on this computer with the work tree as their directory (a content driver on your next git status, diff or add there).`;
  const marina =
    "Marina ran them only inside the sandbox; nothing the session wrote ran outside it.";
  if (report.files.length === 0 && !report.incomplete)
    return `${settings} ${marina} The session created or changed no files they could pick up.`;
  const listed = report.files.join(", ");
  const more = report.more > 0 ? ` and ${report.more} more` : "";
  const partial = report.incomplete ? " (the tree is too large to list in full)" : "";
  return `${settings} ${marina} Your own git would see the files this session created or changed${partial}: ${listed}${more}. Review them before running git in ${root} yourself.`;
}

/** The exposure notice for a sandbox root since `sinceMs`, or null (no exposure, or the layout is refused). */
export function sandboxExposureNoticeFor(root: string, sinceMs: number): string | null {
  try {
    const real = realpathSync(root);
    const layout = resolveSandboxLayout(real, [], sandboxTestDefaults);
    if (!layout.exposures?.length) return null;
    return gitExposureNotice(gitExposureReport(real, layout.exposures, sinceMs), real);
  } catch {
    return null; // the start line reports a refused layout itself
  }
}

/** The settings a sandbox root supports but cannot pin, or none when its layout is refused. */
export function sandboxExposuresFor(root: string): GitExposure[] {
  try {
    return resolveSandboxLayout(realpathSync(root), [], sandboxTestDefaults).exposures ?? [];
  } catch {
    return []; // the start line reports the refusal itself on first use
  }
}

/** The start-line notice for a root whose git config the sandbox reports rather than pins. */
export function gitExposureStartNotice(exposures: readonly GitExposure[]): string | null {
  if (exposures.length === 0) return null;
  const keys = [...new Set(exposures.map((exposure) => exposure.key))];
  return `This project's git config runs programs Marina cannot pin (${keys.join(", ")}): Marina's own git work that needs them runs inside the sandbox; your own git runs them on this computer, so the files this session writes are listed when it ends.`;
}

/** Thrown when a sandboxed command changed submodule git metadata. */
export class SandboxTamperError extends Error {
  constructor(readonly paths: string[]) {
    super(
      `SECURITY: a sandboxed command changed submodule git metadata (${paths.join(", ")}). Nothing was restored. A later plain \`git status\` in this repository would run whatever that submodule's config names, so every command in this workspace (any session, any runner) is held until a person inspects the repository and runs \`code workspace runner release\`.`,
    );
    this.name = "SandboxTamperError";
  }
}

/** bwrap's own setup failures name it on stderr; a command's failure does not. */
const BWRAP_SETUP_ERROR = /(^|\n)bwrap: [^\n]*/;

/** A Code Mode workspace whose finite commands run in a bubblewrap sandbox; any command. */
export class SandboxWorkspace extends LocalWorkspace {
  private readonly layoutOpts: SandboxLayoutOptions;
  /** Called (once per detection) when a run changed submodule git metadata. */
  private readonly onTamper?: (error: SandboxTamperError) => void;

  constructor(
    root: string,
    fileGrants: readonly WorkspaceFileGrant[] = [],
    layoutOpts: SandboxLayoutOptions = {},
    onTamper?: (error: SandboxTamperError) => void,
  ) {
    super(root, fileGrants);
    this.layoutOpts = { ...sandboxTestDefaults, ...layoutOpts };
    this.onTamper = onTamper;
    // Resolve once now so a missing or untrusted launcher is reported before the first run.
    resolveSandboxLayout(this.root, this.fileGrants, this.layoutOpts);
  }

  /** The layout for the next command, re-resolved so a changed `.git` or config is caught. */
  layout(): SandboxLayout {
    return resolveSandboxLayout(this.root, this.fileGrants, this.layoutOpts);
  }

  override assertExecutionReady(): void {
    super.assertExecutionReady();
    this.layout();
  }

  override describe(): WorkspaceDescriptor {
    return {
      ...super.describe(),
      runner: { kind: "sandbox", engine: "bubblewrap", network: false },
    };
  }

  override runPolicy(): CodeRunPolicy {
    return {
      ...codeRunPolicy(),
      commands: ["any command (argv or sh -c '<line>')"],
      sandbox: SANDBOX_RUN_NOTE,
    };
  }

  /** Host-side dependency installation contradicts "never fall back"; refuse it here. */
  override prepareCandidateDependencies(): never {
    throw new Error(
      "Candidate dependency preparation runs on the host and is unavailable for sandbox workspaces.",
    );
  }

  /** No network in the sandbox: dependency installs cannot run. */
  override installsPermitted(): boolean {
    return false;
  }

  /**
   * Any argv, unchanged: no allowlist and no approver, because the sandbox is
   * the boundary. The telnet chokepoint still refuses before anything spawns.
   */
  override async run(
    command: string[],
    timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
  ): Promise<WorkspaceRunResult> {
    if (this.hostExecForbidden) throw new HostExecForbiddenError();
    if (command.length === 0 || !command[0]?.trim())
      throw new Error("Usage: code run <command>  (e.g. code run sh -c 'rg foo | head')");
    return this.runNormalized([...command], timeoutMs, maxBytes);
  }

  /**
   * Background, candidate and delivery checks: inside the sandbox they accept
   * any command too (same bwrap, prlimit and pins, in this workspace's root —
   * the snapshot directory for a candidate or delivery check).
   */
  override async runAllowlisted(
    command: string[],
    beforeSpawn: () => void,
    timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  ): Promise<WorkspaceRunResult> {
    if (this.hostExecForbidden) throw new HostExecForbiddenError();
    if (command.length === 0 || !command[0]?.trim()) throw new Error("Cannot run an empty check.");
    return this.runNormalized([...command], timeoutMs, DEFAULT_MAX_OUTPUT_BYTES, beforeSpawn);
  }

  protected override async spawnNormalized(
    normalized: string[],
    timeoutMs: number,
    maxBytes: number,
  ): Promise<Omit<WorkspaceRunResult, "command" | "durationMs">> {
    const { result, layout } = await this.inSandbox(normalized, timeoutMs, maxBytes);
    const labelled = labelSetupFailure(result);
    return layout.hooks.length
      ? { ...labelled, output: `${labelled.output}\n[marina] ${gitHooksNotice(layout.hooks)}` }
      : labelled;
  }

  /**
   * One command in the sandbox: the layout re-resolved, every submodule
   * gitlink pinned and checked afterwards (a change holds the workspace).
   */
  private async inSandbox(
    command: string[],
    timeoutMs: number,
    maxBytes: number,
    opts: { scratchTmp?: string; env?: Record<string, string> } = {},
  ): Promise<{
    result: Omit<WorkspaceRunResult, "command" | "durationMs">;
    layout: SandboxLayout;
  }> {
    if (this.hostExecForbidden) throw new HostExecForbiddenError();
    const layout = opts.scratchTmp
      ? resolveSandboxLayout(this.root, this.fileGrants, {
          ...this.layoutOpts,
          scratchTmp: opts.scratchTmp,
        })
      : this.layout();
    if (opts.env) layout.env = { ...layout.env, ...opts.env };
    const git = sandboxGitPaths(this.root);
    // Submodules, recursively: pin every gitlink in place (its directory chain
    // bound onto itself, its .git read-only), record each .git as a backstop,
    // and pin the in-tree programs their module configs name.
    const subs = await collectGitlinks(this.root, git.gitDir, git.common, this.hostExecForbidden);
    addPins(layout.pins, subs.pins);
    for (const entry of subs.moduleConfigs) {
      const files = assertNoWorkTreeIncludes([entry.file], [this.root], layout.home);
      addPins(
        layout.pins,
        programConfigPins(
          files.map((file) => ({ file, base: entry.base })),
          this.root,
          layout.home,
          layout.exposures,
        ),
      );
    }
    const result = await runWorkspaceCommand(
      sandboxArgv(layout, command),
      this.root,
      Math.min(timeoutMs, MAX_BUDGETED_RUN_TIMEOUT_MS),
      maxBytes,
      this.hostExecForbidden,
    );
    const changed = subs.records
      .filter((record) => !sameState(record.state, gitlinkState(this.root, record.path)))
      .map((record) => record.path);
    if (changed.length > 0) this.tamper(changed);
    return { result, layout };
  }

  /** Filter drivers (git-lfs's aside) git config defines for this repository. */
  contentFilters(): string[] {
    return this.layout().contentFilters ?? [];
  }

  /**
   * Run one of Marina's own git scripts INSIDE the sandbox, with the
   * repository's content drivers (and the person's own driver definitions and
   * attributes) active: the same bwrap layout and pins as any command, `.git`
   * read-only, a private index and object directory in a scratch /tmp. Results
   * come back as files in that scratch directory, read as data only (no
   * symlink followed, sizes bounded): nothing it wrote is ever run.
   */
  private async sandboxGit(
    script: string,
    args: readonly string[],
    /** Start from a private copy of the session's index (else an empty one). */
    copyIndex: boolean,
  ): Promise<{ scratch: string; dispose: () => void }> {
    if (this.hostExecForbidden) throw new HostExecForbiddenError();
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "marina-sbx-git-")));
    const dispose = () => rmSync(scratch, { recursive: true, force: true });
    try {
      const layout = this.layout();
      const git = sandboxGitPaths(this.root);
      writeSandboxGitConfig(scratch, layout);
      const index = join(git.gitDir, "index");
      if (copyIndex && lstatSync(index, { throwIfNoEntry: false })?.isFile())
        copyFileSync(index, join(scratch, "index"));
      const { result } = await this.inSandbox(
        ["sh", "-c", script, "marina-git", ...args],
        SANDBOX_GIT_TIMEOUT_MS,
        64 * 1024,
        {
          scratchTmp: scratch,
          env: {
            GIT_INDEX_FILE: "/tmp/index",
            GIT_OBJECT_DIRECTORY: "/tmp/objects",
            GIT_ALTERNATE_OBJECT_DIRECTORIES: join(git.common, "objects"),
            GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
            GIT_NO_LAZY_FETCH: "1",
            ...SANDBOX_GIT_CONFIG_ENV,
          },
        },
      );
      if (result.exitCode !== 0)
        throw new Error(
          `${labelSetupFailure(result).output.trim().slice(-600) || "git failed"} (git in the sandbox, exit ${result.exitCode}${result.timedOut ? ", timed out" : ""})`,
        );
      // A filter that cannot run (its toolchain lives in the hidden home, say) makes git
      // fall back to the raw bytes: fail closed instead of showing what the person's git would not.
      const failed = FILTER_FAILURE.exec(result.output);
      if (failed)
        throw new Error(
          `The repository's content filter could not run inside the sandbox (${failed[0].trim().slice(0, 200)}); its program, or a module it loads, may live in your home directory, which the sandbox hides. Install it system-wide, or use another runner.`,
        );
      return { scratch, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  }

  /**
   * What the person's `git add -A` would stage, computed inside the sandbox
   * with the repository's filters: `path → blob oid` for every file, each blob
   * written into `repository` by HOST git from the bytes the sandbox returned
   * (`hash-object --no-filters`, its oid checked), and the staged tree.
   * `from`: the session's index (a candidate) or HEAD (a snapshot commit).
   */
  async stagedEntries(
    from: "index" | "head",
    repository: string = this.root,
  ): Promise<{ tree: string; blobs: Map<string, string> }> {
    const { scratch, dispose } = await this.sandboxGit(STAGE_SCRIPT, [from], true);
    try {
      const entries = parseIndexEntries(readScratch(scratch, "out/entries", 64 * MIB));
      const objects = parseBatch(readScratch(scratch, "out/blobs", 512 * MIB));
      const repo = realpathSync(repository);
      const wanted = [...new Set(entries.filter((e) => e.mode !== "160000").map((e) => e.oid))];
      const present = await hostGit(
        repo,
        ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        wanted.map((oid) => `${oid}\n`).join(""),
      );
      const missing = new Set<string>();
      for (const line of present.stdout.toString().split("\n").filter(Boolean)) {
        const [oid, type] = line.split(" ");
        if (type === "missing") missing.add(oid!);
        else if (type !== "blob") throw new Error(`Staged entry ${oid} is not a blob.`);
      }
      for (const oid of missing) {
        const content = objects.get(oid);
        if (content?.type !== "blob")
          throw new Error("The sandbox did not return a staged blob; nothing was captured.");
        // Host git hashes the bytes itself: the oid the sandbox claimed must be theirs.
        const written = (
          await hostGit(repo, ["hash-object", "-w", "--no-filters", "--stdin"], content.data)
        ).stdout
          .toString()
          .trim();
        if (written !== oid)
          throw new Error("A staged blob does not match its object id; nothing was captured.");
      }
      // A host-private index: never in the scratch directory the sandbox could write.
      const own = mkdtempSync(join(tmpdir(), "marina-sbx-index-"));
      let tree: string;
      try {
        const env = { GIT_INDEX_FILE: join(own, "index") };
        await hostGit(
          repo,
          ["update-index", "-z", "--index-info"],
          entries.map((e) => `${e.mode} ${e.oid}\t${e.path}\0`).join(""),
          env,
        );
        tree = (await hostGit(repo, ["write-tree"], undefined, env)).stdout.toString().trim();
      } finally {
        rmSync(own, { recursive: true, force: true });
      }
      if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error("git write-tree returned no tree.");
      const blobs = new Map<string, string>();
      for (const entry of entries) if (entry.mode !== "160000") blobs.set(entry.path, entry.oid);
      return { tree, blobs };
    } finally {
      dispose();
    }
  }

  /** The staged tree of the work tree from HEAD (`code trial`, `code ship`). */
  async snapshotTree(repository: string = this.root): Promise<string> {
    return (await this.stagedEntries("head", repository)).tree;
  }

  /**
   * Candidate capture with content filters: the blobs come from git inside
   * the sandbox; the bytes, fingerprint and materialized copy stay raw.
   */
  override async captureCandidate(
    repository?: string,
    beforeCapture?: () => void,
    options: CandidateCaptureOptions = {},
  ): ReturnType<LocalWorkspace["captureCandidate"]> {
    if (this.hostExecForbidden) throw new HostExecForbiddenError();
    if (options.staged || this.contentFilters().length === 0)
      return super.captureCandidate(repository, beforeCapture, options);
    const { blobs } = await this.stagedEntries("index", repository ?? this.root);
    return super.captureCandidate(repository, beforeCapture, { staged: blobs });
  }

  /** With content filters, the diff git inside the sandbox sees (new files staged intent-to-add). */
  override async diff(input?: string, maxBytes = DEFAULT_MAX_OUTPUT_BYTES): Promise<WorkspaceDiff> {
    if (this.contentFilters().length === 0) return super.diff(input, maxBytes);
    const pathspec: string[] = [];
    if (input?.trim()) pathspec.push(this.relativePath(this.resolvePath(input)));
    let ran: Awaited<ReturnType<SandboxWorkspace["sandboxGit"]>>;
    try {
      ran = await this.sandboxGit(DIFF_SCRIPT, pathspec, true);
    } catch (error) {
      if (error instanceof HostExecForbiddenError || error instanceof SandboxTamperError)
        throw error;
      return {
        content: error instanceof Error ? error.message : String(error),
        truncated: false,
        exitCode: 1,
      };
    }
    const { scratch, dispose } = ran;
    try {
      const { data, size } = readScratchBounded(scratch, "out/diff", maxBytes);
      const truncated = size > maxBytes;
      return {
        content: data.toString("utf8"),
        truncated,
        exitCode: 0,
        ...(truncated ? { totalBytes: size } : {}),
      };
    } finally {
      dispose();
    }
  }

  /** With content filters, changed paths as git inside the sandbox sees them. */
  override async changedPaths(): Promise<string[]> {
    if (this.contentFilters().length === 0) return super.changedPaths();
    const { scratch, dispose } = await this.sandboxGit(CHANGED_SCRIPT, [], true);
    try {
      const out = new Set<string>();
      for (const name of ["out/tracked", "out/untracked"])
        for (const line of readScratch(scratch, name, 256 * 1024)
          .toString("utf8")
          .split("\n"))
          if (line.trim()) out.add(line.trim());
      return [...out];
    } finally {
      dispose();
    }
  }

  private tamper(paths: string[]): never {
    const error = new SandboxTamperError(paths);
    this.onTamper?.(error);
    throw error;
  }
}

/** The git hooks a sandbox root already has, or none when its layout is refused. */
export function sandboxHooksFor(root: string): string[] {
  try {
    return resolveSandboxLayout(realpathSync(root), [], sandboxTestDefaults).hooks;
  } catch {
    return []; // the start line reports the refusal itself on first use
  }
}

/** Test seam: default layout options for every SandboxWorkspace (fake launchers). */
let sandboxTestDefaults: SandboxLayoutOptions = {};
export function setSandboxDefaultsForTests(opts: SandboxLayoutOptions = {}): void {
  sandboxTestDefaults = opts;
}

/** Name a sandbox that never started, so it is not read as the command failing. */
export function labelSetupFailure<T extends { exitCode: number; output: string }>(result: T): T {
  if (result.exitCode === 0) return result;
  const stderr = result.output.split("\n--- stderr ---\n")[1] ?? result.output;
  const match = BWRAP_SETUP_ERROR.exec(stderr);
  if (!match || !stderr.trimStart().startsWith("bwrap:")) return result;
  return {
    ...result,
    output: `marina: the bubblewrap sandbox could not start (${match[0].trim()}); the command did not run. User namespaces may be disabled on this host. No host fallback.\n${result.output}`,
  };
}

/**
 * A session whose sandbox runner cannot be set up (no bwrap, a root without
 * `.git`, the sandbox turned off or held). File operations still work; every
 * finite command fails with the reason. It never runs the command on the host.
 */
export class UnavailableSandboxWorkspace extends LocalWorkspace {
  private readonly reason: string;

  constructor(root: string, error: unknown, fileGrants: readonly WorkspaceFileGrant[] = []) {
    super(root, fileGrants);
    this.reason = error instanceof Error ? error.message : String(error);
  }

  override describe(): WorkspaceDescriptor {
    return {
      ...super.describe(),
      runner: { kind: "sandbox", engine: "bubblewrap", network: false },
    };
  }

  override assertExecutionReady(): never {
    throw new Error(`Sandbox runner unavailable: ${this.reason}`);
  }

  override prepareCandidateDependencies(): never {
    throw new Error(`Sandbox runner unavailable: ${this.reason}`);
  }

  override installsPermitted(): boolean {
    return false;
  }

  override run(_command: string[]): Promise<WorkspaceRunResult> {
    if (this.hostExecForbidden) return Promise.reject(new HostExecForbiddenError());
    return Promise.reject(new Error(`Sandbox runner unavailable: ${this.reason}`));
  }

  override runAllowlisted(): Promise<WorkspaceRunResult> {
    if (this.hostExecForbidden) return Promise.reject(new HostExecForbiddenError());
    return Promise.reject(new Error(`Sandbox runner unavailable: ${this.reason}`));
  }

  override runPreparationStep(): Promise<WorkspaceRunResult> {
    return Promise.reject(new Error(`Sandbox runner unavailable: ${this.reason}`));
  }

  protected override spawnNormalized(): Promise<
    Omit<WorkspaceRunResult, "command" | "durationMs">
  > {
    return Promise.reject(new Error(`Sandbox runner unavailable: ${this.reason}`));
  }
}
