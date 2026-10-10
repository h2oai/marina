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
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { formatAge } from "../src/engine/commands/format-duration";
import { waitForDatabaseLease } from "../src/persistence/database-lease";
import { MarinaAgent, type Perception } from "../src/sdk/client";
import { CodeConsole } from "./code-console";
import { HarnessStore, validateHarness } from "./code-harness";
import { inferCodeDefaultModel } from "./code-model";
import { installedCodingAdapters } from "./code-native";
import { formatCodePerception, terminalText } from "./code-terminal";

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
export function terminalCodeLifecycle(
  p: Perception,
): { phase: "completed" | "failed"; sessionId?: string; summary?: string } | undefined {
  if (p.kind !== "message") return undefined;
  const code = (p.data as Record<string, unknown> | undefined)?.code as
    | Record<string, unknown>
    | undefined;
  if (code?.event !== "code_lifecycle") return undefined;
  const metadata = (code.metadata ?? {}) as Record<string, unknown>;
  const sessionId = typeof code.sessionId === "string" ? code.sessionId : undefined;
  if (code.phase === "completed") {
    return {
      phase: "completed",
      sessionId,
      summary: typeof metadata.summary === "string" ? metadata.summary : undefined,
    };
  }
  if (code.phase === "failed" && metadata.terminal === true) {
    return { phase: "failed", sessionId };
  }
  return undefined;
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

async function waitForReady(
  port: number,
  exited: Promise<number>,
  timeoutMs = 30_000,
): Promise<boolean> {
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
      if (res.ok) return true;
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
  process.stderr.write(`${line}\n`);
}

/** Marina's own version (package.json), or "" when it cannot be read. */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
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

/** Boot a folder-scoped Marina and run the Code Mode REPL (or a one-shot
 *  `print` task). Never returns. */
export async function runCodeSession(
  targetDir: string,
  opts: CodeSessionOptions = {},
): Promise<void> {
  const dir = resolve(targetDir);
  if (!statSync(dir).isDirectory()) throw new Error(`Not a project directory: ${dir}`);
  const fresh = opts.fresh ?? /^(1|true|on)$/i.test(process.env.MARINA_CODE_FRESH ?? "");
  // Host-exec approval posture. Neither flag → "off" (allowlist-only, no
  // exec-mode sent). Either flag demands an owned TTY; a pipe is never consent.
  const execResolution = resolveExecMode(opts, process.stdin.isTTY === true);
  const execMode = execResolution.mode;
  const projectDirectory = join(homedir(), ".marina", "projects", projectSlug(dir));
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
    const dbDir = join(homedir(), ".marina", "projects", projectSlug(dir));
    mkdirSync(dbDir, { recursive: true });
    dbPath = join(dbDir, "marina.db");
  }
  const defaultModel =
    harness.agent === "marina" && harness.model
      ? harness.model
      : inferCodeDefaultModel(process.env);
  if (harness.agent === "marina" && defaultModel) harness.model = defaultModel;

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

  // Boot a minimal, folder-scoped server. MARINA_ADMINS=coder makes the local
  // user the operator (so it may launch the bound coding agent); the empty world
  // + no room agents keep it light; the DB is per-folder (or a throwaway with
  // --fresh). MARINA_NAME is pinned to the folder basename so instance-scoped
  // flags (tour dismissal, seen markers) stay stable across launches.
  const server = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: REPO_ROOT,
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
    },
    stdout: "ignore",
    stderr: "pipe",
  });

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
      // Only ephemeral (--fresh) DBs are deleted — the per-folder persistent
      // DB is the whole point of resume.
      if (fresh) {
        try {
          rmSync(dbPath, { force: true });
          rmSync(`${dbPath}-wal`, { force: true });
          rmSync(`${dbPath}-shm`, { force: true });
        } catch {
          /* best-effort */
        }
      }
      process.exit(code);
    })();
    return cleaning;
  }

  const agent = new MarinaAgent(`ws://localhost:${port}`, { autoReconnect: false });
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

  if (!(await waitForReady(port, server.exited))) {
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

  try {
    const session = await agent.connect("coder");
    if (verbose) say(`Ready as ${session.name}.`);
  } catch (err) {
    console.error(`Failed to connect: ${(err as Error).message}`);
    await cleanup(1);
  }

  say(`Marina ${packageVersion()} · ${folderName} · ${agentLabel}`);
  // The provider check asks the SERVER, which loads its own environment (the
  // repo .env): the launcher's environment says nothing about what it can use.
  if (harness.agent === "marina" && !(await serverHasModel(port))) {
    console.error(
      `No model provider is configured for the agent. Set a key in ${join(REPO_ROOT, ".env")} or run marina init; or use /use claude, /use codex or /use pi.`,
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
      say(`Resuming ${title}started ${age}${workspace !== dir ? ` in ${workspace}` : ""}.`);
    } else {
      say("New session.");
      if (!opts.print)
        say("Tip: /project shows readiness; /diff, /checks and /review follow a task.");
    }
    break;
  }

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
  if (opts.print !== undefined && harness.agent !== "marina") {
    const timeout =
      Number.parseInt(process.env.MARINA_CODE_TASK_TIMEOUT_MS ?? "", 10) || DEFAULT_TASK_TIMEOUT_MS;
    let code = 0;
    try {
      await sessionConsole.task(opts.print, true, timeout);
      console.error(
        "Native turn finished. Review its output and workspace changes; task approval is separate.",
      );
    } catch (error) {
      console.error(String(error));
      code = /timed out/i.test(String(error)) ? 2 : 1;
    }
    await sessionConsole.close(code);
    return;
  }

  // One-shot mode (`marina -p "<task>"`): dispatch, stream, await the terminal
  // lifecycle signal, then exit — 0 completed, 1 failed, 2 timeout.
  if (opts.print !== undefined) {
    const task = opts.print.trim();
    if (!task) {
      console.error("Empty task — nothing to do.");
      await sessionConsole.close(1);
      return;
    }
    const timeoutMs =
      Number.parseInt(process.env.MARINA_CODE_TASK_TIMEOUT_MS ?? "", 10) || DEFAULT_TASK_TIMEOUT_MS;
    // Arm the waiter BEFORE dispatching so a fast completion can't slip past.
    const outcome = agent.waitForMessage((p) => terminalCodeLifecycle(p) !== undefined, timeoutMs);
    outcome.catch(() => {
      /* handled below — avoid unhandled-rejection noise */
    });
    try {
      await sessionConsole.task(task);
    } catch (error) {
      console.error(String(error));
      await sessionConsole.close(1);
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
      await sessionConsole.close(2);
      return;
    }
    if (!terminal || terminal.phase === "failed") {
      console.error("Task failed.");
      await sessionConsole.close(1);
      return;
    }
    // Completed: show the session diff, then the durable summary text.
    await agent.command("code diff"); // output streams through the perception echo
    if (terminal.summary) process.stdout.write(`\n${terminal.summary}\n`);
    await sessionConsole.close(0);
  }
}

if (import.meta.main) {
  await runCodeSession(process.argv[2] ?? process.cwd());
}
