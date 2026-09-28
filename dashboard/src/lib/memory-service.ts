// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CapabilityManifest } from "../../../src/sdk/capabilities";
import type {
  MemoryOperationRequest,
  MemoryOperationResult,
} from "../../../src/sdk/memory-operations";
import { getChatWs, useChatState } from "../hooks/use-chat-state";

function matchesResident(ws: WebSocket, name: string | null): boolean {
  const current = useChatState.getState();
  return getChatWs() === ws && current.loggedIn && current.entityName === name;
}

// Only public command metadata is cached. The server validates its room/rank/revision key
// on every request; memory previews always fetch fresh content for the bound connection.
const capabilityCache = new WeakMap<
  WebSocket,
  {
    name: string | null;
    sequence: number;
    manifest: CapabilityManifest;
  }
>();
let capabilitySequence = 0;

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
      unsubscribe();
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
      if (!matchesResident(ws, identity.entityName)) return changed();
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
    const changed = () =>
      done(
        new Error("World connection or identity changed; a submitted write may have committed."),
      );
    const unsubscribe = useChatState.subscribe(() => {
      if (!matchesResident(ws, identity.entityName)) changed();
    });
    ws.addEventListener("message", receive);
    ws.addEventListener("close", closed);
    signal?.addEventListener("abort", cancelled, { once: true });
    try {
      signal?.throwIfAborted();
      ws.send(
        JSON.stringify({
          type: "command",
          command: `/memory api ${JSON.stringify({ ...request, request_id })}`,
        }),
      );
    } catch (error) {
      done(error instanceof Error ? error : new Error("Unable to send memory request"));
    }
  });
}

/** Read-only participant request using the resident session, independent of dashboard admin auth. */
export function requestParticipant<T>(
  kind: "capabilities" | "context_preview",
  options: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const ws = getChatWs();
  const identity = useChatState.getState();
  if (!ws || ws.readyState !== WebSocket.OPEN || !identity.loggedIn)
    return Promise.reject(new Error("Sign in to world chat first."));
  signal?.throwIfAborted();
  const request_id = crypto.randomUUID();
  const cached = capabilityCache.get(ws);
  const manifest = cached?.name === identity.entityName ? cached.manifest : undefined;
  const sequence = ++capabilitySequence;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", receive);
      ws.removeEventListener("close", closed);
      signal?.removeEventListener("abort", closed);
      unsubscribe();
    };
    const closed = () => {
      cleanup();
      reject(new Error("Participant request cancelled or disconnected."));
    };
    const receive = (event: MessageEvent) => {
      let value: {
        data?: Record<
          string,
          Partial<CapabilityManifest> & { error?: string; unchanged?: boolean }
        >;
      };
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      const result = value?.data?.[kind];
      if (result?.request_id !== request_id) return;
      if (!matchesResident(ws, identity.entityName)) return closed();
      cleanup();
      if (result.error) reject(new Error(result.error));
      else if (kind === "capabilities") {
        const next =
          result.unchanged && manifest?.key && result.key === manifest.key
            ? { ...manifest, request_id }
            : result;
        if (!Array.isArray(next.commands)) {
          reject(new Error("Command discovery changed; refresh capabilities."));
          return;
        }
        if (sequence >= (capabilityCache.get(ws)?.sequence ?? 0))
          capabilityCache.set(ws, {
            name: identity.entityName,
            sequence,
            manifest: next as CapabilityManifest,
          });
        resolve(next as T);
      } else resolve(result as T);
    };
    const timer = setTimeout(closed, 15000);
    const unsubscribe = useChatState.subscribe(() => {
      if (!matchesResident(ws, identity.entityName)) {
        capabilityCache.delete(ws);
        closed();
      }
    });
    ws.addEventListener("message", receive);
    ws.addEventListener("close", closed);
    signal?.addEventListener("abort", closed, { once: true });
    try {
      signal?.throwIfAborted();
      ws.send(
        JSON.stringify(
          kind === "capabilities"
            ? { type: "capabilities", request_id, capability_key: manifest?.key }
            : { type: "context_preview", options, request_id },
        ),
      );
    } catch {
      closed();
    }
  });
}
