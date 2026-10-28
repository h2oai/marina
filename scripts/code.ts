#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * marina code — "Claude/Codex in any folder".
 *
 * Boots a folder-scoped Marina (empty world, no room agents) and drops you
 * straight into agentic Code Mode for that directory: type a task in plain
 * English and a bound coding agent explores, edits, and runs checks —
 * streaming its work back. The minimum end of the pervasive-Marina spectrum:
 * an agent in a folder, no world/ports/civics ceremony.
 *
 * The database persists per folder (~/.marina/projects/<slug>/marina.db) so
 * sessions, artifacts, and memory accrete across launches; `--fresh` (or
 * MARINA_CODE_FRESH=1) restores the old throwaway-DB behavior.
 *
 * Usage:
 *   bun run code [dir]        # dir defaults to the current directory
 *   marina [dir]              # same flow via the dispatcher bin
 *   marina -p "<task>" [dir]  # one-shot: dispatch, stream, exit 0/1/2
 *
 * Needs an LLM provider key in the environment (ANTHROPIC_API_KEY, etc.) or a
 * local llama server — same as any coding agent. Exit with Ctrl-D / Ctrl-C.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { diffStat } from "../src/coding/unified-diff";
import { formatAge } from "../src/engine/commands/format-duration";
import { waitForDatabaseLease } from "../src/persistence/database-lease";
import { IS_COMPILED } from "../src/runtime-paths";
import { MarinaAgent, type Perception } from "../src/sdk/client";
import { MARINA_VERSION } from "../src/version";
import { applyCliEnvironment, userMarinaDir } from "./cli-env";
import { CodeConsole } from "./code-console";
import { HarnessStore, validateHarness } from "./code-harness";
import { inferCodeDefaultModel } from "./code-model";
import { installedCodingAdapters } from "./code-native";
import { styleStartupLine, themeFor } from "./code-style";
import { formatCodePerception, terminalText } from "./code-terminal";
import { tipLines, welcomeCard } from "./term-frame";

const REPO_ROOT = resolve(import.meta.dir, "..");
const STDERR_TAIL_LINES = 40;
const DEFAULT_TASK_TIMEOUT_MS = 600_000;

export interface CodeSessionOptions {
  tui?: boolean;
  /** Ephemeral tmp DB, deleted on exit (the pre-persistence behavior). */
  fresh?: boolean;
  agent?: string;
  model?: string;
  profile?: string;
  harness?: string;
  /** One-shot task: dispatch it, stream output, await completion, exit 0/1/2. */
  print?: string;
  /** Prompt (y/N/a) for each non-allowlisted host command (`--allow-exec`). */
  allowExec?: boolean;
  /** Auto-approve every host command with no prompt (`--dangerously-allow-all`). */
  dangerouslyAllowAll?: boolean;
  /** Print startup details (database, endpoints, federation address). */
  verbose?: boolean;
  /** `-p`: exit 0 for completed work that was not verified (it is still reported). */
  allowUnverified?: boolean;
  /**
   * `-p` only: the verification the task must pass (`code do verification:<mode>`);
   * default `MARINA_CODE_VERIFICATION`, else `delivery`.
   */
  verification?: "checks" | "candidate" | "delivery";
  /** The coder's thinking level, passed to the folder server as `MARINA_CODE_THINKING`. */
  thinking?: string;
  /** Code Mode driver for the session before the task (`code driver <name>`). */
  driver?: "single" | "crew";
  /** `-p`: one JSON result object as the last stdout line; human output goes to stderr. */
  json?: boolean;
}

/**
 * The budget a one-shot hands its coder: the task timeout less a margin for
 * the result to travel back, so the budget-forced submission lands before the
 * CLI gives up.
 */
export function oneShotBudgetMs(timeoutMs: number): number {
  return Math.max(1_000, timeoutMs - Math.min(10_000, Math.round(timeoutMs * 0.02)));
}

/**
 * A one-shot's verification requirement: the flag, else `MARINA_CODE_VERIFICATION`
 * (checks | candidate | delivery), else `delivery` — every stated requirement
 * observed by a check or reported unverified.
 */
export function printVerification(
  flag: CodeSessionOptions["verification"],
  env: NodeJS.ProcessEnv = process.env,
): "checks" | "candidate" | "delivery" {
  if (flag) return flag;
  const v = env.MARINA_CODE_VERIFICATION?.trim().toLowerCase();
  return v === "checks" || v === "candidate" ? v : "delivery";
}

/** Interactive host-exec approval posture negotiated with the server. */
export type ExecMode = "off" | "prompt" | "auto";

export interface ExecModeResolution {
  mode: ExecMode;
  /**
   * A human-facing message explaining why exec stayed allowlist-only despite a
   * flag being set (only present when a requested flag was refused).
   */
  refusal?: string;
}

/**
 * Pure decision: given the exec flags and whether stdin is an owned TTY, what
 * exec posture do we ask the server for? Neither flag → "off" (today's
 * allowlist-only behavior, no exec-mode sent). Either flag without a TTY is
 * refused — a non-interactive pipe is never treated as operator consent, so we
 * stay "off" and surface a reason. `--dangerously-allow-all` (auto) wins over
 * `--allow-exec` (prompt) when both are given.
 */
export function resolveExecMode(
  opts: Pick<CodeSessionOptions, "allowExec" | "dangerouslyAllowAll">,
  isTTY: boolean,
): ExecModeResolution {
  const wantsAuto = opts.dangerouslyAllowAll === true;
  const wantsPrompt = opts.allowExec === true;
  if (!wantsAuto && !wantsPrompt) return { mode: "off" };
  if (!isTTY) {
    const flag = wantsAuto ? "--dangerously-allow-all" : "--allow-exec";
    return {
      mode: "off",
      refusal:
        `${flag} requires an interactive local terminal (stdin must be a TTY you own); ` +
        "staying allowlist-only.",
    };
  }
  return { mode: wantsAuto ? "auto" : "prompt" };
}

/** Shape of the exec-approval payload the server attaches to a perception. */
export interface ExecApprovalPayload {
  token: string;
  argv: string[];
  cwd: string;
  rendered: string;
}

/** Extract the exec-approval request from a perception, if it is one. */
export function execApprovalRequest(p: Perception): ExecApprovalPayload | undefined {
  const payload = (p.data as Record<string, unknown> | undefined)?.execApproval as
    | Record<string, unknown>
    | undefined;
  if (!payload) return undefined;
  const token = typeof payload.token === "string" ? payload.token : undefined;
  const rendered = typeof payload.rendered === "string" ? payload.rendered : undefined;
  if (!token || !rendered) return undefined;
  const argv = Array.isArray(payload.argv)
    ? (payload.argv.filter((a) => typeof a === "string") as string[])
    : [];
  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  return { token, argv, cwd, rendered };
}

/**
 * Stable, filesystem-safe per-folder identity: `<basename>-<8-hex-hash>` of
 * the absolute path. The hash disambiguates same-named folders; the basename
 * keeps ~/.marina/projects human-navigable.
 */
export function projectSlug(absPath: string): string {
  const base =
    basename(absPath)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 40) || "project";
  const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * Extract the machine-readable end-of-task signal from a perception, if it is
 * one. Emitted by the engine's Code Mode lifecycle stream (`sendCode`/`notify`
 * with `code.event === "code_lifecycle"`): `completed` is always terminal;
 * `failed` is terminal only when flagged (agent death, stop-interrupt) —
 * recoverable mid-run tool errors also stream as `failed` but never carry
 * `terminal: true`.
 */
/** A run's end, as the one-shot exit decides on it. */
export interface CodeLifecycleEnd {
  phase: "completed" | "failed";
  sessionId?: string;
  summary?: string;
  /** The run's recorded verification (`passed`, `missing`, `failed`, …). */
  verification?: string;
  verificationReason?: string;
  /** Delivery mode: stated requirements and whether a passing check observed each. */
  requirements?: CodeRequirementCoverage;
  reason?: string;
  /** The full reason when `reason` is a category (`blocked`). */
  detail?: string;
  /** Interpretations recorded where no person could answer (`code assume`, answered blocks). */
  assumptions?: CodeAssumption[];
  /** Submitted at the budget's final-answer point, or ended by a spend stop (`reason: "spend"`):
   * a labelled best effort, never a free answer. */
  budgetForced?: { reason: string; used: number; cap: number };
  taskId?: number;
  runId?: string;
}

export interface CodeAssumption {
  text: string;
  source: "worker" | "block";
}

function lifecycleAssumptions(metadata: Record<string, unknown>): CodeAssumption[] | undefined {
  if (!Array.isArray(metadata.assumptions)) return undefined;
  const list = metadata.assumptions.flatMap((item) => {
    const entry = item as Record<string, unknown> | null;
    return entry && typeof entry.text === "string"
      ? [{ text: entry.text, source: entry.source === "block" ? "block" : "worker" } as const]
      : [];
  });
  return list.length ? list : undefined;
}

/** The human-readable assumption block printed after a one-shot result. */
export function formatAssumptions(assumptions: CodeAssumption[] | undefined): string | undefined {
  if (!assumptions?.length) return undefined;
  return [
    "Assumptions (no person could answer during this run):",
    ...assumptions.map((a) => `  - ${a.source === "block" ? "[answered block] " : ""}${a.text}`),
  ].join("\n");
}

export interface CodeRequirementCoverage {
  listed: boolean;
  verified: string[];
  unverified: string[];
  notCheckable: { text: string; reason: string }[];
}

function lifecycleRequirements(value: unknown): CodeRequirementCoverage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const texts = (list: unknown) =>
    Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
  return {
    listed: raw.listed === true,
    verified: texts(raw.verified),
    unverified: texts(raw.unverified),
    notCheckable: Array.isArray(raw.notCheckable)
      ? raw.notCheckable.flatMap((item) => {
          const entry = item as Record<string, unknown> | null;
          return entry && typeof entry.text === "string"
            ? [{ text: entry.text, reason: typeof entry.reason === "string" ? entry.reason : "" }]
            : [];
        })
      : [],
  };
}

/**
 * Stated requirements that keep a delivery from counting as verified: no checklist at all,
 * a requirement no passing check observed, or a checklist where nothing was observed
 * (every requirement declared not machine-checkable).
 *
 * A requirement declared `notCheckable` with a reason (a prohibition such as "do not read
 * /tests", or which paths an external collector reads) is not counted against an otherwise
 * observed delivery: no finite check over delivered files can observe it, so counting it
 * would only reward leaving it out of the checklist. The server's submission gate applies the
 * same rule (`requirementsComplete`). It is still listed apart, never as verified
 * (`notCheckableRequirements`).
 */
export function unverifiedRequirements(coverage: CodeRequirementCoverage | undefined): string[] {
  if (!coverage) return [];
  if (!coverage.listed) return ["no acceptance checklist was recorded"];
  if (!coverage.verified.length && !coverage.unverified.length)
    return [
      "no stated requirement is observed by a passing check",
      ...notCheckableRequirements(coverage),
    ];
  return coverage.unverified;
}

/** Requirements declared not machine-checkable, with their reasons (recorded, never verified). */
export function notCheckableRequirements(coverage: CodeRequirementCoverage | undefined): string[] {
  return (coverage?.notCheckable ?? []).map(
    ({ text, reason }) => `${text} (not machine-checkable: ${reason})`,
  );
}

/** `marina -p` exit codes. */
export const PRINT_EXIT = {
  verified: 0,
  failed: 1,
  timeout: 2,
  unverified: 3,
} as const;

/**
 * The one-shot outcome: completed AND verified is success (0); completed
 * without passing verification is 3, unless the caller accepts unverified
 * work (`--allow-unverified`, then 0 with the same notice); failed is 1,
 * timed out 2. A budget-forced submission follows the same rule: verified
 * only when its checks passed.
 */
export function printOutcome(
  end: CodeLifecycleEnd | "timeout" | undefined,
  allowUnverified = false,
): {
  status: "verified" | "unverified" | "failed" | "timeout";
  exitCode: number;
  notice?: string;
} {
  if (end === "timeout") return { status: "timeout", exitCode: PRINT_EXIT.timeout };
  if (!end || end.phase === "failed") return { status: "failed", exitCode: PRINT_EXIT.failed };
  const unobserved = unverifiedRequirements(end.requirements);
  if (end.verification === "passed" && !unobserved.length) {
    const declared = notCheckableRequirements(end.requirements);
    return declared.length
      ? {
          status: "verified",
          exitCode: PRINT_EXIT.verified,
          notice: `Verified. Declared not machine-checkable (recorded, not observed by a check): ${declared.join("; ")}`,
        }
      : { status: "verified", exitCode: PRINT_EXIT.verified };
  }
  const notice =
    end.verification === "passed"
      ? `Completed but not verified: checks passed, but no passing check observed ${unobserved.length === 1 ? "this stated requirement" : "these stated requirements"}: ${unobserved.join("; ")}`
      : `Completed but not verified: ${end.verification ?? "unknown"}${end.verificationReason ? ` — ${end.verificationReason}` : ""}`;
  return {
    status: "unverified",
    exitCode: allowUnverified ? PRINT_EXIT.verified : PRINT_EXIT.unverified,
    notice,
  };
}

/** The one JSON object `marina -p --json` prints last on stdout; `exitCode` is the process's. */
export function printResultJson(
  outcome: ReturnType<typeof printOutcome>,
  end: CodeLifecycleEnd | undefined,
  files: Array<{ path: string; added: number; removed: number }>,
  durationMs: number,
) {
  return {
    status: outcome.status,
    exitCode: outcome.exitCode,
    verification: end?.verification ?? null,
    verificationReason: end?.verificationReason ?? null,
    reason: end?.detail ?? end?.reason ?? null,
    assumptions: end?.assumptions ?? [],
    budgetForced: end?.budgetForced ?? null,
    requirements: end?.requirements ?? null,
    taskId: end?.taskId ?? null,
    runId: end?.runId ?? null,
    files,
    durationMs,
  };
}

function lifecycleBudgetForced(value: unknown): CodeLifecycleEnd["budgetForced"] {
  const v = value as { reason?: unknown; used?: unknown; cap?: unknown } | undefined;
  return v &&
    typeof v.reason === "string" &&
    typeof v.used === "number" &&
    typeof v.cap === "number"
    ? { reason: v.reason, used: v.used, cap: v.cap }
    : undefined;
}

export function terminalCodeLifecycle(p: Perception): CodeLifecycleEnd | undefined {
  if (p.kind !== "message") return undefined;
  const code = (p.data as Record<string, unknown> | undefined)?.code as
    | Record<string, unknown>
    | undefined;
  if (code?.event !== "code_lifecycle") return undefined;
  const metadata = (code.metadata ?? {}) as Record<string, unknown>;
  const sessionId = typeof code.sessionId === "string" ? code.sessionId : undefined;
  const assumptions = lifecycleAssumptions(metadata);
  if (code.phase === "completed") {
    return {
      phase: "completed",
      sessionId,
      summary: typeof metadata.summary === "string" ? metadata.summary : undefined,
      ...(typeof metadata.verification === "string" ? { verification: metadata.verification } : {}),
      ...(typeof metadata.verificationReason === "string"
        ? { verificationReason: metadata.verificationReason }
        : {}),
      ...(lifecycleRequirements(metadata.requirements)
        ? { requirements: lifecycleRequirements(metadata.requirements) }
        : {}),
      ...(typeof metadata.taskId === "number" ? { taskId: metadata.taskId } : {}),
      ...(typeof metadata.runId === "string" ? { runId: metadata.runId } : {}),
      ...(assumptions ? { assumptions } : {}),
      ...(lifecycleBudgetForced(metadata.budgetForced)
        ? { budgetForced: lifecycleBudgetForced(metadata.budgetForced) }
        : {}),
    };
  }
  if (code.phase === "failed" && metadata.terminal === true) {
    return {
      phase: "failed",
      sessionId,
      reason: typeof metadata.reason === "string" ? metadata.reason : undefined,
      ...(typeof metadata.detail === "string" ? { detail: metadata.detail } : {}),
      ...(typeof metadata.taskId === "number" ? { taskId: metadata.taskId } : {}),
      ...(typeof metadata.runId === "string" ? { runId: metadata.runId } : {}),
      ...(assumptions ? { assumptions } : {}),
      ...(lifecycleBudgetForced(metadata.budgetForced)
        ? { budgetForced: lifecycleBudgetForced(metadata.budgetForced) }
        : {}),
    };
  }
  return undefined;
}

/** Ignore other sessions and delayed terminal events from an older attempt. */
export function codingTaskCompletionMatcher(sessionId?: string): (p: Perception) => boolean {
  let runId: string | undefined;
  return (p) => {
    const code = p.data?.code as
      | { event?: string; sessionId?: string; phase?: string; metadata?: { runId?: string } }
      | undefined;
    if (code?.event !== "code_lifecycle" || (sessionId && code.sessionId !== sessionId))
      return false;
    if (code.phase === "received" && typeof code.metadata?.runId === "string")
      runId = code.metadata.runId;
    return !!runId && code.metadata?.runId === runId && terminalCodeLifecycle(p) !== undefined;
  };
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

/**
 * Wait until OUR server answers on `port`. The port was free when probed, but
 * another process can take it while the server boots (seconds on a loaded
 * machine); then ours dies on the bind and a foreign Marina answers on the
 * port. Ready therefore means the answer names this child's pid, so the
 * session never attaches to someone else's world.
 */
export async function waitForReady(
  port: number,
  server: { pid: number; exited: Promise<number> },
  timeoutMs = 30_000,
): Promise<boolean> {
  const { exited } = server;
  // A server that died during boot (a held lease, a bad config) cannot come
  // up: stop polling at once instead of waiting out the whole deadline.
  let dead = false;
  void exited.then(() => {
    dead = true;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !dead) {
    try {
      const res = await fetch(`http://localhost:${port}/api/setup-status`);
      if (res.ok && ((await res.json()) as { pid?: unknown }).pid === server.pid) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * A status line on stderr in the terminal's own colour. `console.error` is
 * printed red on a terminal, which makes ordinary news look like a failure;
 * real errors still use it.
 */
function say(line: string): void {
  const stream = process.stderr;
  process.stderr.write(`${styleStartupLine(line, themeFor(stream.isTTY ? stream : undefined))}\n`);
}

/** The interactive first page: the shared welcome card (`term-frame.ts`) on stderr. */
function printWelcome(session: { dir: string; agentLabel: string; resumed?: string }): void {
  const stream = process.stderr;
  const theme = themeFor(stream);
  const muted = theme.fg("muted");
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    // allow-empty-catch: no passwd entry (containers); the greeting goes without a name.
  }
  const home = homedir();
  const full = session.dir.startsWith(`${home}/`)
    ? `~${session.dir.slice(home.length)}`
    : session.dir;
  // A deep path keeps its end: the folder is the part that says where you are.
  const where = full.length > 40 ? `…${full.slice(-39)}` : full;
  const card = welcomeCard(
    {
      title: `Marina ${MARINA_VERSION}`,
      greeting: `${session.resumed ? "Welcome back" : "Welcome"}${user ? `, ${user}` : ""}!`,
      details: [muted(session.agentLabel), theme.fg("info")(where)],
      sections: [
        {
          title: "Tips for getting started",
          lines: tipLines(theme, [
            ["<task>", "say what you want done, in plain words"],
            ["/plan <request>", "propose first, write nothing"],
            ["/project", "readiness and the verify recipe"],
            ["/help", "everything else"],
          ]),
        },
        {
          title: session.resumed ? "Resuming" : "Session",
          lines: [muted(session.resumed?.replace(/^Resuming /, "") ?? "New session.")],
        },
      ],
    },
    theme,
    { columns: stream.columns || 80, rows: stream.rows || 24 },
  );
  stream.write(`\n${card.join("\n")}\n\n`);
}

/** Where a folder's running server announces itself (persistent sessions only). */
export function serverInfoPath(projectDirectory: string): string {
  return join(projectDirectory, "server.json");
}

export interface FolderServer {
  pid: number;
  port: number;
  startedAt: number;
}

/**
 * The server already running for this folder, if one is: its announcement
 * exists, its process is alive, and its port answers. A stale announcement
 * (dead process, silent port) is removed and ignored.
 */
export async function runningFolderServer(
  projectDirectory: string,
): Promise<FolderServer | undefined> {
  const path = serverInfoPath(projectDirectory);
  let info: FolderServer;
  try {
    info = JSON.parse(readFileSync(path, "utf8")) as FolderServer;
  } catch {
    return undefined;
  }
  const alive = (() => {
    try {
      process.kill(info.pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  if (alive && Number.isInteger(info.port)) {
    try {
      const res = await fetch(`http://localhost:${info.port}/api/setup-status`, {
        signal: AbortSignal.timeout(800),
      });
      if (res.ok) return info;
    } catch {
      // not answering: stale
    }
  }
  rmSync(path, { force: true });
  return undefined;
}

/**
 * Whether the folder server can reach a model provider — asked of the server,
 * which loads its own environment, rather than guessed from the launcher's.
 * Unknown (the endpoint failed) counts as yes: never warn on a guess.
 */
export async function serverHasModel(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/setup-status`);
    if (!res.ok) return true;
    const body = (await res.json()) as { hasLlmKey?: unknown };
    return body.hasLlmKey !== false;
  } catch {
    return true;
  }
}

/** Grace for the server's own shutdown; `src/main.ts` force-exits after 30 s. */
export const SERVER_STOP_GRACE_MS = 35_000;

/**
 * Stop the folder-scoped server and wait until the process has EXITED. The
 * server drains agents and background work, closes the database and releases
 * its lease on the way out; exiting the launcher before that would leave the
 * next `marina` on the same folder (e.g. a reviewer started right after an
 * implementer) racing a still-held lease. SIGTERM first, SIGKILL after the
 * grace period: SQLite in WAL mode is crash-safe and the kernel drops the
 * lease lock with the process.
 */
export async function stopServerProcess(
  proc: { kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> },
  graceMs = SERVER_STOP_GRACE_MS,
): Promise<"exited" | "killed"> {
  try {
    proc.kill("SIGTERM");
  } catch {
    // allow-empty-catch: already gone; `exited` resolves regardless
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    proc.exited.then(() => "exited" as const),
    new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), graceMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome === "exited") return "exited";
  try {
    proc.kill("SIGKILL");
  } catch {
    // allow-empty-catch: exited between the deadline and the kill
  }
  await proc.exited;
  return "killed";
}

/** Append non-empty lines to a rolling tail buffer, keeping the last `max`. */
export function pushTailLines(tail: string[], lines: string[], max = STDERR_TAIL_LINES): void {
  for (const line of lines) {
    if (!line.trim()) continue;
    tail.push(line);
    while (tail.length > max) tail.shift();
  }
}

/** Delete a `--fresh` database and every file the server keeps beside it
 *  (`-wal`, `-shm`, `.instance-lock`, `.key-secret`, `.runner/`, …). The name
 *  is unique per launch (port + timestamp), so its prefix is the whole set. */
export function removeEphemeralDatabase(dbPath: string): void {
  const base = basename(dbPath);
  try {
    for (const name of readdirSync(dirname(dbPath))) {
      if (name === base || name.startsWith(`${base}.`) || name.startsWith(`${base}-`))
        rmSync(join(dirname(dbPath), name), { recursive: true, force: true });
    }
  } catch {
    // allow-empty-catch: best-effort removal of a throwaway database
  }
}

/** Boot a folder-scoped Marina and run the Code Mode REPL (or a one-shot
 *  `print` task). Never returns. */
export async function runCodeSession(
  targetDir: string,
  opts: CodeSessionOptions = {},
): Promise<void> {
  const dir = resolve(targetDir);
  if (!statSync(dir).isDirectory()) throw new Error(`Not a project directory: ${dir}`);
  // This folder's Marina home: its database, harnesses and optional `.env`
  // (settings for this folder only, above ~/.marina/.env; scripts/cli-env.ts).
  const projectDirectory = join(userMarinaDir(), "projects", projectSlug(dir));
  applyCliEnvironment({ instanceDir: projectDirectory });
  const fresh = opts.fresh ?? /^(1|true|on)$/i.test(process.env.MARINA_CODE_FRESH ?? "");
  // Host-exec approval posture. Neither flag → "off" (allowlist-only, no
  // exec-mode sent). Either flag demands an owned TTY; a pipe is never consent.
  const execResolution = resolveExecMode(opts, process.stdin.isTTY === true);
  const execMode = execResolution.mode;
  const harnessStore = new HarnessStore(projectDirectory);
  const savedHarness = opts.harness
    ? harnessStore.load(opts.harness)
    : opts.agent
      ? undefined
      : harnessStore.load();
  const harness = validateHarness({
    version: 1,
    agent: "marina",
    ...savedHarness,
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.profile ? { profile: opts.profile } : {}),
  });
  if (harness.agent !== "marina" && !installedCodingAdapters().some((a) => a.id === harness.agent))
    throw new Error(`${harness.agent} is not installed in PATH. Install it or use --agent marina.`);
  const port = await freePort();
  let dbPath: string;
  if (fresh) {
    dbPath = join(tmpdir(), `marina-code-${port}-${Date.now()}.db`);
  } else {
    // Persistent per-folder home: sessions, artifacts, and memory survive
    // restarts, so re-entering `code` resumes where the last launch left off.
    mkdirSync(projectDirectory, { recursive: true });
    dbPath = join(projectDirectory, "marina.db");
  }
  const defaultModel =
    harness.agent === "marina" && harness.model
      ? harness.model
      : inferCodeDefaultModel(process.env);
  if (harness.agent === "marina" && defaultModel) harness.model = defaultModel;

  // Zero-config: with no LLM provider key, name the one missing thing in a single
  // line and point at `marina init` — never a wall of text, never a false "ready".
  const noProviderKey = harness.agent === "marina" && defaultModel === undefined;
  if (noProviderKey) {
    console.error(
      `No LLM provider key — set one (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, …) in ${join(userMarinaDir(), ".env")} or run \`marina init\`.`,
    );
  }

  // The first screen is short: where you are, what runs, and what to type.
  // Everything else is one command away (/status, /project, --verbose).
  const verbose = opts.verbose === true;
  const folderName = basename(dir) || dir;
  const agentLabel =
    harness.agent !== "marina"
      ? `${harness.agent} (${harness.model ?? "its default model"})`
      : (defaultModel ?? "default model");
  say(`Starting Marina in ${folderName}…`);
  if (verbose) say(fresh ? "DB · ephemeral (deleted on exit)" : `DB · ${dbPath}`);

  if (execResolution.refusal) {
    // A flag was set but refused (no owned TTY) — say so and stay allowlist-only.
    console.error(`Refused · ${execResolution.refusal}`);
  }
  if (execMode === "prompt") {
    say("Exec · non-allowlisted host commands will prompt for approval (y/N/a) before running.");
  } else if (execMode === "auto") {
    // A loud, one-time banner — this session auto-runs arbitrary host commands.
    console.error("");
    console.error("  ##############################################################");
    console.error("  #  DANGER: --dangerously-allow-all is ON                     #");
    console.error("  #  Every host command this session issues runs AUTOMATICALLY #");
    console.error("  #  with NO approval prompt. Only use in a folder you trust.   #");
    console.error("  ##############################################################");
    console.error("");
  }

  // A previous launch on this folder (an implementer before its reviewer, a
  // crashed launcher's orphan) may still be draining and hold the database
  // lease. Wait, bounded, for it to exit; never boot into a held lease.
  if (!fresh) {
    // A folder already open in another terminal: say so at once, instead of
    // waiting out the database lease and failing.
    const open = await runningFolderServer(projectDirectory);
    if (open) {
      console.error(
        `Marina is already open in this folder (pid ${open.pid}, started ${new Date(open.startedAt).toLocaleString()}). Close it, or open a separate disposable session with --fresh.`,
      );
      process.exit(1);
    }
    try {
      const { waitedMs } = await waitForDatabaseLease(dbPath);
      if (waitedMs >= 1_000) {
        say(
          `Waited ${Math.round(waitedMs / 1000)}s for a previous server to release the database.`,
        );
      }
    } catch {
      console.error(
        `Another Marina server still holds this folder's database (${dbPath}.instance-lock). Stop it and retry, or use --fresh for a disposable database.`,
      );
      process.exit(1);
    }
  }

  // The compiled server's working directory: the folder's home, or for --fresh
  // a sibling of the throwaway database (removed with it).
  const serverHome = fresh ? `${dbPath}.home` : projectDirectory;
  if (IS_COMPILED) mkdirSync(serverHome, { recursive: true });

  // Boot a minimal, folder-scoped server. MARINA_ADMINS=coder makes the local
  // user the operator (so it may launch the bound coding agent); the empty world
  // + no room agents keep it light; the DB is per-folder (or a throwaway with
  // --fresh). MARINA_NAME is pinned to the folder basename so instance-scoped
  // flags (tour dismissal, seen markers) stay stable across launches.
  const server = Bun.spawn(
    IS_COMPILED ? [process.execPath, "start"] : [process.execPath, "run", "src/main.ts"],
    {
      // Never the project folder: Bun would load its `.env`, and relative data
      // paths would land in it. The launcher already passes every setting.
      cwd: IS_COMPILED ? serverHome : REPO_ROOT,
      env: {
        ...process.env,
        WS_PORT: String(port),
        WS_HOST: "127.0.0.1",
        // Port 0 disables the listener (src/main.ts) — otherwise a second Marina
        // on the machine dies EADDRINUSE on telnet 4000 / MCP 3301 / log 3302.
        TELNET_PORT: "0",
        MCP_PORT: "0",
        LOG_PORT: "0",
        DB_PATH: dbPath,
        MARINA_NAME: process.env.MARINA_NAME ?? (basename(dir) || "marina"),
        MARINA_WORLD: process.env.MARINA_WORLD ?? "empty",
        MARINA_ROOM_AGENTS: process.env.MARINA_ROOM_AGENTS ?? "false",
        AGENT_AUTORESPAWN: process.env.AGENT_AUTORESPAWN ?? "false",
        MARINA_CODE_DEFAULT_ROOT: dir,
        MARINA_CODE_ROOTS: dir,
        MARINA_ADMINS: process.env.MARINA_ADMINS ?? "coder",
        MARINA_OPEN_API: process.env.MARINA_OPEN_API ?? "true",
        ...(defaultModel ? { MARINA_DEFAULT_MODEL: defaultModel } : {}),
        ...(opts.thinking ? { MARINA_CODE_THINKING: opts.thinking } : {}),
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  // Rolling stderr tail so a boot failure can say why.
  const stderrTail: string[] = [];
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    let carry = "";
    for await (const chunk of server.stderr) {
      carry += decoder.decode(chunk, { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      pushTailLines(stderrTail, lines);
    }
    if (carry) pushTailLines(stderrTail, [carry]);
  })().catch(() => {
    // stream closed with the child — the tail keeps whatever arrived
  });

  let sessionConsole: CodeConsole | undefined;
  let cleaning: Promise<never> | undefined;
  /** Stop the server, wait until it has released the database, then exit. */
  function cleanup(code = 0): Promise<never> {
    cleaning ??= (async () => {
      if ((await stopServerProcess(server)) === "killed")
        console.error("Server did not stop in time; killed it.");
      if (!fresh) rmSync(serverInfoPath(projectDirectory), { force: true });
      // Only ephemeral (--fresh) DBs are deleted — the per-folder persistent
      // DB is the whole point of resume.
      if (fresh) removeEphemeralDatabase(dbPath);
      process.exit(code);
    })();
    return cleaning;
  }

  // A person at the REPL may answer held actions; a `-p` one-shot or a pipe is
  // a program driving Marina and connects as an agent.
  const agent = new MarinaAgent(`ws://localhost:${port}`, {
    autoReconnect: false,
    principal: !opts.print && process.stdin.isTTY === true ? "person" : "agent",
  });
  // Single print path: every perception streams through here. command() also
  // returns the same perceptions in its resolved array — printing that too
  // would duplicate every line. The world's login bootstrap (room description,
  // onboarding text) is drained silently — this flow's first screen is Code
  // Mode; the full world belongs to `marina connect` / `marina start`.
  let echoPerceptions = false;
  agent.onPerception((p) => {
    if (!echoPerceptions) return;
    const terminal = terminalCodeLifecycle(p);
    if (terminal) sessionConsole?.completed(terminal.sessionId);
    if (sessionConsole) sessionConsole.receive(p);
    else {
      const text = formatCodePerception(p);
      if (text) process.stdout.write(`${terminalText(text)}\n`);
    }
  });

  let lastSigintAt = 0;
  if (execMode === "prompt") {
    agent.onPerception((p) => {
      const req = execApprovalRequest(p);
      if (!req) return;
      void (async () => {
        const answer = await sessionConsole?.ask(`Run: ${req.rendered} [y/N]: `);
        await agent.command(
          /^y(es)?$/i.test(answer?.trim() ?? "")
            ? `code exec-approve ${req.token}`
            : `code exec-deny ${req.token}`,
        );
      })().catch((error) => console.error(`Approval could not be delivered: ${String(error)}`));
    });
  }
  const handleSigint = () => {
    const now = Date.now();
    if (now - lastSigintAt < 200) return;
    lastSigintAt = now;
    if (sessionConsole) void sessionConsole.interrupt();
    else void cleanup(0);
  };
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", () => {
    if (sessionConsole) void sessionConsole.close(0);
    else void cleanup(0);
  });

  if (!(await waitForReady(port, server))) {
    // A server that exited during boot has said why on stderr: let the reader
    // drain it (bounded) before printing the tail.
    await Promise.race([stderrDone, new Promise((r) => setTimeout(r, 1_000))]);
    console.error("Server did not come up in time. Is the repo built and a provider key set?");
    if (stderrTail.length > 0) {
      console.error("Last server output:");
      for (const line of stderrTail) console.error(`  ${line}`);
    }
    if (!fresh) {
      console.error(
        "Try --fresh to diagnose startup with a disposable database; your saved project remains intact.",
      );
    }
    await cleanup(1);
  }
  if (!fresh) {
    // Announce this folder's server so a second launch here can say so at once.
    mkdirSync(projectDirectory, { recursive: true });
    writeFileSync(
      serverInfoPath(projectDirectory),
      JSON.stringify({ pid: server.pid, port, startedAt: Date.now() } satisfies FolderServer),
      { mode: 0o600 },
    );
  }

  try {
    const session = await agent.connect("coder");
    if (verbose) say(`Ready as ${session.name}.`);
  } catch (err) {
    console.error(`Failed to connect: ${(err as Error).message}`);
    await cleanup(1);
  }

  // An interactive terminal gets the welcome card (after Code Mode says
  // whether this is a new session); scripts and --tui keep the plain lines.
  const card =
    opts.print === undefined && !opts.tui && !!process.stdin.isTTY && !!process.stderr.isTTY;
  if (!card) say(`Marina ${MARINA_VERSION} · ${folderName} · ${agentLabel}`);
  // The provider check asks the SERVER: a key can be valid in the environment
  // and still unusable. The zero-config line above already named a missing key:
  // say it once.
  if (harness.agent === "marina" && !noProviderKey && !(await serverHasModel(port))) {
    console.error(
      `No model provider is configured for the agent. Set a key in ${join(userMarinaDir(), ".env")} or run marina init; or use /use claude, /use codex or /use pi.`,
    );
  }
  if (verbose) {
    // Instance coordinates — every Marina announces its own invitation.
    const host = hostname();
    say(`WS · ws://localhost:${port}`);
    say(`Dashboard · http://localhost:${port}`);
    say(`Federate · gateway add ${host} ws://${host}:${port}`);
  }

  // Let the login bootstrap drain silently, then enter Code Mode. Its banner
  // is for other clients; this terminal prints its own short summary, and
  // echoes everything after it.
  await new Promise((r) => setTimeout(r, 400));
  const entered = await agent.command("code");
  echoPerceptions = true;

  // Resume status: the code_mode_entered metadata says whether a prior session
  // (persistent DB) was picked back up. Ephemeral runs always start clean.
  let resumed: string | undefined;
  for (const p of entered) {
    const code = (p.data as Record<string, unknown> | undefined)?.code as
      | Record<string, unknown>
      | undefined;
    if (code?.event !== "code_mode_entered") continue;
    if (typeof code.sessionId === "string") {
      const createdAt = typeof code.sessionCreatedAt === "number" ? code.sessionCreatedAt : 0;
      const age = createdAt > 0 ? `${formatAge(Date.now() - createdAt)} ago` : "earlier";
      const workspace = typeof code.workspace === "string" ? code.workspace : dir;
      const title = typeof code.title === "string" && code.title ? `“${code.title}”, ` : "";
      resumed = `Resuming ${title}started ${age}${workspace !== dir ? ` in ${workspace}` : ""}.`;
      if (!card) say(resumed);
    } else if (!card) {
      say("New session.");
      if (!opts.print)
        say("Tip: /project shows readiness; /diff, /checks and /review follow a task.");
    }
    break;
  }
  if (card) printWelcome({ dir, agentLabel, resumed });

  // Negotiate the host-exec posture with the server. The server independently
  // re-verifies the operator is a loopback-local sovereign before honoring this
  // — the flag alone is not trusted. "off" sends nothing (allowlist-only).
  if (execMode !== "off") {
    await agent.command(`code exec-mode ${execMode}`).catch(() => {
      /* best-effort — if refused server-side, exec simply stays allowlist-only */
    });
  }

  sessionConsole = new CodeConsole({
    tui: opts.tui,
    welcomed: card,
    agent,
    url: `http://localhost:${port}`,
    root: dir,
    sessionId:
      entered.completion === "confirmed"
        ? entered
            .map((p) => p.data.code as { event?: string; sessionId?: string } | undefined)
            .find((code) => code?.event === "code_mode_entered")?.sessionId
        : undefined,
    directory: fresh ? `${dbPath}.runner` : join(projectDirectory, "terminal-runner"),
    harness,
    store: harnessStore,
    // `-p --json` keeps stdout for the one result object: everything else to stderr.
    ...(opts.json && opts.print !== undefined
      ? {
          plainOutput: process.stderr,
          terminalStreams: { output: process.stderr as unknown as NodeJS.WriteStream },
        }
      : {}),
    finish: (code) => {
      agent.disconnect();
      void cleanup(code);
    },
  });
  try {
    await sessionConsole.start(opts.print === undefined);
  } catch (error) {
    console.error(`Could not start coding console: ${String(error)}`);
    await sessionConsole.close(1);
    return;
  }
  const started = Date.now();
  /** The one-shot result: a notice on stderr, the JSON object last on stdout. */
  const finishPrint = async (
    outcome: ReturnType<typeof printOutcome>,
    end?: CodeLifecycleEnd,
    diff?: string,
  ) => {
    if (outcome.notice) console.error(outcome.notice);
    const assumed = formatAssumptions(end?.assumptions);
    if (assumed) (opts.json ? process.stderr : process.stdout).write(`${assumed}\n`);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          printResultJson(outcome, end, diff ? diffFileStats(diff) : [], Date.now() - started),
        )}\n`,
      );
    }
    await sessionConsole?.close(outcome.exitCode);
  };

  if (opts.print !== undefined && harness.agent !== "marina") {
    const timeout =
      Number.parseInt(process.env.MARINA_CODE_TASK_TIMEOUT_MS ?? "", 10) || DEFAULT_TASK_TIMEOUT_MS;
    try {
      await sessionConsole.task(opts.print, true, timeout);
    } catch (error) {
      console.error(String(error));
      await finishPrint(
        /timed out/i.test(String(error)) ? printOutcome("timeout") : printOutcome(undefined),
      );
      return;
    }
    // A native turn has no Marina verification: finished is not verified.
    await finishPrint(
      printOutcome(
        {
          phase: "completed",
          verification: "missing",
          verificationReason:
            "Native turn finished; Marina did not verify it. Review its output and workspace changes; task approval is separate.",
        },
        opts.allowUnverified,
      ),
    );
    return;
  }

  // One-shot mode (`marina -p "<task>"`): dispatch, stream, await the terminal
  // lifecycle signal, then exit — 0 verified, 3 completed but not verified,
  // 1 failed, 2 timeout (`printOutcome`).
  if (opts.print !== undefined) {
    const task = opts.print.trim();
    if (!task) {
      console.error("Empty task — nothing to do.");
      await finishPrint(printOutcome(undefined));
      return;
    }
    const timeoutMs =
      Number.parseInt(process.env.MARINA_CODE_TASK_TIMEOUT_MS ?? "", 10) || DEFAULT_TASK_TIMEOUT_MS;
    // Arm the waiter BEFORE dispatching so a fast completion can't slip past.
    const outcome = agent.waitForMessage(
      codingTaskCompletionMatcher(sessionConsole.currentSessionId),
      timeoutMs,
    );
    outcome.catch(() => {
      /* handled below — avoid unhandled-rejection noise */
    });
    try {
      if (opts.driver) await agent.command(`code driver ${opts.driver}`);
      await sessionConsole.task(
        task,
        false,
        timeoutMs,
        true,
        printVerification(opts.verification),
        oneShotBudgetMs(timeoutMs),
      );
    } catch (error) {
      console.error(String(error));
      await finishPrint(printOutcome(undefined));
      return;
    }
    let terminal: ReturnType<typeof terminalCodeLifecycle>;
    try {
      terminal = terminalCodeLifecycle(await outcome);
    } catch {
      // Timeout: interrupt the run so the agent doesn't keep working unattended.
      console.error(`Task timed out after ${timeoutMs}ms — sending code stop.`);
      await agent.command("code stop").catch(() => {
        /* best-effort */
      });
      await finishPrint(printOutcome("timeout"));
      return;
    }
    // The session diff is what the run produced, whether it completed or not: a failed or
    // blocked attempt keeps its edits, and the result lists them.
    const sessionDiff = async () =>
      (await agent.command("code diff").catch(() => [])) // output streams through the perception echo
        .map((p) => p.data?.code as { type?: unknown; content?: unknown } | undefined)
        .find((c) => c?.type === "diff" && typeof c.content === "string")?.content as
        | string
        | undefined;
    if (!terminal || terminal.phase === "failed") {
      const why = terminal?.detail ?? terminal?.reason;
      console.error(`Task failed${why ? `: ${why}` : "."}`);
      await finishPrint(printOutcome(terminal), terminal, await sessionDiff());
      return;
    }
    // Completed: show the session diff, then the durable summary text.
    const diff = await sessionDiff();
    if (terminal.summary)
      (opts.json ? process.stderr : process.stdout).write(`\n${terminal.summary}\n`);
    await finishPrint(printOutcome(terminal, opts.allowUnverified), terminal, diff);
  }
}

/** Per-file added/removed line counts of a unified diff (the shared, hunk-aware parser). */
export function diffFileStats(
  diff: string,
): Array<{ path: string; added: number; removed: number }> {
  return diffStat(diff).map(({ path, added, removed }) => ({ path, added, removed }));
}

if (import.meta.main) {
  await runCodeSession(process.argv[2] ?? process.cwd());
}
