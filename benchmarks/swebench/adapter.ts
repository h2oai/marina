// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * SWE-bench — a thin adapter over Marina's general one-shot coding entry point
 * (`marina -p "<task>" <dir>`, scripts/code.ts). Nothing here is
 * benchmark-specific Marina behavior: the adapter prepares a clean checkout at
 * the instance's base commit, hands the coding agent the issue text only,
 * collects the resulting working-tree diff as `model_patch`, and keeps the
 * session's streamed output plus its Marina database as the trajectory.
 *
 * Evaluation is the official SWE-bench harness, unmodified (see
 * docs/guides/swebench.md). Benchmark content (issues, patches, logs) lives in
 * the operator's data directory, never in this repository.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { verificationCounts } from "../../src/engine/benchmark-ledger";
import { capEnvValue } from "../../src/engine/spend-guard";
import { mulberry32 } from "../stats";

/** The solver-visible fields `export.py` writes — no hints, gold or test patches. */
export interface SweInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  version?: string;
  problem_statement: string;
  /** SWE-bench Pro: the PR's explicit requirements (part of the task the solver sees). */
  requirements?: string;
  /** SWE-bench Pro: new interfaces the change must introduce, or a statement that there are none. */
  interface?: string;
}

/** Which SWE-bench dataset a run belongs to (its ledger name and default instance file). */
export type SweBenchmark = "verified" | "pro";

/**
 * `judge` names the grader honestly in the ledger: Verified runs the official harness itself;
 * Pro runs the task's own verifier through `pro_grade.py`, a local replay of the official
 * patch-replay grader, not the official harness.
 */
export const SWE_BENCHMARKS: Record<
  SweBenchmark,
  { dataset: string; instances: string; judge: string }
> = {
  verified: {
    dataset: "swe-bench-verified",
    instances: "verified.jsonl",
    judge: "swebench-harness",
  },
  pro: {
    dataset: "swe-bench-pro",
    instances: "pro.jsonl",
    judge: "swebench-pro verifier (local replay of the official verifier)",
  },
};

/** One way of solving an instance with Marina. */
export interface SweArm {
  name: string;
  /** Model for the implementing coding agent. */
  model: string;
  /**
   * Optional second pass: a reviewer (usually another vendor) reads the
   * implementer's working-tree change against the issue and fixes it when it is
   * wrong or incomplete — the verification formation, built from the same
   * general one-shot entry point.
   */
  reviewModel?: string;
}

export interface SwePrediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

export interface SweAttempt {
  instance_id: string;
  arm: string;
  replicate: number;
  exitCode: number;
  reviewExitCode?: number;
  patchBytes: number;
  costUsd: number;
  durationMs: number;
  trajectory: string;
  /** `code verify` results in the session, by outcome (not_run/error are neither pass nor fail). */
  verification?: VerificationCounts;
  /**
   * The session's LAST `code verify` outcome, the item's ledger label:
   * `not_run` when no check executed (not run, or a broken runner) —
   * infrastructure, not a failing change. Absent when the agent never verified.
   */
  lastVerification?: "passed" | "failed" | "not_run";
}

/** Code Mode verification outcomes recorded in one session. */
export interface VerificationCounts {
  passed: number;
  failed: number;
  not_run: number;
  error: number;
}

export function loadInstances(path: string): SweInstance[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SweInstance);
}

/**
 * A seeded subset that mixes repositories: instances are shuffled within each
 * repo, then taken round-robin across repos (largest first), so a small pilot
 * does not end up all Django. Same seed + same input ⇒ same ids, same order.
 */
export function selectSubset(rows: SweInstance[], n: number, seed: number): SweInstance[] {
  const rand = mulberry32(seed);
  const byRepo = new Map<string, SweInstance[]>();
  for (const r of [...rows].sort((a, b) => a.instance_id.localeCompare(b.instance_id))) {
    const list = byRepo.get(r.repo) ?? [];
    list.push(r);
    byRepo.set(r.repo, list);
  }
  const queues = [...byRepo.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([, list]) => {
      const q = [...list];
      for (let i = q.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [q[i], q[j]] = [q[j] as SweInstance, q[i] as SweInstance];
      }
      return q;
    });
  const out: SweInstance[] = [];
  while (out.length < n && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const next = q.shift();
      if (next && out.length < n) out.push(next);
    }
  }
  return out;
}

/** How the agent may check its work: agentless (reason from code) or in the instance's image. */
export type SweMode = "agentless" | "env-image";

const AGENTLESS_NOTE = [
  "This checkout has no installed dependencies, so its tests cannot run here: reason from the code,",
  "and submit a short summary as soon as the fix is in place (do not block on verification).",
];
const ENV_IMAGE_NOTE = [
  "Commands run inside this project's own environment image (dependencies installed, no network).",
  "You may run the project's EXISTING tests to check your change (code test, or code run python -m",
  "pytest <path> / python tests/runtests.py <label>). Keep runs short and targeted, then submit.",
];

/**
 * The issue as the dataset states it. SWE-bench Pro tasks also carry the PR's
 * requirements and its new interfaces (the official task text includes both);
 * Verified instances have neither, so their text is the problem statement alone.
 */
function issueText(inst: SweInstance): string[] {
  const parts = [inst.problem_statement.trim()];
  if (inst.requirements?.trim()) parts.push("", "## Requirements", inst.requirements.trim());
  if (inst.interface?.trim()) parts.push("", "## New Interfaces", inst.interface.trim());
  if (inst.requirements !== undefined || inst.interface !== undefined) {
    parts.push(
      "",
      "Do not reference, look up, or copy existing solutions, external PRs, or online workarounds.",
    );
  }
  return parts;
}

/** The task text the coding agent receives: the issue, nothing else. */
export function taskPrompt(inst: SweInstance, mode: SweMode = "agentless"): string {
  return [
    `Resolve this issue in the ${inst.repo} repository checked out in the current workspace.`,
    "Change the library source so the described problem is fixed. Keep the change minimal and",
    "consistent with the codebase; do not edit or add test files.",
    ...(mode === "env-image" ? ENV_IMAGE_NOTE : AGENTLESS_NOTE),
    "",
    "ISSUE:",
    ...issueText(inst),
  ].join("\n");
}

/** The reviewer's task: judge and, if needed, correct the implementer's change. */
export function reviewPrompt(inst: SweInstance, mode: SweMode = "agentless"): string {
  return [
    `Review the uncommitted change in this ${inst.repo} checkout against the issue below.`,
    "Read the diff (code diff) and the code it touches. If the change does not fully and correctly",
    "fix the issue, or could break existing behavior, fix it with a minimal edit to library source",
    mode === "env-image"
      ? "(never tests). If it is already correct, change nothing. You may run the project's existing tests inside its environment image to check;"
      : "(never tests). If it is already correct, change nothing. Tests cannot run in this checkout;",
    "reason from the code, then submit a one-line verdict (do not block on verification).",
    "",
    "ISSUE:",
    ...issueText(inst),
  ].join("\n");
}

/**
 * The official SWE-bench environment image for an instance (the harness's
 * `sweb.eval.x86_64.<id>` naming, `__` → `_1776_`). The repository sits at
 * `/testbed` at the base commit with the `testbed` conda env installed.
 */
export function sweEnvImage(instanceId: string, namespace = "docker.io/swebench"): string {
  return `${namespace}/sweb.eval.x86_64.${instanceId.toLowerCase().replace(/__/g, "_1776_")}:latest`;
}

/**
 * Environment that puts a `marina -p` session's finite commands in the instance's
 * own image (Marina's general container runner, `MARINA_CODE_CONTAINER_*`):
 * patch sync applies the agent's pending diff to /testbed inside a throwaway
 * container per command; no network; nothing on the host is mounted.
 */
export function envImageRunnerEnv(instanceId: string): Record<string, string> {
  return {
    MARINA_CODE_CONTAINER_IMAGE: sweEnvImage(instanceId),
    MARINA_CODE_CONTAINER_SYNC: "patch",
    MARINA_CODE_CONTAINER_WORKDIR: "/testbed",
    MARINA_CODE_CONTAINER_SHELL: "bash",
    MARINA_CODE_CONTAINER_INIT: "source /opt/miniconda3/bin/activate testbed",
  };
}

type Run = (
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Default process runner (Bun.spawn); tests inject a fake. */
export const spawnRun: Run = async (argv, opts) => {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env } as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : undefined;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
};

async function git(run: Run, args: string[], cwd?: string): Promise<string> {
  const r = await run(["git", ...args], { cwd, timeoutMs: 600_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.slice(0, 400)}`);
  return r.stdout;
}

/**
 * A clean, isolated checkout that holds the base commit and nothing else.
 *
 * Repositories are mirrored once per data directory, but the mirror never
 * becomes part of the workspace: each attempt gets a fresh `git init` and a
 * depth-1 fetch of the base commit alone (no tags, no FETCH_HEAD, no remote,
 * no alternates). Commits after the base, including the gold fix, are therefore
 * not in the workspace under any ref, reflog entry or loose object, so the
 * agent cannot recover them with `git log --all`, `git show <sha>`, `reflog`,
 * `fsck` or `cat-file`. HEAD is detached at the real base sha, so `git diff
 * HEAD` is a patch against the base the grader applies it to.
 *
 * {@link assertWorkspaceIsolated} then checks the result and throws (the
 * instance fails, unrecorded) if anything beyond the base is reachable.
 */
export async function prepareWorkspace(
  inst: SweInstance,
  dataDir: string,
  workDir: string,
  run: Run = spawnRun,
): Promise<void> {
  const mirror = join(dataDir, "mirrors", `${inst.repo.replace("/", "__")}.git`);
  if (!existsSync(mirror)) {
    mkdirSync(join(dataDir, "mirrors"), { recursive: true });
    await git(run, ["clone", "--quiet", "--mirror", `https://github.com/${inst.repo}.git`, mirror]);
  }
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  // `--template=` keeps the default template (sample hooks, description) out of the workspace.
  await git(run, ["init", "--quiet", "--template=", workDir]);
  // Nothing the agent does later should start a reflog either.
  await git(run, ["config", "core.logAllRefUpdates", "false"], workDir);
  await git(
    run,
    [
      // Older servers refuse a bare sha `want` unless allowed; the mirror is local.
      "-c",
      "uploadpack.allowAnySHA1InWant=true",
      "fetch",
      "--quiet",
      "--depth=1",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      mirror,
      inst.base_commit,
    ],
    workDir,
  );
  await git(
    run,
    ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", inst.base_commit],
    workDir,
  );
  // The checkout records "moving from … to <base>" in logs/HEAD; drop every leftover
  // pointer the checkout or fetch could have written.
  for (const leftover of ["logs", "FETCH_HEAD", "ORIG_HEAD"]) {
    rmSync(join(workDir, ".git", leftover), { recursive: true, force: true });
  }
  await assertWorkspaceIsolated(workDir, inst.base_commit, run);
}

/** Files and directories inside `.git` that could point past the base commit. */
const HISTORY_POINTERS = [
  "objects/info/alternates",
  "objects/info/http-alternates",
  "packed-refs",
  "logs",
  "FETCH_HEAD",
  "ORIG_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "worktrees",
  "modules",
];

async function gitLines(run: Run, args: string[], cwd: string): Promise<string[]> {
  return (await git(run, args, cwd)).split("\n").filter((l) => l.trim());
}

/**
 * Everything in a prepared workspace that could expose history beyond `base`
 * (an empty list means the workspace holds the base commit and nothing else):
 * HEAD elsewhere, any ref, remote, reflog, stash, alternates or pointer file,
 * any commit or tag object other than the base, any object not reachable from
 * the base, or a resolvable `forbidden` sha (e.g. a known gold commit).
 */
export async function workspaceLeaks(
  workDir: string,
  base: string,
  run: Run = spawnRun,
  forbidden: string[] = [],
): Promise<string[]> {
  const problems: string[] = [];
  const head = (await git(run, ["rev-parse", "--verify", "HEAD^{commit}"], workDir)).trim();
  const baseSha = (await git(run, ["rev-parse", "--verify", `${base}^{commit}`], workDir)).trim();
  if (head !== baseSha) problems.push(`HEAD is ${head}, not the base ${baseSha}`);
  const refs = await gitLines(run, ["for-each-ref", "--format=%(refname)"], workDir);
  if (refs.length) problems.push(`refs present: ${refs.join(", ")}`);
  const remotes = await gitLines(run, ["remote"], workDir);
  if (remotes.length) problems.push(`remotes present: ${remotes.join(", ")}`);
  for (const p of HISTORY_POINTERS) {
    if (existsSync(join(workDir, ".git", p))) problems.push(`.git/${p} present`);
  }
  const reflog = await gitLines(run, ["reflog", "--all", "--format=%H"], workDir);
  if (reflog.length) problems.push(`reflog entries present: ${reflog.length}`);
  // Every commit any ref or reflog reaches must be the base itself.
  const reachable = await gitLines(run, ["rev-list", "--all", "--reflog", "HEAD"], workDir);
  const beyond = reachable.filter((sha) => sha !== baseSha);
  if (beyond.length) problems.push(`commits other than the base reachable: ${beyond.length}`);
  // Every object in the store (loose, packed or unreachable) must come from the base tree.
  const fromBase = new Set(
    (await gitLines(run, ["rev-list", "--objects", baseSha], workDir)).map((l) => l.slice(0, 40)),
  );
  const stored = await gitLines(
    run,
    ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
    workDir,
  );
  const extra = stored.filter((l) => !fromBase.has(l.slice(0, l.indexOf(" "))));
  if (extra.length) {
    const kinds = new Map<string, number>();
    for (const l of extra) {
      const kind = l.slice(l.indexOf(" ") + 1);
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    problems.push(
      `objects not reachable from the base: ${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ")}`,
    );
  }
  for (const sha of forbidden) {
    const r = await run(["git", "cat-file", "-e", `${sha}^{object}`], {
      cwd: workDir,
      timeoutMs: 60_000,
    });
    if (r.code === 0) problems.push(`forbidden object ${sha} is resolvable`);
  }
  return problems;
}

/** Fail closed: throw unless the workspace holds the base commit's history only. */
export async function assertWorkspaceIsolated(
  workDir: string,
  base: string,
  run: Run = spawnRun,
  forbidden: string[] = [],
): Promise<void> {
  const problems = await workspaceLeaks(workDir, base, run, forbidden);
  if (problems.length) {
    throw new Error(`workspace exposes history beyond ${base}: ${problems.join("; ")}`);
  }
}

/** The working-tree change (including new files) as a unified diff. */
export async function collectPatch(workDir: string, run: Run = spawnRun): Promise<string> {
  await git(run, ["add", "--intent-to-add", "--all"], workDir);
  return git(run, ["diff", "--no-color", "--no-ext-diff", "--binary", "HEAD"], workDir);
}

/** The per-folder database `marina -p` uses for a workspace (scripts/code.ts). */
export function sessionHome(workDir: string, slug: (p: string) => string): string {
  return join(homedir(), ".marina", "projects", slug(resolve(workDir)));
}

/** Total upstream spend recorded by a session's Marina (spend_daily). */
export function sessionSpend(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM spend_daily").get() as {
      c: number;
    } | null;
    return row?.c ?? 0;
  } catch {
    // allow-empty-catch: an older or partial session DB without spend_daily costs 0
    return 0;
  } finally {
    db.close();
  }
}

/**
 * The session's `code verify` outcomes (Code Mode's `verification` artifacts).
 * Legacy rows store `complete`/`failed`; a check that never ran is `not_run`,
 * a broken runner `error`. Descriptive only: never a grading signal.
 */
export function sessionVerification(dbPath: string): VerificationCounts {
  const counts: VerificationCounts = { passed: 0, failed: 0, not_run: 0, error: 0 };
  if (!existsSync(dbPath)) return counts;
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        "SELECT status, COUNT(*) AS n FROM coding_artifacts WHERE kind = 'verification' GROUP BY status",
      )
      .all() as { status: string; n: number }[];
    for (const row of rows) {
      const outcome = row.status === "complete" ? "passed" : row.status;
      if (outcome in counts) counts[outcome as keyof VerificationCounts] += row.n;
    }
  } catch {
    // allow-empty-catch: an older or partial session DB without coding artifacts recorded none
  } finally {
    db.close();
  }
  return counts;
}

/**
 * One Code Mode verification artifact as a ledger state. Code Mode's
 * `metadata.outcome` (or a `metadata.state`) wins: `passed` / `failed` /
 * `not_run`, and `error` (a broken runner — no check ran) is `not_run`; the
 * `ran/…` / `infra/not-run` spellings are accepted. Otherwise the status
 * decides (`complete` passed; `not_run` / `error` never ran), and a legacy
 * failed artifact whose checks never executed (no command ran — dependency
 * preparation failed first) is `not_run`.
 */
export function verificationState(
  status: string,
  metadata: Record<string, unknown>,
): "passed" | "failed" | "not_run" {
  const explicit = String(metadata.outcome ?? metadata.state ?? "")
    .toLowerCase()
    .replace(/^(ran|infra)\//, "")
    .replace("-", "_");
  if (explicit === "passed" || explicit === "failed" || explicit === "not_run") return explicit;
  if (explicit === "error" || status === "not_run" || status === "error") return "not_run";
  if (status === "complete") return "passed";
  const commands = Array.isArray(metadata.commands) ? metadata.commands : [];
  const prep = metadata.preparation as { status?: string } | undefined;
  if (commands.length === 0 || prep?.status === "failed") return "not_run";
  return "failed";
}

/** The last verification state recorded in a session database, if the agent ever verified. */
export function sessionLastVerification(dbPath: string): SweAttempt["lastVerification"] {
  if (!existsSync(dbPath)) return undefined;
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query(
        "SELECT status, metadata_json FROM coding_artifacts WHERE kind = 'verification' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get() as { status: string; metadata_json: string } | null;
    if (!row) return undefined;
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      // allow-empty-catch: unreadable metadata classifies from the status alone
    }
    return verificationState(row.status, metadata);
  } catch {
    // allow-empty-catch: an older or partial session DB has no verification record
    return undefined;
  } finally {
    db.close();
  }
}

export interface AttemptOptions {
  repoRoot: string;
  dataDir: string;
  outDir: string;
  replicate: number;
  timeoutMs: number;
  slug: (p: string) => string;
  run?: Run;
  /** Opt-in: run the agent's commands inside the instance's environment image. */
  mode?: SweMode;
  /**
   * The most this attempt's session may spend (its own Marina's daily cap,
   * implementer and reviewer together). Default {@link DEFAULT_ATTEMPT_CAP_USD}.
   */
  capUsd?: number;
}

/** A single attempt's cap when the run has no `--max-usd` budget. */
export const DEFAULT_ATTEMPT_CAP_USD = 25;

/** One instance × arm × replicate: checkout → implement (→ review) → patch, trajectory, cost. */
export async function attemptInstance(
  inst: SweInstance,
  arm: SweArm,
  o: AttemptOptions,
): Promise<{ attempt: SweAttempt; prediction: SwePrediction }> {
  const run = o.run ?? spawnRun;
  const tag = `${arm.name}-r${o.replicate}`;
  const workDir = join(o.dataDir, "work", tag, inst.instance_id);
  const trajDir = join(o.outDir, "trajs");
  mkdirSync(trajDir, { recursive: true });
  const started = Date.now();
  await prepareWorkspace(inst, o.dataDir, workDir, run);
  const home = sessionHome(workDir, o.slug);
  rmSync(home, { recursive: true, force: true });
  const mode = o.mode ?? "agentless";
  const env = {
    MARINA_CODE_TASK_TIMEOUT_MS: String(o.timeoutMs),
    MARINA_DAILY_SPEND_CAP_USD: capEnvValue(
      Math.min(o.capUsd ?? DEFAULT_ATTEMPT_CAP_USD, DEFAULT_ATTEMPT_CAP_USD),
    ),
    ...(mode === "env-image" ? envImageRunnerEnv(inst.instance_id) : {}),
  };
  const marina = (task: string, model: string) =>
    run(["bun", "run", "scripts/marina.ts", "-p", task, workDir, "--model", model], {
      cwd: o.repoRoot,
      env,
      timeoutMs: o.timeoutMs + 120_000,
    });
  const impl = await marina(taskPrompt(inst, mode), arm.model);
  let review: Awaited<ReturnType<Run>> | undefined;
  if (arm.reviewModel) review = await marina(reviewPrompt(inst, mode), arm.reviewModel);
  const patch = await collectPatch(workDir, run);
  const dbPath = join(home, "marina.db");
  const costUsd = sessionSpend(dbPath);
  const verification = sessionVerification(dbPath);
  const lastVerification = sessionLastVerification(dbPath);
  const trajectory = join(trajDir, `${inst.instance_id}.md`);
  writeFileSync(
    trajectory,
    [
      `# ${inst.instance_id} · ${tag}`,
      `implementer: ${arm.model} (exit ${impl.code})`,
      "## implementer stream",
      impl.stdout,
      impl.stderr,
      ...(review
        ? [`## reviewer: ${arm.reviewModel} (exit ${review.code})`, review.stdout, review.stderr]
        : []),
      "## final patch",
      "```diff",
      patch,
      "```",
    ].join("\n"),
  );
  // Keep the session database beside the trajectory (the Marina-side record of every turn).
  if (existsSync(home)) {
    const keep = join(o.outDir, "sessions", inst.instance_id);
    mkdirSync(join(o.outDir, "sessions"), { recursive: true });
    rmSync(keep, { recursive: true, force: true });
    renameSync(home, keep);
  }
  rmSync(workDir, { recursive: true, force: true });
  return {
    attempt: {
      instance_id: inst.instance_id,
      arm: arm.name,
      replicate: o.replicate,
      exitCode: impl.code,
      ...(review ? { reviewExitCode: review.code } : {}),
      patchBytes: patch.length,
      costUsd,
      durationMs: Date.now() - started,
      trajectory,
      verification,
      ...(lastVerification ? { lastVerification } : {}),
    },
    prediction: {
      instance_id: inst.instance_id,
      model_name_or_path: `marina-${tag}`,
      model_patch: patch,
    },
  };
}

/**
 * Map the official harness report onto the harness-result shape the ledger imports.
 * Instances the harness could not grade (`error_ids`: image, container or
 * harness failures) are infrastructure exclusions, never counted as unresolved;
 * they are listed in `metadata.excluded`.
 */
export function ledgerResult(
  report: { resolved_ids?: string[]; error_ids?: string[] },
  attempts: SweAttempt[],
  meta: {
    arm: SweArm;
    replicate: number;
    /** The subset's seed; null when the ids were given explicitly (`--ids`). */
    subsetSeed: number | null;
    benchmark?: SweBenchmark;
    /**
     * The instance ids the run was asked to attempt. An id with no recorded
     * attempt (the agent run threw before recording one) is an agent failure:
     * it is filed as unresolved at zero recorded cost, never silently dropped.
     */
    expectedIds?: string[];
    /**
     * When the run finished (epoch ms) — e.g. the last attempt's write. Fixed for
     * a finished run, so filing it again is the same document; never the time of
     * filing.
     */
    completedAt?: number;
  },
) {
  const resolved = new Set(report.resolved_ids ?? []);
  const errored = new Set(report.error_ids ?? []);
  const recorded = new Set(attempts.map((a) => a.instance_id));
  const missingAttempts = (meta.expectedIds ?? []).filter((id) => !recorded.has(id));
  const all: SweAttempt[] = [
    ...attempts,
    ...missingAttempts.map((id) => ({
      instance_id: id,
      arm: meta.arm.name,
      replicate: meta.replicate,
      exitCode: -1,
      patchBytes: 0,
      costUsd: 0,
      durationMs: 0,
      trajectory: "",
    })),
  ];
  const graded = all.filter((a) => !errored.has(a.instance_id));
  const excluded = all.filter((a) => errored.has(a.instance_id)).map((a) => a.instance_id);
  const items = graded.map((a) => ({
    id: a.instance_id,
    correct: resolved.has(a.instance_id),
    score: resolved.has(a.instance_id) ? 1 : 0,
    latencyMs: a.durationMs,
    usage: { costUsd: a.costUsd },
    // The item's ledger label: the session's last verification state.
    ...(a.lastVerification ? { verification: a.lastVerification } : {}),
  }));
  const correct = items.filter((i) => i.correct).length;
  // In-loop verification outcomes, summed over graded attempts. Descriptive: a
  // not_run or error never counts as a failed (or passed) verification.
  const verification: VerificationCounts = { passed: 0, failed: 0, not_run: 0, error: 0 };
  for (const a of graded)
    for (const key of Object.keys(verification) as (keyof VerificationCounts)[])
      verification[key] += a.verification?.[key] ?? 0;
  // Per item, the last state: a check that never ran is not a failed check.
  const checks = verificationCounts(items);
  return {
    config: {
      dataset: SWE_BENCHMARKS[meta.benchmark ?? "verified"].dataset,
      mode: "agent",
      model: meta.arm.model,
      ...(meta.arm.reviewModel ? { reviewModel: meta.arm.reviewModel } : {}),
      seed: meta.subsetSeed,
      replicate: meta.replicate,
    },
    ...(meta.completedAt !== undefined ? { timestamp: Math.round(meta.completedAt) } : {}),
    duration_ms: graded.reduce((t, a) => t + a.durationMs, 0),
    scores: { overall: items.length ? correct / items.length : 0 },
    metadata: {
      arm: meta.arm.name,
      judge: SWE_BENCHMARKS[meta.benchmark ?? "verified"].judge,
      excluded,
      missingAttempts,
      verification,
      // `not_run` (the checks never executed) is infrastructure, never a failed check.
      itemVerification: {
        passed: checks.passed,
        failed: checks.failed,
        not_run: checks.notRun,
        never_requested: checks.unreported,
      },
    },
    items,
  };
}
