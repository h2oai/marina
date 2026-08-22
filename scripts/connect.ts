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
const dashC = args.indexOf("-c");
let name: string | undefined;
let oneShot: string | undefined;

if (dashC !== -1) {
  oneShot = args[dashC + 1];
  const rest = args.filter((_, i) => i !== dashC && i !== dashC + 1);
  name = rest[0];
} else {
  name = args[0];
}

if (!name) {
  console.error('Usage: marina connect <name> [-c "command"]');
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

// Print async perceptions (broadcasts, arrivals, messages)
agent.onPerception((p) => {
  const text = formatPerception(p, "plaintext");
  if (text) process.stdout.write(`${text}\n`);
});

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

// ── One-shot mode ────────────────────────────────────────────────────────────

if (oneShot) {
  const perceptions = await agent.command(oneShot);
  for (const p of perceptions) {
    const text = formatPerception(p, "plaintext");
    if (text) console.log(text);
  }
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
    const perceptions = await agent.command(trimmed);
    for (const p of perceptions) {
      const text = formatPerception(p, "plaintext");
      if (text) console.log(text);
    }
  }
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
  const perceptions = await agent.command(trimmed);
  for (const p of perceptions) {
    const text = formatPerception(p, "plaintext");
    if (text) console.log(text);
  }
  rl.prompt();
});

rl.on("close", () => {
  agent.disconnect();
  process.exit(0);
});
