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
 * pervasive-Marina spectrum (docs/design/pervasive-marina.md): an agent in a
 * folder, no world/ports/civics ceremony.
 *
 * Usage:
 *   bun run code [dir]        # dir defaults to the current directory
 *
 * Needs an LLM provider key in the environment (ANTHROPIC_API_KEY, etc.) or a
 * local llama server — same as any coding agent. Exit with Ctrl-D / Ctrl-C.
 */

import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { formatPerception } from "../src/net/formatter";
import { MarinaAgent } from "../src/sdk/client";

const REPO_ROOT = resolve(import.meta.dir, "..");
const dir = resolve(process.argv[2] ?? process.cwd());

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

const port = await freePort();
const dbPath = join(tmpdir(), `marina-code-${port}-${Date.now()}.db`);

console.error(`Marina · ${dir}`);
console.error("Booting a folder-scoped session…");

// Boot a minimal, folder-scoped server. MARINA_ADMINS=coder makes the local
// user the operator (so it may launch the bound coding agent); the empty world
// + no room agents keep it light; the DB is a throwaway.
const server = Bun.spawn(["bun", "run", "src/main.ts"], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    WS_PORT: String(port),
    DB_PATH: dbPath,
    MARINA_WORLD: process.env.MARINA_WORLD ?? "empty",
    MARINA_ROOM_AGENTS: process.env.MARINA_ROOM_AGENTS ?? "false",
    AGENT_AUTORESPAWN: process.env.AGENT_AUTORESPAWN ?? "false",
    MARINA_CODE_DEFAULT_ROOT: dir,
    MARINA_CODE_ROOTS: dir,
    MARINA_ADMINS: process.env.MARINA_ADMINS ?? "coder",
    MARINA_OPEN_API: process.env.MARINA_OPEN_API ?? "true",
  },
  stdout: "ignore",
  stderr: "ignore",
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
process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

if (!(await waitForReady(port))) {
  console.error("Server did not come up in time. Is the repo built and a provider key set?");
  cleanup(1);
}

const agent = new MarinaAgent(`ws://localhost:${port}`, { autoReconnect: false });
agent.onPerception((p) => {
  const text = formatPerception(p, "plaintext");
  if (text) process.stdout.write(`${text}\n`);
});

try {
  const session = await agent.connect("coder");
  console.error(`Ready as ${session.name}.`);
} catch (err) {
  console.error(`Failed to connect: ${(err as Error).message}`);
  cleanup(1);
}

// Enter Code Mode — evaluates the directory and waits for a task.
for (const p of await agent.command("code")) {
  const text = formatPerception(p, "plaintext");
  if (text) process.stdout.write(`${text}\n`);
}

const rl = createInterface({ input: process.stdin, output: process.stderr, prompt: "» " });
rl.prompt();
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }
  if (trimmed === "exit" || trimmed === "quit") {
    rl.close();
    return;
  }
  for (const p of await agent.command(trimmed)) {
    const text = formatPerception(p, "plaintext");
    if (text) process.stdout.write(`${text}\n`);
  }
  rl.prompt();
});
rl.on("close", () => {
  agent.disconnect();
  cleanup(0);
});
