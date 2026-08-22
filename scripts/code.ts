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
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { formatAge } from "../src/engine/commands/format-duration";
import { formatPerception } from "../src/net/formatter";
import { MarinaAgent, type Perception } from "../src/sdk/client";
import { inferCodeDefaultModel, PROVIDER_KEY_ENV_VARS } from "./code-model";

const REPO_ROOT = resolve(import.meta.dir, "..");
const STDERR_TAIL_LINES = 40;
const DEFAULT_TASK_TIMEOUT_MS = 600_000;

export interface CodeSessionOptions {
  /** Ephemeral tmp DB, deleted on exit (the pre-persistence behavior). */
  fresh?: boolean;
  /** One-shot task: dispatch it, stream output, await completion, exit 0/1/2. */
  print?: string;
  /** Prompt (y/N/a) for each non-allowlisted host command (`--allow-exec`). */
  allowExec?: boolean;
  /** Auto-approve every host command with no prompt (`--dangerously-allow-all`). */
  dangerouslyAllowAll?: boolean;
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

async function waitForReady(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
  const fresh = opts.fresh ?? /^(1|true|on)$/i.test(process.env.MARINA_CODE_FRESH ?? "");
  // Host-exec approval posture. Neither flag → "off" (allowlist-only, no
  // exec-mode sent). Either flag demands an owned TTY; a pipe is never consent.
  const execResolution = resolveExecMode(opts, process.stdin.isTTY === true);
  const execMode = execResolution.mode;
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
  const defaultModel = inferCodeDefaultModel(process.env);

  console.error(`Marina · ${dir}`);
  console.error("Booting a folder-scoped session…");
  console.error(fresh ? "DB · ephemeral (deleted on exit)" : `DB · ${dbPath}`);
  if (defaultModel) {
    console.error(`Model · ${defaultModel}`);
  } else {
    // The world still boots without a provider key — agents just can't think.
    console.error("Warning · no LLM provider key found; the coding agent won't be able to think.");
    console.error(`  Checked: MARINA_DEFAULT_MODEL, ${PROVIDER_KEY_ENV_VARS.join(", ")}`);
    console.error("  Set one (e.g. ANTHROPIC_API_KEY) and restart to enable task execution.");
  }

  if (execResolution.refusal) {
    // A flag was set but refused (no owned TTY) — say so and stay allowlist-only.
    console.error(`Refused · ${execResolution.refusal}`);
  }
  if (execMode === "prompt") {
    console.error(
      "Exec · non-allowlisted host commands will prompt for approval (y/N/a) before running.",
    );
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
  (async () => {
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

  let cleanedUp = false;
  function cleanup(code = 0): never {
    if (!cleanedUp) {
      cleanedUp = true;
      try {
        server.kill();
      } catch {
        /* already gone */
      }
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
    }
    process.exit(code);
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
    const text = formatPerception(p, "plaintext");
    if (text) process.stdout.write(`${text}\n`);
  });

  let rl: Interface | undefined;
  let taskInFlight = false;
  let stopRequested = false;
  let lastSigintAt = 0;

  // Interactive host-exec approval. Only wired in "prompt" mode; in "auto" the
  // server approves without a prompt and we just stream, in "off" no request is
  // ever sent. The prompt reuses the REPL readline (via a scoped question) so it
  // never deadlocks the main line loop, and Ctrl-C still interrupts.
  function promptApproval(rendered: string): Promise<boolean> {
    return new Promise((resolveAnswer) => {
      const query = `Run: ${rendered}  [y/N/a] `;
      const decide = (answer: string): void => {
        const a = answer.trim().toLowerCase();
        // 'a' ("allow this argv for the session") is just a yes here — the
        // server enforces the session-scope allow-set, so the launcher only
        // needs to relay approve/deny.
        resolveAnswer(a === "y" || a === "a");
      };
      if (rl) {
        rl.question(query, decide);
      } else {
        // No REPL yet (e.g. before the prompt loop is reached) — scoped reader.
        const tmp = createInterface({ input: process.stdin, output: process.stderr });
        tmp.question(query, (answer) => {
          tmp.close();
          decide(answer);
        });
      }
    });
  }
  if (execMode === "prompt") {
    agent.onPerception((p) => {
      const req = execApprovalRequest(p);
      if (!req) return;
      promptApproval(req.rendered)
        .then((ok) =>
          agent.command(ok ? `code exec-approve ${req.token}` : `code exec-deny ${req.token}`),
        )
        .catch(() => {
          /* best-effort — a missed reply times out server-side into a deny */
        });
    });
  }

  function handleSigint(): void {
    // One Ctrl-C can arrive via both the process SIGINT signal and readline's
    // "SIGINT" event — debounce so a single keypress counts once.
    const now = Date.now();
    if (now - lastSigintAt < 200) return;
    lastSigintAt = now;
    if (taskInFlight && !stopRequested) {
      stopRequested = true;
      agent.command("code stop").catch(() => {
        /* best-effort — the second Ctrl-C still exits */
      });
      console.error("\nStopped. Ctrl-C again to exit.");
      rl?.prompt();
      return;
    }
    cleanup(0);
  }
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", () => cleanup(0));

  if (!(await waitForReady(port))) {
    console.error("Server did not come up in time. Is the repo built and a provider key set?");
    if (stderrTail.length > 0) {
      console.error("Last server output:");
      for (const line of stderrTail) console.error(`  ${line}`);
    }
    if (!fresh) {
      console.error(`Hint: a stale project database from an older Marina version can block boot —`);
      console.error(`  remove ${dbPath} (and its -wal/-shm siblings), or relaunch with --fresh.`);
    }
    cleanup(1);
  }

  try {
    const session = await agent.connect("coder");
    console.error(`Ready as ${session.name}.`);
  } catch (err) {
    console.error(`Failed to connect: ${(err as Error).message}`);
    cleanup(1);
  }

  // Instance coordinates — every Marina announces its own invitation.
  const host = hostname();
  console.error(`WS · ws://localhost:${port}`);
  console.error(`Dashboard · http://localhost:${port}`);
  console.error(`Federate · gateway add ${host} ws://${host}:${port}`);

  // Let the login bootstrap drain silently, then start echoing and enter Code
  // Mode — its banner and everything after arrive via the onPerception stream.
  await new Promise((r) => setTimeout(r, 400));
  echoPerceptions = true;
  const entered = await agent.command("code");

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
      console.error(`Resuming session ${code.sessionId} — started ${age}, workspace ${workspace}`);
    } else {
      console.error("No active session yet.");
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

  // One-shot mode (`marina -p "<task>"`): dispatch, stream, await the terminal
  // lifecycle signal, then exit — 0 completed, 1 failed, 2 timeout.
  if (opts.print !== undefined) {
    const task = opts.print.trim();
    if (!task) {
      console.error("Empty task — nothing to do.");
      cleanup(1);
    }
    const timeoutMs =
      Number.parseInt(process.env.MARINA_CODE_TASK_TIMEOUT_MS ?? "", 10) || DEFAULT_TASK_TIMEOUT_MS;
    // Arm the waiter BEFORE dispatching so a fast completion can't slip past.
    const outcome = agent.waitForMessage((p) => terminalCodeLifecycle(p) !== undefined, timeoutMs);
    outcome.catch(() => {
      /* handled below — avoid unhandled-rejection noise */
    });
    taskInFlight = true;
    await agent.command(`code do ${task}`);
    let terminal: ReturnType<typeof terminalCodeLifecycle>;
    try {
      terminal = terminalCodeLifecycle(await outcome);
    } catch {
      // Timeout: interrupt the run so the agent doesn't keep working unattended.
      console.error(`Task timed out after ${timeoutMs}ms — sending code stop.`);
      await agent.command("code stop").catch(() => {
        /* best-effort */
      });
      cleanup(2);
    }
    taskInFlight = false;
    if (!terminal || terminal.phase === "failed") {
      console.error("Task failed.");
      cleanup(1);
    }
    // Completed: show the session diff, then the durable summary text.
    await agent.command("code diff"); // output streams through the perception echo
    if (terminal.summary) process.stdout.write(`\n${terminal.summary}\n`);
    cleanup(0);
  }

  rl = createInterface({ input: process.stdin, output: process.stderr, prompt: "» " });
  rl.on("SIGINT", handleSigint);
  rl.prompt();
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl?.prompt();
      return;
    }
    if (trimmed === "exit" || trimmed === "quit") {
      rl?.close();
      return;
    }
    taskInFlight = true;
    stopRequested = false;
    try {
      await agent.command(trimmed);
    } catch (err) {
      console.error(`Command failed: ${(err as Error).message}`);
    } finally {
      taskInFlight = false;
    }
    rl?.prompt();
  });
  rl.on("close", () => {
    agent.disconnect();
    cleanup(0);
  });
}

if (import.meta.main) {
  await runCodeSession(process.argv[2] ?? process.cwd());
}
