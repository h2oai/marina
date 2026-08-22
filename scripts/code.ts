#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * marina code — "Claude/Codex in any folder".
 *
 * Boots an ephemeral, folder-scoped Marina (empty world, no room agents, a
 * throwaway DB) and drops you straight into agentic Code Mode for that
 * directory: type a task in plain English and a bound coding agent explores,
 * edits, and runs checks — streaming its work back. The minimum end of the
 * pervasive-Marina spectrum: an agent in a
 * folder, no world/ports/civics ceremony.
 *
 * Usage:
 *   bun run code [dir]        # dir defaults to the current directory
 *   marina [dir]              # same flow via the dispatcher bin
 *
 * Needs an LLM provider key in the environment (ANTHROPIC_API_KEY, etc.) or a
 * local llama server — same as any coding agent. Exit with Ctrl-D / Ctrl-C.
 */

import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { formatPerception } from "../src/net/formatter";
import { MarinaAgent } from "../src/sdk/client";
import { inferCodeDefaultModel, PROVIDER_KEY_ENV_VARS } from "./code-model";

const REPO_ROOT = resolve(import.meta.dir, "..");
const STDERR_TAIL_LINES = 40;

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

/** Boot a folder-scoped Marina and run the Code Mode REPL. Never returns. */
export async function runCodeSession(targetDir: string): Promise<void> {
  const dir = resolve(targetDir);
  const port = await freePort();
  const dbPath = join(tmpdir(), `marina-code-${port}-${Date.now()}.db`);
  const defaultModel = inferCodeDefaultModel(process.env);

  console.error(`Marina · ${dir}`);
  console.error("Booting a folder-scoped session…");
  if (defaultModel) {
    console.error(`Model · ${defaultModel}`);
  } else {
    // The world still boots without a provider key — agents just can't think.
    console.error("Warning · no LLM provider key found; the coding agent won't be able to think.");
    console.error(`  Checked: MARINA_DEFAULT_MODEL, ${PROVIDER_KEY_ENV_VARS.join(", ")}`);
    console.error("  Set one (e.g. ANTHROPIC_API_KEY) and restart to enable task execution.");
  }

  // Boot a minimal, folder-scoped server. MARINA_ADMINS=coder makes the local
  // user the operator (so it may launch the bound coding agent); the empty world
  // + no room agents keep it light; the DB is a throwaway.
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
      try {
        rmSync(dbPath, { force: true });
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
      } catch {
        /* best-effort */
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
  await agent.command("code");

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
