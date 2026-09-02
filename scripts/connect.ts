#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marina Connect — single-command agent bridge
 *
 * Usage:
 *   marina connect <name> [...]                                  # via the dispatcher bin
 *   bun run scripts/connect.ts <name>                            # interactive REPL
 *   bun run scripts/connect.ts <name> -c "look"                  # one-shot
 *   echo "look\nsay hello" | bun run scripts/connect.ts <name>   # pipe mode
 *
 * One-shot and pipe modes suppress the login burst and linger (default up to
 * 20s, tune with --wait <sec>) so asynchronous responses — `ask` answers,
 * `desire` journeys — reach stdout before exit. `--wait 0` exits on ack.
 *
 * Environment:
 *   MARINA_URL — WebSocket server URL (default: ws://localhost:3300)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { formatPerception } from "../src/net/formatter";
import { MarinaAgent } from "../src/sdk/client";

const URL = process.env.MARINA_URL ?? "ws://localhost:3300";

const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  console.log(`Marina Connect — bridge a terminal (or script) into a Marina instance.

Usage:
  marina connect <name>                 interactive REPL (via the dispatcher bin)
  bun run scripts/connect.ts <name>                 interactive REPL
  bun run scripts/connect.ts <name> -c "command"    one-shot: run, print output, exit
  echo "look" | bun run scripts/connect.ts <name>   pipe mode: one command per line

Flags:
  -c "<command>"   run a single command and exit
  --wait <sec>     max seconds to linger for asynchronous output (model-backed
                   commands like \`ask\` answer after the ack) in one-shot/pipe
                   mode. Default 20; 0 exits as soon as the command is acked.
  -h, --help       show this help

Environment:
  MARINA_URL       WebSocket server URL (default: ws://localhost:3300)`);
  process.exit(0);
}

const consumed = new Set<number>();
const dashC = args.indexOf("-c");
let oneShot: string | undefined;
if (dashC !== -1) {
  oneShot = args[dashC + 1];
  consumed.add(dashC);
  consumed.add(dashC + 1);
}
let maxLingerMs = 20_000;
const waitIdx = args.indexOf("--wait");
if (waitIdx !== -1) {
  const parsed = Number(args[waitIdx + 1]);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error("--wait expects a non-negative number of seconds.");
    process.exit(1);
  }
  maxLingerMs = parsed * 1000;
  consumed.add(waitIdx);
  consumed.add(waitIdx + 1);
}
const name: string | undefined = args.filter((_, i) => !consumed.has(i))[0];

if (!name) {
  console.error('Usage: marina connect <name> [-c "command"] [--wait <sec>]');
  process.exit(1);
}

// ── Session token cache ──────────────────────────────────────────────────────
//
// Without this, every CLI invocation does a fresh `login`, which the server
// treats as a new entity (different EntityId). That breaks ownership chains —
// e.g. a crew you created with `connect.ts Creator -c "crew create …"` could
// not be `crew complete`d by another `connect.ts Creator -c …` call because
// the second invocation was a different entity. Caching the token per name
// and reconnecting first preserves identity across one-shot commands.

const SESSION_DIR = join(homedir(), ".marina", "sessions");

function sessionFile(n: string): string {
  return join(SESSION_DIR, `${n}.json`);
}

function loadCachedToken(n: string): string | undefined {
  try {
    const raw = readFileSync(sessionFile(n), "utf8");
    const parsed = JSON.parse(raw) as { token?: string; url?: string };
    // Only honor cached tokens for the same server URL — a token from a
    // different host doesn't transfer.
    if (parsed.url && parsed.url !== URL) return undefined;
    return parsed.token;
  } catch {
    return undefined;
  }
}

function saveSessionToken(n: string, token: string): void {
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(sessionFile(n), JSON.stringify({ token, url: URL }), { mode: 0o600 });
  } catch {
    // Non-fatal — the next invocation will just do a fresh login.
  }
}

const agent = new MarinaAgent(URL, { autoReconnect: false });

// Scripted modes (one-shot / pipe) suppress the login burst (welcome text,
// auto-look, brief) so stdout is just the command's output, and they linger
// after the last command so asynchronous responses (e.g. `ask` answers that
// arrive seconds after the ack) aren't silently dropped.
const scripted = !!oneShot || !process.stdin.isTTY;

// Single printer for ALL output. Perceptions arrive here exactly once;
// `agent.command()`'s returned perceptions are the same objects, so printing
// those too would duplicate every line (the pre-fix behavior).
let printEnabled = !scripted;
let lastOutputAt = Date.now();
agent.onPerception((p) => {
  if (!printEnabled) return;
  const text = formatPerception(p, "plaintext");
  if (text) {
    process.stdout.write(`${text}\n`);
    lastOutputAt = Date.now();
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until output has been quiet for `quietMs`, capped at `maxMs` total. */
async function lingerForQuiet(quietMs: number, maxMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (Date.now() - lastOutputAt >= quietMs) return;
    await sleep(100);
  }
}

const cachedToken = loadCachedToken(name);

try {
  let session: Awaited<ReturnType<typeof agent.connect>>;
  if (cachedToken) {
    try {
      session = await agent.reconnect(cachedToken);
    } catch {
      // Token expired, server restarted, or name mismatch — fall back to
      // a fresh login so the user doesn't have to clear the cache by hand.
      session = await agent.connect(name);
    }
  } else {
    session = await agent.connect(name);
  }
  if (session.token) saveSessionToken(name, session.token);
  console.error(`Connected as ${session.name} (${session.entityId})`);
} catch (err) {
  console.error(`Failed to connect: ${(err as Error).message}`);
  process.exit(1);
}

// Let the login burst (welcome, auto-look, brief) drain unprinted, then start
// emitting output for the actual commands.
if (scripted) {
  await sleep(400);
  printEnabled = true;
  lastOutputAt = Date.now();
}

// ── One-shot mode ────────────────────────────────────────────────────────────

if (oneShot) {
  await agent.command(oneShot);
  // The direct response prints via onPerception; linger for async follow-ups.
  if (maxLingerMs > 0) await lingerForQuiet(2_500, maxLingerMs);
  agent.disconnect();
  process.exit(0);
}

// ── Pipe mode (stdin is not a TTY) ───────────────────────────────────────────

const isTTY = process.stdin.isTTY;

if (!isTTY) {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    await agent.command(trimmed);
  }
  if (maxLingerMs > 0) await lingerForQuiet(2_500, maxLingerMs);
  agent.disconnect();
  process.exit(0);
}

// ── REPL mode (interactive TTY) ──────────────────────────────────────────────

const rl = createInterface({
  input: process.stdin,
  output: process.stderr,
  prompt: "> ",
});

rl.prompt();

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }
  // Output prints via the single onPerception printer (printing the returned
  // perceptions here as well would duplicate every line).
  await agent.command(trimmed);
  rl.prompt();
});

rl.on("close", () => {
  agent.disconnect();
  process.exit(0);
});
