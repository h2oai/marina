// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared fixtures for the websocket-*.test.ts family (split from the former
 * single websocket.test.ts so each describe block runs as its own file).
 */

let dbCounter = 0;
export function tmpDbPath(): string {
  return `/tmp/marina-ws-test-${process.pid}-${Date.now()}-${++dbCounter}.db`;
}

/** Open a WebSocket and collect messages until a condition or timeout. */
export function openWs(
  port: number,
  opts?: { path?: string },
): {
  ws: WebSocket;
  messages: string[];
  waitFor: (pred: (msgs: string[]) => boolean, ms?: number) => Promise<void>;
  close: () => Promise<void>;
} {
  const path = opts?.path ?? "/ws";
  const ws = new WebSocket(`ws://localhost:${port}${path}`);
  const messages: string[] = [];

  ws.onmessage = (event) => {
    messages.push(event.data as string);
  };

  const waitFor = (pred: (msgs: string[]) => boolean, ms = 3000) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (pred(messages)) return resolve();
      };
      ws.onmessage = (event) => {
        messages.push(event.data as string);
        check();
      };
      check();
      setTimeout(resolve, ms);
    });

  const close = async () => {
    ws.close();
    await Bun.sleep(50);
  };

  return { ws, messages, waitFor, close };
}

export function parse(msg: string): { kind: string; data: Record<string, unknown> } {
  return JSON.parse(msg);
}
