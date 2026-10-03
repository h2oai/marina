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
 *   the workdir); the root filesystem is read-only with a private /tmp; the
 *   process runs as the host user (`--userns=keep-id` / `--user uid:gid`).
 * - `patch` sync: nothing from the host is mounted. The image already holds
 *   the project at its base revision; the workspace's pending diff (tracked
 *   changes plus untracked files) is fed on stdin and applied inside a
 *   throwaway container before the command runs.
 */

import type { WorkspaceDescriptor, WorkspaceRunResult } from "./local-workspace";
import { LocalWorkspace, runCapture, runWorkspaceCommand } from "./local-workspace";

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
}

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
  };
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
  opts: { applyPatch?: boolean; uid?: number; gid?: number } = {},
): string[] {
  const ids = {
    uid: opts.uid ?? process.getuid?.() ?? 1000,
    gid: opts.gid ?? process.getgid?.() ?? 1000,
  };
  const applyPatch = runner.sync === "patch" && opts.applyPatch === true;
  const argv = [
    runner.runtime,
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
  // The command stays an argv ("$@"); only the operator-set preamble is shell text.
  return [
    ...argv,
    runner.shell,
    "-c",
    `set -e; ${steps.join("; ")}; exec "$@"`,
    "marina-run",
    ...command,
  ];
}

/** A Code Mode workspace whose finite commands run inside a container image. */
export class ContainerWorkspace extends LocalWorkspace {
  readonly runner: ResolvedContainerRunner;

  constructor(root: string, runner: ResolvedContainerRunner) {
    super(root);
    this.runner = runner;
  }

  override describe(): WorkspaceDescriptor {
    return {
      ...super.describe(),
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
    });
    const result = await runWorkspaceCommand(
      argv,
      this.root,
      timeout,
      maxBytes,
      this.hostExecForbidden,
      {},
      stdin,
    );
    if (result.timedOut) {
      // The front-end was killed; make sure the container is gone too.
      await runCapture(
        [this.runner.runtime, "rm", "-f", name],
        this.root,
        4096,
        this.hostExecForbidden,
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

  constructor(root: string, error: unknown) {
    super(root);
    this.reason = error instanceof Error ? error.message : String(error);
  }

  override prepareCandidateDependencies(): never {
    throw new Error(`Container runner unavailable: ${this.reason}`);
  }

  protected override spawnNormalized(): Promise<
    Omit<WorkspaceRunResult, "command" | "durationMs">
  > {
    return Promise.reject(new Error(`Container runner unavailable: ${this.reason}`));
  }
}
