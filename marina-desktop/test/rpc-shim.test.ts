// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, mock, test } from "bun:test";

test("native socket relays detach on close and a late connect cannot reopen a closed socket", async () => {
  const connect = Promise.withResolvers<void>();
  const disconnect = mock(async () => {});
  const networkFetch = mock(async () => new Response("external"));
  const getWorld = mock(async () => ({ name: "Desktop world" }));
  const proxyApi = mock(async (_params: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ privateVisible: true, inventory: [] }),
  }));
  let messages: Record<string, (data: unknown) => void> = {};
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const windowStub = {
    WebSocket,
    fetch: networkFetch as unknown as typeof fetch,
    location: { protocol: "views:", origin: "null" },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  mock.module("electrobun/view", () => ({
    Electroview: class {
      constructor(readonly options: unknown) {}
      static defineRPC(options: { handlers: { messages: typeof messages } }) {
        messages = options.handlers.messages;
        return {
          request: {
            gameConnect: () => connect.promise,
            gameDisconnect: disconnect,
            getWorld,
            proxyApi,
          },
          send: { ready: () => {} },
        };
      }
    },
  }));
  const sockets: WebSocket[] = [];
  try {
    await import("../src/views/dashboard/rpc-shim");
    expect(
      await (await windowStub.fetch("http://marina.desktop.invalid/api/world")).json(),
    ).toEqual({ name: "Desktop world" });
    expect(await (await windowStub.fetch("/api/world")).json()).toEqual({ name: "Desktop world" });
    expect(getWorld).toHaveBeenCalledTimes(2);
    expect(await (await windowStub.fetch("https://example.org/api/world")).text()).toBe("external");
    expect(networkFetch).toHaveBeenCalledTimes(1);
    expect(await (await windowStub.fetch("/api/entities/Resident/preview")).json()).toMatchObject({
      privateVisible: true,
    });
    expect(proxyApi).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/entities/Resident/preview" }),
    );
    for (const [path, push] of [
      ["dashboard-ws", "snapshot"],
      ["canvas-ws", "canvasEvent"],
      ["ws", "gameMessage"],
    ]) {
      const socket = new windowStub.WebSocket(`ws://desktop.invalid/${path}`);
      sockets.push(socket);
      const received = mock(() => {});
      const opened = mock(() => {});
      const closed = mock(() => {});
      socket.onmessage = received;
      socket.onopen = opened;
      socket.onclose = closed;
      messages[push!]!({ fixture: true });
      expect(received).toHaveBeenCalledTimes(1);
      socket.close();
      socket.close();
      messages[push!]!({ fixture: "after close" });
      await Promise.resolve();
      expect(received).toHaveBeenCalledTimes(1);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(opened).not.toHaveBeenCalled();
    }
    connect.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    connect.resolve();
    for (const socket of sockets) socket.close();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    mock.restore();
  }
});
