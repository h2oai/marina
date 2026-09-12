// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getErrorMessage } from "../src/engine/errors";
import { createMemoryMcpServer } from "../src/net/mcp-server";
import { MarinaMemoryClient } from "../src/sdk/memory-client";

try {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      url: { type: "string", default: process.env.MARINA_MEMORY_URL ?? "http://127.0.0.1:3301" },
      credentials: { type: "string" },
      space: { type: "string" },
    },
  });
  const credentials = values.credentials
    ? JSON.parse(readFileSync(values.credentials, "utf8"))
    : {};
  const token = process.env.MARINA_MEMORY_TOKEN ?? credentials.token;
  const space = values.space ?? process.env.MARINA_MEMORY_SPACE ?? credentials.spaceId;
  if (typeof token !== "string" || !token || typeof space !== "string" || !space)
    throw new Error(
      "Supply --credentials <file> from memory init, or MARINA_MEMORY_TOKEN and MARINA_MEMORY_SPACE",
    );
  const client = new MarinaMemoryClient(values.url, token);
  await client.space(space); // Fail startup clearly for expired credentials or inaccessible space.
  const server = createMemoryMcpServer(client, space);
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(`Marina memory MCP: ${getErrorMessage(error)}`);
  process.exitCode = 1;
}
