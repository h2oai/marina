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
 *   MARINA_RELAY_SOCKET — a supervised resident's command relay (`connect-relay.ts`)
 */

import { createInterface } from "node:readline";
import { sanitizeEntityName } from "../src/engine/entity-name";
import { formatPerception } from "../src/net/formatter";
import type { CommandCatalogEntry } from "../src/sdk/capabilities";
import { MarinaAgent, type Perception } from "../src/sdk/client";
import { runCliCommand } from "./connect-command";
import { isTransportFailure } from "./connect-errors";
import { runRelayCli } from "./connect-relay";
import { runInteractive } from "./connect-repl";
import { cachedParticipantToken, saveParticipantToken } from "./session-cache";
import { colorChoiceFromArgs, termCaps } from "./term-caps";
import { renderPerception } from "./term-render";
import { sanitizeServerText } from "./term-sanitize";
import { createTheme } from "./term-theme";

const args = process.argv.slice(2);

/**
 * The server address: `--url`, then `--port`, then MARINA_URL, then WS_PORT.
 * The boot banner prints `ws://host:port/ws` (the browser endpoint); the CLI
 * speaks on the root path, so a pasted `/ws` is accepted and trimmed.
 */
function serverUrl(): string {
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = flag("--port") ?? (process.env.MARINA_URL ? undefined : process.env.WS_PORT);
  const raw =
    flag("--url") ??
    (port ? `ws://localhost:${port}` : process.env.MARINA_URL) ??
    "ws://localhost:3300";
  return raw.replace(/\/ws\/?$/, "");
}
const URL = serverUrl();

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
  --port <n>       server port on localhost (default: WS_PORT or 3300)
  --url <ws-url>   full server URL (a trailing /ws is accepted)
  --color <when>   auto (default), always or never; --no-color = never
  -h, --help       show this help

Interactive terminal:
  /help lists local panels (/status /agents /spend /alerts /readiness /world
  /me /prompt /theme); the prompt and status bar take starship-style formats
  (/prompt). Output to a pipe or file stays plain text.

Environment:
  MARINA_URL       WebSocket server URL (default: ws://localhost:3300)
  NO_COLOR / FORCE_COLOR
                   disable / force colour (no-color.org)
  MARINA_THEME     harbor (dark), harbor-light, ansi (your terminal's colours)
  MARINA_PROMPT / MARINA_STATUSLINE
                   prompt and status bar formats (see /prompt)
  MARINA_HISTORY   history file, or off
  MARINA_RELAY_SOCKET
                   set by a supervisor for its resident agents: commands run
                   over that relay as the resident, and <name> is optional`);
  process.exit(0);
}

const consumed = new Set<number>();
for (const flag of ["--port", "--url", "--color"]) {
  const i = args.indexOf(flag);
  if (i >= 0) {
    consumed.add(i);
    consumed.add(i + 1);
  }
}
for (const [i, arg] of args.entries())
  if (arg === "--no-color" || arg.startsWith("--color=")) consumed.add(i);
const colorChoice = colorChoiceFromArgs(args);
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
const requestedName: string | undefined = args.filter((_, i) => !consumed.has(i))[0];

// Inside a supervised resident's process: commands go over its relay, as it.
const relaySocket = process.env.MARINA_RELAY_SOCKET;
if (relaySocket) process.exit(await runRelayCli(relaySocket, oneShot));

if (!requestedName) {
  console.error('Usage: marina connect <name> [-c "command"] [--wait <sec>]');
  process.exit(1);
}

// The engine normalizes login names (alphanumerics + underscore, 20 chars max)
// with the same helper, so the name the server will actually use is knowable
// here — no round trip needed. "Ada Lovelace" logs in as "AdaLovelace".
const name = sanitizeEntityName(requestedName);
if (!name) {
  console.error(`"${requestedName}" contains no usable characters (letters, digits, underscore).`);
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

function loadCachedToken(n: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(n)) return undefined;
  return cachedParticipantToken(n, URL);
}

function saveSessionToken(n: string, token: string): void {
  try {
    saveParticipantToken(n, URL, token);
  } catch {
    // Non-fatal — the next invocation will just do a fresh login.
  }
}

// An interactive terminal is a person typing; one-shot and pipe modes are how
// another program (often an agent) drives Marina, so they connect as an agent
// and cannot answer other participants' held actions (challenges).
const interactive = !oneShot && !!process.stdin.isTTY;
const agent = new MarinaAgent(URL, {
  autoReconnect: false,
  principal: interactive ? "person" : "agent",
});

// Scripted modes (one-shot / pipe) suppress the login burst (welcome text,
// auto-look, brief) so stdout is just the command's output, and they linger
// after the last command so asynchronous responses (e.g. `ask` answers that
// arrive seconds after the ack) aren't silently dropped.
const scripted = !!oneShot || !process.stdin.isTTY;

// The full screen (input area, status bar, panels) needs a terminal on both
// ends. A terminal on stdout alone still gets styled output; a pipe or file
// gets plain text with every control byte removed.
const caps = termCaps(process.stdout, process.env, colorChoice);
const rich = interactive && !!process.stdout.isTTY;
const styled = !!process.stdout.isTTY;
const theme = createTheme(caps);
const plainTheme = createTheme({ ...caps, color: 0 });

// Single printer for ALL output. Perceptions arrive here exactly once;
// `agent.command()`'s returned perceptions are the same objects, so printing
// those too would duplicate every line (the pre-fix behavior). The rich
// screen installs its own printer; the login burst waits for it here.
let printEnabled = !scripted;
let lastOutputAt = Date.now();
const early: Perception[] = [];
const printer = (p: Perception) => {
  if (p.data?.capabilities) return;
  if (rich) {
    early.push(p);
    return;
  }
  if (!printEnabled) return;
  const text = styled
    ? renderPerception(
        p,
        { theme, width: process.stdout.columns || 80 },
        { own: !!p.command_request_id },
      ).join("\n")
    : sanitizeServerText(formatPerception(p, "plaintext"), plainTheme);
  if (text) {
    process.stdout.write(`${text}\n`);
    lastOutputAt = Date.now();
  }
};
agent.onPerception(printer);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until output has been quiet for `quietMs`, capped at `maxMs` total.
 * The quiet rule only starts counting once the command has produced SOME
 * output: a slow command (a live provider probe, a model-backed `ask`) may
 * print nothing for several seconds, and exiting on that initial silence
 * dropped its entire reply.
 */
async function lingerForQuiet(quietMs: number, maxMs: number): Promise<void> {
  const start = Date.now();
  const outputBefore = lastOutputAt;
  while (Date.now() - start < maxMs) {
    const produced = lastOutputAt !== outputBefore;
    if (produced && Date.now() - lastOutputAt >= quietMs) return;
    await sleep(100);
  }
}

// Cache under the ACTUAL (normalized) name; fall back to a legacy entry saved
// under the raw requested spelling so existing sessions keep their identity.
const cachedToken = loadCachedToken(name) ?? loadCachedToken(requestedName);

let connectedName = name;
let connectedId = "";
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
  connectedName = session.name || name;
  connectedId = session.entityId;
  if (name !== requestedName) {
    console.error(`Logged in as "${name}" (requested "${requestedName}")`);
  }
  if (!rich) console.error(`Connected as ${session.name || name} (${session.entityId})`);
} catch (err) {
  const message = (err as Error).message;
  if (isTransportFailure(err)) {
    console.error(
      `Failed to connect to ${URL}. Is Marina running? Start it with \`bun run start\`.` +
        (message ? ` (${message})` : ""),
    );
  } else {
    console.error(`Failed to connect: ${message}`);
  }
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
  // A refused command (typo, usage error) already printed its reply; exit 1.
  const ok = await runCliCommand(agent, oneShot);
  // The direct response prints via onPerception; linger for async follow-ups.
  if (ok && maxLingerMs > 0) await lingerForQuiet(2_500, maxLingerMs);
  agent.disconnect();
  process.exit(ok ? 0 : 1);
}

// ── Pipe mode (stdin is not a TTY) ───────────────────────────────────────────

const isTTY = process.stdin.isTTY;

if (!isTTY) {
  const rl = createInterface({ input: process.stdin });
  let failed = false;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A refused line is reported and the script continues with the next one.
    if (!(await runCliCommand(agent, trimmed))) failed = true;
  }
  if (maxLingerMs > 0) await lingerForQuiet(2_500, maxLingerMs);
  agent.disconnect();
  process.exit(failed ? 1 : 0);
}

// ── REPL mode (interactive TTY) ──────────────────────────────────────────────

let capabilities: CommandCatalogEntry[] = [];
try {
  capabilities = (await agent.capabilities()).commands;
} catch {
  /* Older servers retain plain command input. */
}

if (rich) {
  await runInteractive({
    agent,
    session: { name: connectedName, entityId: connectedId },
    url: URL,
    caps,
    capabilities,
    reconnect: async () => {
      const token = agent.getSession()?.token ?? loadCachedToken(connectedName);
      if (!token) throw new Error("no session token");
      const restored = await agent.reconnect(token);
      if (restored.token) saveSessionToken(connectedName, restored.token);
    },
    handoff: () => {
      agent.offPerception(printer);
      return early.splice(0);
    },
  });
} else {
  // stdin is a terminal but stdout is redirected: a bare prompt on stderr.
  const rl = createInterface({ input: process.stdin, output: process.stderr, prompt: "> " });
  rl.prompt();
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (trimmed) await runCliCommand(agent, trimmed);
    rl.prompt();
  });
  rl.on("close", () => {
    agent.disconnect();
    process.exit(0);
  });
}
