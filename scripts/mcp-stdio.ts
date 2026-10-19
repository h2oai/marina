// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `marina mcp-stdio` — a stdio MCP server that forwards every message to a
 * running Marina's Streamable HTTP `/mcp`, so MCP clients that only launch
 * stdio servers (and MCP registries) reach the full world tool surface with no
 * checkout. stdout carries protocol frames only; diagnostics go to stderr.
 *
 * Target, first match wins: `--url` / `--token`, `MARINA_MCP_URL` /
 * `MARINA_TOKEN`, then the instance described by `endpoint.json` in
 * `--data-dir` / `MARINA_DATA_DIR` (its `mcpUrl` and local key).
 */

import { parseArgs } from "node:util";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dataDir as configuredDataDir } from "../src/config/data-dir";
import { getErrorMessage } from "../src/engine/errors";
import {
  type EndpointInfo,
  endpointFilePath,
  readEndpointFile,
} from "../src/net/instance-lifecycle";

export interface McpTarget {
  url: string;
  token?: string;
}

/** The live instance for a data directory, or undefined (no directory, or nothing running there). */
export function discoverEndpoint(
  dataDirFlag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): EndpointInfo | undefined {
  const dir = dataDirFlag ?? configuredDataDir(env);
  const path = endpointFilePath(dir);
  return path ? readEndpointFile(path) : undefined;
}

export function resolveMcpTarget(
  flags: { url?: string; token?: string; dataDir?: string },
  env: NodeJS.ProcessEnv = process.env,
): McpTarget {
  const url = flags.url ?? env.MARINA_MCP_URL?.trim();
  const token = flags.token ?? env.MARINA_TOKEN?.trim();
  if (url) return { url, ...(token ? { token } : {}) };
  const endpoint = discoverEndpoint(flags.dataDir, env);
  if (!endpoint?.mcpUrl) {
    throw new Error(
      "No running Marina found. Pass --url <http://host:port/mcp> (and --token), set MARINA_MCP_URL, " +
        "or point --data-dir / MARINA_DATA_DIR at a running instance's data directory.",
    );
  }
  const key = token ?? endpoint.apiKey;
  return { url: endpoint.mcpUrl, ...(key ? { token: key } : {}) };
}

export async function runMcpStdio(argv: string[]): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        token: { type: "string" },
        "data-dir": { type: "string" },
      },
    });
    const target = resolveMcpTarget({
      ...(values.url ? { url: values.url } : {}),
      ...(values.token ? { token: values.token } : {}),
      ...(values["data-dir"] ? { dataDir: values["data-dir"] } : {}),
    });
    const upstream = new StreamableHTTPClientTransport(new URL(target.url), {
      requestInit: target.token ? { headers: { Authorization: `Bearer ${target.token}` } } : {},
    });
    const local = new StdioServerTransport();
    const closed = new Promise<void>((resolve) => {
      local.onclose = () => resolve();
      upstream.onclose = () => resolve();
    });
    local.onmessage = (message) => {
      upstream.send(message).catch((err) => {
        process.stderr.write(`[marina mcp-stdio] upstream send failed: ${getErrorMessage(err)}\n`);
      });
    };
    upstream.onmessage = (message) => {
      local.send(message).catch((err) => {
        process.stderr.write(`[marina mcp-stdio] stdout write failed: ${getErrorMessage(err)}\n`);
      });
    };
    upstream.onerror = (err) => {
      process.stderr.write(`[marina mcp-stdio] ${getErrorMessage(err)}\n`);
    };
    await upstream.start();
    await local.start();
    process.stderr.write(`[marina mcp-stdio] forwarding to ${target.url}\n`);
    await closed;
    await Promise.allSettled([upstream.close(), local.close()]);
    return 0;
  } catch (err) {
    process.stderr.write(`marina mcp-stdio: ${getErrorMessage(err)}\n`);
    return 1;
  }
}
