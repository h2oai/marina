// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from "vitest";
import { getChatWs, useChatState } from "../hooks/use-chat-state";
import { requestParticipant, requestResidentMemory } from "../lib/memory-service";

vi.mock("../hooks/use-chat-state", async (original) => ({
  ...(await original<typeof import("../hooks/use-chat-state")>()),
  getChatWs: vi.fn(),
}));

class Socket extends EventTarget {
  readyState = WebSocket.OPEN;
  send = vi.fn();
  request() {
    const wire = JSON.parse(this.send.mock.lastCall![0] as string);
    return wire.command
      ? JSON.parse(wire.command.replace(/^\//, "").slice("memory api ".length))
      : wire;
  }
  reply(kind: string, value: Record<string, unknown>) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          data: { [kind]: { request_id: this.request().request_id, ...value } },
        }),
      }),
    );
  }
}
let socket: Socket;
beforeEach(() => {
  socket = new Socket();
  vi.mocked(getChatWs).mockReturnValue(socket as unknown as WebSocket);
  useChatState.getState().setLoggedIn(true, "Ada");
});

it("rejects a preview from the previous socket even when the resident name matches", async () => {
  const request = requestParticipant("context_preview", { query: "quartz" });
  const rejected = expect(request).rejects.toThrow(/changed|cancelled|disconnected/);
  vi.mocked(getChatWs).mockReturnValue(new Socket() as unknown as WebSocket);
  socket.reply("context_preview", { context: { private: "old connection" } });
  await rejected;
});

it("cancels a memory request across logout and same-name login on the same socket", async () => {
  const request = requestResidentMemory({ operation: "me" });
  expect(JSON.parse(socket.send.mock.lastCall![0] as string).command).toMatch(/^\/memory api /);
  const rejected = expect(request).rejects.toThrow(/changed|cancelled|disconnected/);
  useChatState.getState().setLoggedIn(false);
  useChatState.getState().setLoggedIn(true, "Ada");
  socket.reply("memory_service", { ok: true, result: { private: "old session" } });
  await rejected;
});

it("uses server-validated catalog keys but never reuses them across sockets", async () => {
  const manifest = {
    schema: "marina.capabilities.v1",
    key: "epoch:room:rank",
    revision: 1,
    commands: [{ name: "look" }],
  };
  const first = requestParticipant("capabilities");
  socket.reply("capabilities", manifest);
  await first;
  const second = requestParticipant<{ commands: unknown[] }>("capabilities");
  expect(socket.request().capability_key).toBe(manifest.key);
  socket.reply("capabilities", { key: manifest.key, unchanged: true });
  expect((await second).commands).toEqual(manifest.commands);
  socket = new Socket();
  vi.mocked(getChatWs).mockReturnValue(socket as unknown as WebSocket);
  const next = requestParticipant("capabilities");
  expect(socket.request().capability_key).toBeUndefined();
  socket.reply("capabilities", { ...manifest, key: "new epoch" });
  await next;
});

it("refreshes context on every query and ignores unrelated messages", async () => {
  for (const text of ["current", "corrected"]) {
    const request = requestParticipant<{ text: string }>("context_preview", { query: "quartz" });
    socket.dispatchEvent(new MessageEvent("message", { data: "null" }));
    socket.reply("context_preview", { text });
    expect((await request).text).toBe(text);
  }
  expect(socket.send).toHaveBeenCalledTimes(2);
});

it("updates cached metadata when the server changes its room or permission key", async () => {
  const first = requestParticipant("capabilities");
  socket.reply("capabilities", { key: "room-a", commands: [{ name: "old-room-action" }] });
  await first;
  const changed = requestParticipant<{ commands: unknown[] }>("capabilities");
  expect(socket.request().capability_key).toBe("room-a");
  socket.reply("capabilities", { key: "room-b", commands: [{ name: "new-room-action" }] });
  expect((await changed).commands).toEqual([{ name: "new-room-action" }]);
  const confirmed = requestParticipant<{ commands: unknown[] }>("capabilities");
  expect(socket.request().capability_key).toBe("room-b");
  socket.reply("capabilities", { key: "room-b", unchanged: true });
  expect((await confirmed).commands).toEqual([{ name: "new-room-action" }]);
});
