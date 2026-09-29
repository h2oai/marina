// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ports this process's listeners actually bound. Internal self-URLs (the
 * `marina/default` proxy, `ask`, benchmark runs) and discovery replies use
 * these instead of re-reading `WS_PORT` / `MCP_PORT` with a hard-coded
 * 3300/3301 fallback, so a custom or ephemeral (`WS_PORT=0`) port works.
 * Before a listener has bound, the configured env value is used, then the
 * default layout (WS 3300, MCP = WS + 1, logs = WS + 2).
 */

type Listener = "websocket" | "mcp" | "log";

const bound: Partial<Record<Listener, number>> = {};

/** Called by each listener once it has bound (the real port, never 0). */
export function recordListenPort(listener: Listener, port: number): void {
  if (Number.isFinite(port) && port > 0) bound[listener] = Math.trunc(port);
}

function envPort(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

/** The WebSocket/HTTP port (`/v1`, `/mem`, dashboard). */
export function localWsPort(env: NodeJS.ProcessEnv = process.env): number {
  return bound.websocket ?? envPort("WS_PORT", env) ?? 3300;
}

/** The MCP port: bound, else `MCP_PORT`, else WebSocket port + 1. */
export function localMcpPort(env: NodeJS.ProcessEnv = process.env): number {
  return bound.mcp ?? envPort("MCP_PORT", env) ?? localWsPort(env) + 1;
}

/** Base URL of this process's own HTTP server (loopback). */
export function localHttpBase(env: NodeJS.ProcessEnv = process.env): string {
  return `http://localhost:${localWsPort(env)}`;
}

export function resetListenPortsForTests(): void {
  for (const key of Object.keys(bound) as Listener[]) delete bound[key];
}

/** Snapshot the recorded ports; disposing restores that exact snapshot. A
 *  test that starts a real listener records its port process-wide, so any
 *  later file in the same process would otherwise read it. */
export function preserveListenPortsForTests(): Disposable {
  const snapshot = { ...bound };
  return {
    [Symbol.dispose]() {
      resetListenPortsForTests();
      Object.assign(bound, snapshot);
    },
  };
}
