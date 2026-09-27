#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../package.json";
import { getErrorMessage } from "../src/engine/errors";

try {
  const target = process.argv[2];
  if (!target) throw new Error("Usage: bun scripts/create-agent.ts NEW_DIRECTORY");
  const directory = resolve(target);
  if (existsSync(directory))
    throw new Error("Choose a new directory; existing files are never overwritten");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    `${directory}/package.json`,
    JSON.stringify(
      {
        name: "marina-agent-example",
        private: true,
        type: "module",
        scripts: { start: "node agent.mjs" },
        dependencies: { "@marina/agent-sdk": `^${pkg.version}` },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    `${directory}/agent.mjs`,
    `import { MarinaAgent } from "@marina/agent-sdk";
const agent = new MarinaAgent(process.env.MARINA_URL ?? "ws://localhost:3300/ws");
agent.on("perception", p => console.log(p.kind, p.data));
if (process.env.MARINA_SESSION_TOKEN) await agent.reconnect(process.env.MARINA_SESSION_TOKEN);
else await agent.connect(process.env.AGENT_NAME ?? "Explorer");
await agent.command("look");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { agent.disconnect(); process.exit(0); });
`,
  );
  writeFileSync(
    `${directory}/README.md`,
    "Connects to an existing Marina instance using its supported login flow. Run npm install, then npm start (Node with native WebSocket) or bun agent.mjs. Set MARINA_URL and AGENT_NAME. For a private server, set MARINA_SESSION_TOKEN to an authenticated session token; a name is not proof of identity. During SDK development, install the locally qualified package tarball instead of a registry version.\n",
  );
  console.log(`Created ${directory}`);
} catch (error) {
  console.error(getErrorMessage(error));
  process.exitCode = 1;
}
