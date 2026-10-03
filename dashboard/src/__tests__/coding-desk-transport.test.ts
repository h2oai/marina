// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import { ensureChatWs, useChatState } from "../hooks/use-chat-state";

it("sends an explicit coding target only after the resident connection advertises support", () => {
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    send = vi.fn();
  }
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  const socket = ensureChatWs(() => {}) as unknown as Socket;
  try {
    useChatState.getState().setLoggedIn(true, "Owner");
    socket.onopen?.();
    socket.send.mockClear();
    expect(
      useChatState.getState().sendCommand("code ask Work", false, { sessionId: "marina" }),
    ).toBe(false);
    socket.onmessage?.({
      data: JSON.stringify({ kind: "system", data: { codingTargetProtocol: "session-run-v1" } }),
    });
    expect(useChatState.getState().codingTargetSupported).toBe(false);
    socket.onmessage?.({
      data: JSON.stringify({
        kind: "system",
        data: { entityId: "owner", token: "credential", codingTargetProtocol: "session-run-v1" },
      }),
    });
    expect(
      useChatState.getState().sendCommand("code ask Work", false, { sessionId: "marina" }),
    ).toBe(true);
    expect(JSON.parse(socket.send.mock.lastCall![0])).toEqual({
      type: "command",
      command: "code ask Work",
      coding_target: { sessionId: "marina" },
    });
    expect(() =>
      useChatState.getState().sendCommand("code ask Work", false, { sessionId: "../foreign" }),
    ).toThrow();
    expect(socket.send).toHaveBeenCalledTimes(1);
    socket.onclose?.();
    expect(useChatState.getState().codingTargetSupported).toBe(false);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
