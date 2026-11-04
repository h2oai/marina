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
 *
 * `--start`: an on-demand world. With no target of its own the bridge adopts
 * the instance running in the data directory (default `~/.marina/mcp`), or
 * starts one there — a detached `marina start` on free loopback ports that
 * records itself in `endpoint.json` and exits on its own after `--idle`
 * (default 30m) without external use. Every MCP client that launches the
 * bridge this way (the Claude Code plugin, a desktop app) shares that one
 * world, and nobody has to run a server first.
 */

import { spawn as spawnProcess } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dataDir as configuredDataDir } from "../src/config/data-dir";
import { getErrorMessage } from "../src/engine/errors";
import {
  type EndpointInfo,
  endpointFilePath,
  parseIdleShutdown,
  readEndpointFile,
} from "../src/net/instance-lifecycle";
import { IS_COMPILED, MARINA_ROOT } from "../src/runtime-paths";
import { userMarinaDir } from "./cli-env";

export interface McpTarget {
  url: string;
  token?: string;
}

/** Where `--start` keeps the on-demand world when no data directory is named. */
export function defaultStartDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(userMarinaDir(env), "mcp");
}

/** The on-demand instance's log, beside its database. */
export function startLogPath(dataDir: string): string {
  return join(dataDir, "server.log");
}

export const DEFAULT_START_IDLE = "30m";
/** How long `--start` waits for the instance it launched to record its endpoint. */
export const START_TIMEOUT_MS = 60_000;

export interface StartOptions {
  dataDir: string;
  /** `MARINA_IDLE_SHUTDOWN` for a launched instance (`30m`, `1h`, `0` = never). */
  idle: string;
  timeoutMs?: number;
}

/** The spawner and clock `ensureInstance` runs on; tests pass fakes. */
export interface StartDeps {
  readEndpoint: (dataDir: string) => EndpointInfo | undefined;
  /** Launch a detached server for the data directory; returns its pid. */
  launch: (opts: StartOptions) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

/**
 * Start a detached `marina start` for the data directory: loopback only, free
 * WebSocket and MCP ports, telnet and the log viewer off, its own database and
 * keys under the directory (`MARINA_DATA_DIR`), idle shutdown on. It outlives
 * this bridge so later clients adopt it; output goes to `server.log` there.
 */
export async function launchInstance(opts: StartOptions): Promise<number> {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  parseIdleShutdown(opts.idle); // a bad duration fails here, not in a detached child
  const [wsPort, mcpPort] = await Promise.all([freePort(), freePort()]);
  const log = openSync(startLogPath(opts.dataDir), "a", 0o600);
  const argv = IS_COMPILED
    ? ["start"]
    : ["--no-env-file", join(MARINA_ROOT, "scripts/marina.ts"), "start"];
  const child = spawnProcess(process.execPath, argv, {
    // The compiled binary's working directory is its instance (`marina start`
    // reads `<cwd>/.env`); from source it is the checkout, as `marina .` does,
    // and MARINA_DATA_DIR roots every data path under the directory either way.
    cwd: IS_COMPILED ? opts.dataDir : MARINA_ROOT,
    env: {
      ...process.env,
      MARINA_DATA_DIR: opts.dataDir,
      WS_HOST: "127.0.0.1",
      WS_PORT: String(wsPort),
      MCP_PORT: String(mcpPort),
      TELNET_PORT: "0",
      LOG_PORT: "0",
      MARINA_IDLE_SHUTDOWN: opts.idle,
    },
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  const pid = child.pid;
  if (!pid) throw new Error("Marina could not be started (no pid)");
  return pid;
}

const DEFAULT_START_DEPS: StartDeps = {
  readEndpoint: (dir) => {
    const path = endpointFilePath(dir);
    return path ? readEndpointFile(path) : undefined;
  },
  launch: launchInstance,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
  log: (line) => process.stderr.write(`[marina mcp-stdio] ${line}\n`),
};

/**
 * The MCP-serving instance for a data directory: the one already running
 * there, else one started now and awaited until it has written its endpoint.
 * Two bridges starting at once both launch; the loser dies on the database
 * lease and the poll adopts whichever instance recorded itself.
 */
export async function ensureInstance(
  opts: StartOptions,
  deps: StartDeps = DEFAULT_START_DEPS,
): Promise<EndpointInfo> {
  const running = deps.readEndpoint(opts.dataDir);
  if (running?.mcpUrl) return running;
  const pid = await deps.launch(opts);
  deps.log(`starting Marina (pid ${pid}) in ${opts.dataDir}; log ${startLogPath(opts.dataDir)}`);
  const deadline = deps.now() + (opts.timeoutMs ?? START_TIMEOUT_MS);
  while (deps.now() < deadline) {
    await deps.sleep(250);
    const endpoint = deps.readEndpoint(opts.dataDir);
    if (endpoint?.mcpUrl) {
      deps.log(
        `Marina ${endpoint.version} ready at ${endpoint.url} (dashboard) — ${endpoint.mcpUrl}`,
      );
      return endpoint;
    }
  }
  throw new Error(
    `Marina did not come up within ${Math.round((opts.timeoutMs ?? START_TIMEOUT_MS) / 1000)}s. ` +
      `See ${startLogPath(opts.dataDir)}.`,
  );
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

export interface TargetFlags {
  url?: string;
  token?: string;
  dataDir?: string;
  /** Adopt or start the instance in the data directory (default `~/.marina/mcp`). */
  start?: boolean;
  idle?: string;
}

/** The data directory `--start` acts on: the flag, `MARINA_DATA_DIR`, else `~/.marina/mcp`. */
export function startDataDir(flags: TargetFlags, env: NodeJS.ProcessEnv = process.env): string {
  return flags.dataDir ?? configuredDataDir(env) ?? defaultStartDataDir(env);
}

export async function resolveMcpTarget(
  flags: TargetFlags,
  env: NodeJS.ProcessEnv = process.env,
  deps?: StartDeps,
): Promise<McpTarget> {
  const url = flags.url ?? env.MARINA_MCP_URL?.trim();
  const token = flags.token ?? env.MARINA_TOKEN?.trim();
  if (url) return { url, ...(token ? { token } : {}) };
  const endpoint = flags.start
    ? await ensureInstance(
        { dataDir: startDataDir(flags, env), idle: flags.idle ?? DEFAULT_START_IDLE },
        deps,
      )
    : discoverEndpoint(flags.dataDir, env);
  if (!endpoint?.mcpUrl) {
    throw new Error(
      "No running Marina found. Pass --url <http://host:port/mcp> (and --token), set MARINA_MCP_URL, " +
        "point --data-dir / MARINA_DATA_DIR at a running instance's data directory, " +
        "or pass --start to start one there.",
    );
  }
  const key = token ?? endpoint.apiKey;
  return { url: endpoint.mcpUrl, ...(key ? { token: key } : {}) };
}

/** How this process can launch the bridge again: the compiled binary, or Bun plus the script. */
export interface BridgeLauncher {
  compiled: boolean;
  /** The running binary: the compiled `marina`, or the Bun running the script. */
  execPath: string;
  /** Absolute path of `scripts/marina.ts` (ignored when compiled). */
  script: string;
}

/**
 * The `mcpServers` entry that launches this bridge by absolute path. Desktop
 * MCP clients start servers with a bare PATH, where neither `marina` nor the
 * `bun` its shebang names may be found, so the entry names the binary itself.
 * Target flags are kept as given; with none, the local server's MCP port.
 */
export function mcpServerConfig(
  targetArgs: string[],
  launcher: BridgeLauncher,
  env: NodeJS.ProcessEnv = process.env,
): { mcpServers: { marina: { command: string; args: string[] } } } {
  const hasTarget = targetArgs.some((a) => /^--(url|data-dir|start)(=|$)/.test(a));
  const target =
    hasTarget || env.MARINA_MCP_URL?.trim()
      ? targetArgs
      : ["--url", `http://127.0.0.1:${env.MCP_PORT?.trim() || "3301"}/mcp`, ...targetArgs];
  const args = launcher.compiled
    ? ["mcp-stdio", ...target]
    : ["--no-env-file", launcher.script, "mcp-stdio", ...target];
  return { mcpServers: { marina: { command: launcher.execPath, args } } };
}

/** Streams the bridge reads and writes; tests pass their own. */
export interface McpStdioIO {
  stdin?: Readable;
  stdout?: Writable;
}

export async function runMcpStdio(argv: string[], io: McpStdioIO = {}): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        token: { type: "string" },
        "data-dir": { type: "string" },
        start: { type: "boolean" },
        idle: { type: "string" },
      },
    });
    const target = await resolveMcpTarget({
      ...(values.url ? { url: values.url } : {}),
      ...(values.token ? { token: values.token } : {}),
      ...(values["data-dir"] ? { dataDir: values["data-dir"] } : {}),
      ...(values.start ? { start: true } : {}),
      ...(values.idle ? { idle: values.idle } : {}),
    });
    const upstream = new StreamableHTTPClientTransport(new URL(target.url), {
      requestInit: target.token ? { headers: { Authorization: `Bearer ${target.token}` } } : {},
    });
    const stdin = io.stdin ?? process.stdin;
    const local = new StdioServerTransport(stdin, io.stdout ?? process.stdout);
    // The stdio transport never ends on its own: it ignores stdin EOF. A client
    // that goes away closes our stdin, so end there — or the bridge (and its
    // upstream MCP session) would outlive the client indefinitely.
    const closed = new Promise<void>((resolve) => {
      local.onclose = () => resolve();
      upstream.onclose = () => resolve();
      stdin.once("end", () => resolve());
      stdin.once("close", () => resolve());
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
    // End the upstream session explicitly (HTTP DELETE) so Marina releases its
    // connection now rather than when its stale-session sweep finds it.
    await upstream.terminateSession().catch(() => undefined);
    await Promise.allSettled([upstream.close(), local.close()]);
    return 0;
  } catch (err) {
    process.stderr.write(`marina mcp-stdio: ${getErrorMessage(err)}\n`);
    return 1;
  }
}
