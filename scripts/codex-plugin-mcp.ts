// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Bundled plugin entrypoint. Credentials stay outside the installed package. */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getErrorMessage } from "../src/engine/errors";
import { createMemoryMcpServer } from "../src/net/mcp/mcp-memory-tools";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { runMcpStdio } from "./mcp-stdio";

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mode: { type: "string" },
      url: { type: "string" },
      credentials: { type: "string" },
    },
  });
  if (!values.url || (values.mode !== "memory" && values.mode !== "world")) {
    throw new Error("Expected --mode memory|world and --url; rebuild with build:codex-plugin");
  }
  let credential: { token?: unknown; spaceId?: unknown } = {};
  if (values.credentials) {
    // Never include JSON parser errors: they can contain part of a secret.
    try {
      credential = JSON.parse(readFileSync(values.credentials, "utf8"));
      if (!credential || typeof credential !== "object") throw new Error("Invalid credential");
    } catch {
      throw new Error("Cannot read credential file. Run the marina-setup skill to check setup.");
    }
    if (typeof credential.token !== "string" || !credential.token.trim()) {
      throw new Error("Credential file must contain a nonempty token");
    }
  }
  if (values.mode === "world") {
    // Explicit empty token prevents the bridge from inheriting another resident's MARINA_TOKEN.
    return runMcpStdio([
      "--url",
      values.url,
      "--token",
      (credential.token as string | undefined) ?? "",
    ]);
  }
  if (
    typeof credential.token !== "string" ||
    typeof credential.spaceId !== "string" ||
    !credential.spaceId.trim()
  ) {
    throw new Error("Memory requires a credential file with token and spaceId from memory init");
  }
  const client = new MarinaMemoryClient(values.url, credential.token);
  await client.space(credential.spaceId);
  const server = createMemoryMcpServer(client, credential.spaceId);
  const closed = new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  try {
    await server.connect(new StdioServerTransport());
    await closed;
  } finally {
    await server.close();
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`Marina plugin: ${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
