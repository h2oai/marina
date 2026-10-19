// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the HTTP/WebSocket listener counts as use for `MARINA_IDLE_SHUTDOWN`
 * (`src/net/instance-lifecycle.ts`): a streamed response stays in flight until
 * its body ends, an open WebSocket holds the instance until it closes, and
 * health probes never count.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { instanceActivity } from "../src/net/instance-lifecycle";
import { WebSocketServer } from "../src/net/websocket-server";
import { createTestEngine } from "./engine-fixture";
import { until } from "./helpers";

describe("idle-shutdown activity on the HTTP/WebSocket listener", () => {
  let world: ReturnType<typeof createTestEngine>;
  let server: WebSocketServer;
  let base: string;
  let push: (text: string) => void = () => {};
  let end: () => void = () => {};

  beforeEach(() => {
    world = createTestEngine();
    server = new WebSocketServer(world.engine, 0);
    // A controllable event stream on the mounted `/mcp` route.
    server.mountMcp(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(new TextEncoder().encode(text));
          end = () => controller.close();
          // The first event flushes the headers, so the caller's fetch resolves.
          push("data: 0\n\n");
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    server.start();
    base = `127.0.0.1:${server.getPort()}`;
  });

  afterEach(async () => {
    await server.stop();
    await world.dispose();
  });

  it("keeps a streamed response in flight until its body ends", async () => {
    const before = instanceActivity.inFlight;
    const res = await fetch(`http://${base}/mcp`, { method: "POST", body: "{}" });
    const reader = res.body!.getReader();
    await reader.read();
    // The handler has returned; the stream is still open.
    expect(instanceActivity.inFlight).toBe(before + 1);
    end();
    while (!(await reader.read()).done) {}
    await until(() => instanceActivity.inFlight === before);
  });

  it("an open WebSocket holds the instance until it closes", async () => {
    const before = instanceActivity.inFlight;
    const ws = new WebSocket(`ws://${base}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("websocket failed"));
    });
    await until(() => instanceActivity.inFlight === before + 1);
    ws.close();
    await until(() => instanceActivity.inFlight === before);
  });

  it("health probes do not count", async () => {
    const last = instanceActivity.lastActivityAt;
    await (await fetch(`http://${base}/health`)).text();
    expect(instanceActivity.lastActivityAt).toBe(last);
  });
});
