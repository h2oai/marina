#!/usr/bin/env bun
// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Marina ACP — stdio JSON-RPC bridge for editor clients (Zed, JetBrains,
 * VS Code, Neovim). Speaks Agent Client Protocol 1, proxies each prompt
 * through the running Marina's command engine.
 *
 * Usage:
 *   bun run scripts/acp.ts <name>
 *
 * Environment:
 *   MARINA_URL  — WebSocket server URL (default: ws://localhost:3300)
 *
 * Wire contract: stdout is reserved for ACP ndjson. All logs go to stderr.
 */

import { AcpServer } from "../src/net/acp-server";
import { MarinaAgent } from "../src/sdk/client";

const URL = process.env.MARINA_URL ?? "ws://localhost:3300";

const args = process.argv.slice(2);
const name = args[0];

if (!name) {
  process.stderr.write("Usage: bun run scripts/acp.ts <name>\n");
  process.exit(1);
}

const agent = new MarinaAgent(URL, { autoReconnect: true });

try {
  const session = await agent.connect(name);
  process.stderr.write(`[acp] connected as ${session.name} (${session.entityId})\n`);
} catch (err) {
  process.stderr.write(`[acp] failed to connect: ${(err as Error).message}\n`);
  process.exit(1);
}

const server = new AcpServer({ agent });
server.start();

process.stderr.write(`[acp] ready — protocol 1, agent=marina\n`);

const shutdown = () => {
  server.stop();
  agent.disconnect();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
