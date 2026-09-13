// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  MemoryOperationRequest,
  MemoryOperationResult,
} from "../../../src/sdk/memory-operations";
import { getChatWs, useChatState } from "../hooks/use-chat-state";

/** Reuse the authenticated resident connection. Service credentials never reach the browser. */
export function requestResidentMemory<T>(
  request: MemoryOperationRequest,
  signal?: AbortSignal,
): Promise<T> {
  const ws = getChatWs();
  const identity = useChatState.getState();
  if (!ws || ws.readyState !== WebSocket.OPEN || !identity.loggedIn || !identity.entityName)
    return Promise.reject(new Error("Sign in to world chat to open your memory."));
  signal?.throwIfAborted();
  const request_id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const done = (error?: Error, result?: T) => {
      clearTimeout(timer);
      ws.removeEventListener("message", receive);
      ws.removeEventListener("close", closed);
      signal?.removeEventListener("abort", cancelled);
      if (error) reject(error);
      else resolve(result!);
    };
    const closed = () =>
      done(new Error("World connection closed; a submitted write may have committed."));
    const cancelled = () =>
      done(new Error("Memory request cancelled; a submitted write may have committed."));
    const receive = (event: MessageEvent) => {
      let data: { data?: { memory_service?: MemoryOperationResult & { request_id?: string } } };
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      const result = data?.data?.memory_service;
      if (result?.request_id !== request_id) return;
      const current = useChatState.getState();
      if (!current.loggedIn || current.entityName !== identity.entityName)
        return done(new Error("World identity changed."));
      if (!result.ok) return done(new Error(`${result.error.message} (${result.error.code})`));
      done(undefined, result.result as T);
    };
    const timer = setTimeout(
      () =>
        done(
          new Error("Memory request timed out. Retry a submitted write with the same request key."),
        ),
      35000,
    );
    ws.addEventListener("message", receive);
    ws.addEventListener("close", closed);
    signal?.addEventListener("abort", cancelled, { once: true });
    try {
      signal?.throwIfAborted();
      ws.send(
        JSON.stringify({
          type: "command",
          command: `memory api ${JSON.stringify({ ...request, request_id })}`,
        }),
      );
    } catch (error) {
      done(error instanceof Error ? error : new Error("Unable to send memory request"));
    }
  });
}
