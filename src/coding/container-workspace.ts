// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Container-backed Code Mode workspace. Files stay on the host (the same
 * LocalWorkspace surface: read, search, patch, diff); FINITE COMMANDS run
 * inside a container image instead of on the host, so an agent can run a
 * project's real tests in its real environment (any image the operator names,
 * e.g. a project's CI image or a benchmark's environment image).
 *
 * Security model (docs/architecture/security.md → "Container workspaces"):
 * - The same gates as host runs: `code.exec` at the command router, the
 *   allowlist or a per-call exec approver (every approve/deny is an
 *   `exec_decision` artifact), and the telnet host-exec chokepoint. All of that
 *   is inherited from LocalWorkspace; only the spawn step differs.
 * - Never a silent host fallback: a missing runtime or image is an error.
 * - No network unless the runner opts in; all capabilities dropped,
 *   no-new-privileges, CPU / memory / pid limits, a timeout that also removes
 *   the container, `--rm` so no container outlives its command.
 * - `mount` sync: the worktree is the only host path mounted (read-write, at
 *   the workdir) EXCEPT its git metadata, which is bound read-only on top
 *   (`gitMetadataPaths`): code inside the container cannot plant hooks, an
 *   fsmonitor or diff drivers that host git would run. A root without its own
 *   `.git` is refused. Host git itself is hardened as well (host-git.ts). The
 *   root filesystem is read-only with a private /tmp; the process runs as the
 *   host user (`--userns=keep-id` / `--user uid:gid`).
 * - Operator policy (code/runner.ts): `init`, the image, network and the host
 *   runner are operator settings; the in-world `code workspace runner` cannot
 *   set an init preamble and cannot leave an operator-required container.
 * - `patch` sync: nothing from the host is mounted. The image already holds
 *   the project at its base revision; the workspace's pending diff (tracked
 *   changes plus untracked files) is fed on stdin and applied inside a
 *   throwaway container before the command runs.
 * - The runtime CLI (podman/docker) runs with the OPERATOR's container
 *   configuration and storage: HOME, XDG_* and CONTAINER_* / DOCKER_* are
 *   captured from the server's own environment at startup, never the scratch
 *   HOME that host commands get (a fresh rootless store there would re-pull
 *   every image, possibly onto a tmpfs). The process INSIDE the container sees
 *   none of it: it only gets the explicit `-e` values below.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceDescriptor, WorkspaceRunResult } from "./local-workspace";
import { LocalWorkspace, runCapture, runWorkspaceCommand } from "./local-workspace";
import type { WorkspaceFileGrant } from "./workspace-file-grants";

export type ContainerRuntime = "podman" | "docker";
export type ContainerSync = "mount" | "patch";

export interface ContainerRunnerConfig {
  image: string;
  runtime?: ContainerRuntime;
  /** `mount` (default): bind the worktree. `patch`: apply the pending diff inside the image. */
  sync?: ContainerSync;
  /** Absolute working directory inside the container (default `/work`); in patch mode, the repository's path in the image. */
  workdir?: string;
  /** Opt-in network access. Default off (`--network none`). */
  network?: boolean;
  cpus?: number;
  memoryMb?: number;
  /** Per-command timeout inside the container; default 600 s, max 1800 s. */
  timeoutMs?: number;
  /** Optional environment preamble run before the command (e.g. activating a conda env). */
  init?: string;
  /** Shell for `init` / `patch` (default `sh`; `bash` for `source`-style preambles). */
  shell?: "sh" | "bash";
}

export interface ResolvedContainerRunner {
  image: string;
  runtime: ContainerRuntime;
  sync: ContainerSync;
  workdir: string;
  network: boolean;
  cpus: number;
  memoryMb: number;
  timeoutMs: number;
  init?: string;
  shell: "sh" | "bash";
  /** Podman `--root` (image store), from MARINA_CODE_CONTAINER_STORAGE. */
  storageRoot?: string;
  /** Podman `--runroot` (runtime state), from MARINA_CODE_CONTAINER_RUNROOT. */
  runRoot?: string;
}

/**
 * Variables the runtime CLI needs to find the operator's container config,
 * storage and daemon. Captured once from the server's environment at load
 * (server start), so a per-command scratch HOME can never redirect them.
 */
const RUNTIME_ENV_KEYS = [
  "HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINERS_CONF",
  "CONTAINERS_STORAGE_CONF",
  "CONTAINERS_REGISTRIES_CONF",
  "REGISTRY_AUTH_FILE",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
] as const;

/** The runtime-CLI subset of an environment (only the keys above, only when set). */
export function captureRuntimeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of RUNTIME_ENV_KEYS) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

/** The operator's runtime environment, captured when the server loaded this module. */
const OPERATOR_RUNTIME_ENV = captureRuntimeEnv(process.env);

const STORAGE_PATH = /^\/[A-Za-z0-9._\-/]*$/;

const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;
const WORKDIR = /^\/[A-Za-z0-9._\-/]*$/;
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 1_800_000;
const MAX_PATCH_BYTES = 20 * 1024 * 1024;
const PIDS_LIMIT = 1024;

/** Validate and fill defaults. Throws on anything malformed; never guesses. */
export function resolveContainerRunner(
  config: ContainerRunnerConfig,
  env: NodeJS.ProcessEnv = process.env,
  which: (binary: string) => string | null = (b) => Bun.which(b),
): ResolvedContainerRunner {
  const image = config.image?.trim() ?? "";
  if (!IMAGE_REF.test(image) || image.length > 256)
    throw new Error(`Invalid container image reference: ${image || "(empty)"}`);
  const sync = config.sync ?? "mount";
  if (sync !== "mount" && sync !== "patch") throw new Error(`Unknown container sync: ${sync}`);
  const workdir = config.workdir ?? "/work";
  if (!WORKDIR.test(workdir) || workdir.split("/").includes(".."))
    throw new Error(`Container workdir must be an absolute path: ${workdir}`);
  const requested = config.runtime ?? (env.MARINA_CODE_CONTAINER_RUNTIME as ContainerRuntime);
  let runtime: ContainerRuntime | undefined;
  if (requested) {
    if (requested !== "podman" && requested !== "docker")
      throw new Error(`Unknown container runtime: ${requested}`);
    runtime = requested;
  } else {
    runtime = which("podman") ? "podman" : which("docker") ? "docker" : undefined;
  }
  if (!runtime || !which(runtime))
    throw new Error(
      "No container runtime found (podman or docker). Container workspaces never fall back to host execution.",
    );
  const cpus = clamp(config.cpus ?? 2, 0.5, 16);
  const memoryMb = Math.round(clamp(config.memoryMb ?? 4096, 256, 65_536));
  const timeoutMs = Math.round(
    clamp(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS),
  );
  const init = config.init?.trim() || undefined;
  if (init && (init.length > 2_000 || /[\n\r\0]/.test(init)))
    throw new Error("Container init must be a single line under 2000 characters.");
  // Storage location is operator configuration (env only), never a session setting.
  const storageRoot = storagePath(
    env.MARINA_CODE_CONTAINER_STORAGE,
    "MARINA_CODE_CONTAINER_STORAGE",
  );
  const runRoot = storagePath(env.MARINA_CODE_CONTAINER_RUNROOT, "MARINA_CODE_CONTAINER_RUNROOT");
  if ((storageRoot || runRoot) && runtime !== "podman")
    throw new Error(
      "MARINA_CODE_CONTAINER_STORAGE / _RUNROOT apply to podman; set Docker's data-root in the daemon configuration.",
    );
  return {
    image,
    runtime,
    sync,
    workdir,
    network: config.network === true,
    cpus,
    memoryMb,
    timeoutMs,
    init,
    shell: config.shell === "bash" ? "bash" : "sh",
    ...(storageRoot ? { storageRoot } : {}),
    ...(runRoot ? { runRoot } : {}),
  };
}

function storagePath(raw: string | undefined, name: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!STORAGE_PATH.test(value) || value.split("/").includes("..") || value.length > 512)
    throw new Error(`${name} must be an absolute path: ${value}`);
  return value;
}

/** Global runtime flags placed before the subcommand (`podman --root … run …`). */
export function runtimeGlobalArgs(runner: ResolvedContainerRunner): string[] {
  const args: string[] = [];
  if (runner.storageRoot) args.push("--root", runner.storageRoot);
  if (runner.runRoot) args.push("--runroot", runner.runRoot);
  return args;
}

/**
 * Where the runtime keeps its images, for operator diagnostics. Podman: the
 * explicit `--root`, else the rootless/rootful default for the captured
 * operator environment (a `storage.conf` graphroot may still override it).
 * Docker: daemon-managed, so `null`.
 */
export function containerStorageLocation(
  runner: Pick<ResolvedContainerRunner, "runtime" | "storageRoot">,
  runtimeEnv: Record<string, string> = OPERATOR_RUNTIME_ENV,
  uid: number = process.getuid?.() ?? 1000,
): string | null {
  if (runner.runtime !== "podman") return null;
  if (runner.storageRoot) return runner.storageRoot;
  if (uid === 0) return "/var/lib/containers/storage";
  if (runtimeEnv.XDG_DATA_HOME) return `${runtimeEnv.XDG_DATA_HOME}/containers/storage`;
  if (runtimeEnv.HOME) return `${runtimeEnv.HOME}/.local/share/containers/storage`;
  return null;
}

/** The filesystem type of the mount holding `path` (longest mountpoint prefix in /proc/mounts). */
export function mountFsType(path: string, mounts?: string): string | null {
  let text = mounts;
  if (text === undefined) {
    try {
      text = readFileSync("/proc/mounts", "utf8");
    } catch {
      return null; // no /proc (non-Linux): unknown
    }
  }
  let best = "";
  let type: string | null = null;
  for (const line of text.split("\n")) {
    const [, mountPoint, fsType] = line.split(" ");
    if (!mountPoint || !fsType) continue;
    const covers = path === mountPoint || mountPoint === "/" || path.startsWith(`${mountPoint}/`);
    if (covers && mountPoint.length >= best.length) {
      best = mountPoint;
      type = fsType;
    }
  }
  return type;
}

/**
 * A loud warning when the image store would land in memory or a scratch dir:
 * on tmpfs/ramfs, or under the system temp directory. `null` when it looks fine.
 */
export function storageWarning(location: string | null, mounts?: string): string | null {
  if (!location) return null;
  const tmp = tmpdir();
  const type = mountFsType(location, mounts);
  if (type === "tmpfs" || type === "ramfs")
    return `container image store ${location} is on ${type}; images will fill memory. Set MARINA_CODE_CONTAINER_STORAGE to a disk path.`;
  if (location === tmp || location.startsWith(`${tmp}/`) || location.startsWith("/tmp/"))
    return `container image store ${location} is under the temp directory. Set MARINA_CODE_CONTAINER_STORAGE to a persistent disk path.`;
  return null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * The container front-end argv for one validated command. Pure, so the
 * security-relevant flags are unit-tested without a runtime.
 */
export function containerRunArgv(
  runner: ResolvedContainerRunner,
  root: string,
  command: string[],
  name: string,
  opts: {
    applyPatch?: boolean;
    uid?: number;
    gid?: number;
    /** Root-relative git metadata paths bound read-only over the worktree mount (default `.git`). */
    readOnlyPaths?: string[];
    fileGrants?: readonly WorkspaceFileGrant[];
  } = {},
): string[] {
  const ids = {
    uid: opts.uid ?? process.getuid?.() ?? 1000,
    gid: opts.gid ?? process.getgid?.() ?? 1000,
  };
  if (runner.sync === "patch" && opts.fileGrants?.length)
    throw new Error("Task file roots require mount sync; patch sync never mounts host paths.");
  const applyPatch = runner.sync === "patch" && opts.applyPatch === true;
  const argv = [
    runner.runtime,
    ...runtimeGlobalArgs(runner),
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    runner.network ? (runner.runtime === "podman" ? "pasta" : "bridge") : "none",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(PIDS_LIMIT),
    "--cpus",
    String(runner.cpus),
    "--memory",
    `${runner.memoryMb}m`,
    "--tmpfs",
    "/tmp:rw,exec,size=1g",
    "-e",
    "CI=1",
    "-e",
    "TERM=dumb",
    "-e",
    "HOME=/tmp",
    "-w",
    runner.workdir,
  ];
  if (runner.sync === "mount") {
    argv.push("--read-only", "-v", `${root}:${runner.workdir}:rw`);
    // Git metadata is read-only inside the container: code run there (a test
    // suite) must never plant config, hooks or an fsmonitor that host git would
    // later execute. Later mounts shadow the read-write worktree mount.
    for (const rel of opts.readOnlyPaths ?? [".git"]) {
      argv.push("-v", `${root}/${rel}:${runner.workdir}/${rel}:ro`);
    }
    for (const grant of opts.fileGrants ?? []) {
      if (realpathSync(grant.root) !== grant.root)
        throw new Error("Task file root changed before container execution.");
      argv.push("-v", `${grant.root}:${grant.guestPath}:${grant.access === "read" ? "ro" : "rw"}`);
      if (grant.access === "write")
        for (const rel of gitMetadataPaths(grant.root, true))
          argv.push("-v", `${grant.root}/${rel}:${grant.guestPath}/${rel}:ro`);
    }
    if (runner.runtime === "podman") argv.push("--userns=keep-id");
    else argv.push("--user", `${ids.uid}:${ids.gid}`);
  } else if (applyPatch) {
    // Patch mode mounts nothing from the host; the diff arrives on stdin.
    argv.push("-i");
  }
  argv.push(runner.image);
  const steps: string[] = [];
  if (runner.init) steps.push(runner.init);
  if (applyPatch)
    steps.push(
      'git apply --whitespace=nowarn - || { echo "marina: pending diff did not apply inside the image" >&2; exit 125; }',
    );
  if (steps.length === 0) return [...argv, ...command];
  // The command stays an argv ("$@"). The only shell text is the fixed patch
  // step and `init`, which comes from operator configuration
  // (MARINA_CODE_CONTAINER_INIT) only: the in-world runner command cannot set
  // it, and stored session settings are stripped of it (code/runner.ts).
  return [
    ...argv,
    runner.shell,
    "-c",
    `set -e; ${steps.join("; ")}; exec "$@"`,
    "marina-run",
    ...command,
  ];
}

/**
 * The root-relative git metadata paths a `mount`-sync container must see
 * read-only: `.git` itself (a directory, or a worktree's `gitdir:` file) and,
 * when that file points back inside the worktree, the git directory and its
 * common directory too. Throws when `.git` is missing or a symlink: the
 * container could then create or redirect it, and host git would read it.
 */
export function gitMetadataPaths(root: string, allowMissing = false): string[] {
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit)) {
    if (lstatSync(dotGit, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("Container mount sync refuses a dangling .git symlink.");
    if (allowMissing) return [];
    throw new Error(
      "Container mount sync needs a git repository root with its own .git metadata as the primary workspace. Prepare the workspace before dispatch; additional artifact roots need no Git repository.",
    );
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dotGit);
  } catch {
    throw new Error(
      "Container mount sync needs the workspace root to be a git repository root (its .git is mounted read-only). Use sync:patch, or a repository root.",
    );
  }
  if (stat.isSymbolicLink())
    throw new Error("Container mount sync refuses a symlinked .git in the workspace root.");
  const paths = [".git"];
  if (stat.isFile()) {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match) throw new Error("Unreadable .git file in the workspace root.");
    const gitDir = resolve(root, match[1]!.trim());
    addInside(root, gitDir, paths);
    try {
      const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      if (common) addInside(root, resolve(gitDir, common), paths);
    } catch {
      // allow-empty-catch: no commondir file means the gitdir is its own common dir
    }
  }
  return paths;
}

function addInside(root: string, target: string, paths: string[]): void {
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return;
  if (!paths.includes(rel)) paths.push(rel);
}

/** A Code Mode workspace whose finite commands run inside a container image. */
export class ContainerWorkspace extends LocalWorkspace {
  readonly runner: ResolvedContainerRunner;
  /** The runtime CLI's environment: the operator's container config and storage. */
  private readonly runtimeEnv: Record<string, string>;

  constructor(
    root: string,
    runner: ResolvedContainerRunner,
    runtimeEnv: Record<string, string> = OPERATOR_RUNTIME_ENV,
    fileGrants: readonly WorkspaceFileGrant[] = [],
  ) {
    super(root, fileGrants);
    if (runner.sync === "patch" && fileGrants.length)
      throw new Error("Task file roots require mount sync; patch sync never mounts host paths.");
    this.runner = runner;
    this.runtimeEnv = runtimeEnv;
  }

  override assertExecutionReady(): void {
    super.assertExecutionReady();
    if (this.runner.sync === "mount") gitMetadataPaths(this.root);
    for (const grant of this.fileGrants)
      if (realpathSync(grant.root) !== grant.root)
        throw new Error("Task file root changed before dispatch.");
  }

  /** Where this runner's images live (podman), for `code doctor`. */
  storageLocation(): string | null {
    return containerStorageLocation(this.runner, this.runtimeEnv);
  }

  override describe(): WorkspaceDescriptor {
    return {
      ...super.describe(),
      ...(this.fileGrants.length
        ? { fileGrants: this.fileGrants.map((grant) => ({ ...grant })) }
        : {}),
      runner: {
        kind: "container",
        runtime: this.runner.runtime,
        image: this.runner.image,
        sync: this.runner.sync,
      },
    };
  }

  /** Host-side dependency installation contradicts "never fall back"; refuse it here. */
  override prepareCandidateDependencies(): never {
    throw new Error(
      "Candidate dependency preparation runs on the host and is unavailable for container workspaces.",
    );
  }

  /**
   * Verification may install the project's locked dependencies here only when
   * the install persists to the next command (the worktree is mounted) and the
   * operator gave the runner network. Patch sync starts every command from the
   * image, so its image must already hold the environment.
   */
  override installsPermitted(): boolean {
    return this.runner.sync === "mount" && this.runner.network;
  }

  protected override async spawnNormalized(
    normalized: string[],
    timeoutMs: number,
    maxBytes: number,
  ): Promise<Omit<WorkspaceRunResult, "command" | "durationMs">> {
    const timeout = Math.min(Math.max(timeoutMs, this.runner.timeoutMs), MAX_TIMEOUT_MS);
    const diff = this.runner.sync === "patch" ? await this.pendingDiff() : "";
    const stdin = diff.length > 0 ? diff : undefined;
    const name = `marina-run-${crypto.randomUUID().slice(0, 12)}`;
    const argv = containerRunArgv(this.runner, this.root, normalized, name, {
      applyPatch: stdin !== undefined,
      fileGrants: this.fileGrants,
      ...(this.runner.sync === "mount" ? { readOnlyPaths: gitMetadataPaths(this.root) } : {}),
    });
    const result = await runWorkspaceCommand(
      argv,
      this.root,
      timeout,
      maxBytes,
      this.hostExecForbidden,
      // Only the runtime CLI sees these; the container gets its explicit `-e` values.
      this.runtimeEnv,
      stdin,
    );
    if (result.timedOut) {
      // The front-end was killed; make sure the container is gone too.
      await runCapture(
        [this.runner.runtime, ...runtimeGlobalArgs(this.runner), "rm", "-f", name],
        this.root,
        4096,
        this.hostExecForbidden,
        this.runtimeEnv,
      );
    }
    return result;
  }

  /** Tracked changes against HEAD plus untracked files, as one binary-safe patch. */
  async pendingDiff(): Promise<string> {
    const tracked = await runCapture(
      ["git", "diff", "HEAD", "--binary"],
      this.root,
      MAX_PATCH_BYTES,
      this.hostExecForbidden,
    );
    if (tracked.exitCode !== 0)
      throw new Error(`git diff failed: ${tracked.content.slice(0, 300)}`);
    if (tracked.truncated) throw new Error("Pending diff exceeds the container patch limit.");
    const untracked = await runCapture(
      ["git", "ls-files", "--others", "--exclude-standard"],
      this.root,
      1024 * 1024,
      this.hostExecForbidden,
    );
    if (untracked.exitCode !== 0) throw new Error("git ls-files failed.");
    let patch = tracked.content;
    for (const file of untracked.content.split("\n").filter(Boolean)) {
      const added = await runCapture(
        ["git", "diff", "--binary", "--no-index", "--", "/dev/null", file],
        this.root,
        MAX_PATCH_BYTES,
        this.hostExecForbidden,
      );
      // `git diff --no-index` exits 1 when the files differ, which is the point.
      if (added.exitCode > 1) throw new Error(`Could not diff untracked file: ${file}`);
      if (added.truncated || patch.length + added.content.length > MAX_PATCH_BYTES)
        throw new Error("Pending diff exceeds the container patch limit.");
      patch += added.content;
    }
    return patch;
  }
}

/**
 * A session configured for a container runner that cannot be resolved (no
 * runtime on this host, an invalid image). File operations still work; every
 * finite command fails with the reason. It never runs the command on the host.
 */
export class UnavailableContainerWorkspace extends LocalWorkspace {
  private readonly reason: string;

  constructor(root: string, error: unknown, fileGrants: readonly WorkspaceFileGrant[] = []) {
    super(root, fileGrants);
    this.reason = error instanceof Error ? error.message : String(error);
  }

  override assertExecutionReady(): never {
    throw new Error(`Container runner unavailable: ${this.reason}`);
  }

  override prepareCandidateDependencies(): never {
    throw new Error(`Container runner unavailable: ${this.reason}`);
  }

  override installsPermitted(): boolean {
    return false;
  }

  protected override spawnNormalized(): Promise<
    Omit<WorkspaceRunResult, "command" | "durationMs">
  > {
    return Promise.reject(new Error(`Container runner unavailable: ${this.reason}`));
  }
}
