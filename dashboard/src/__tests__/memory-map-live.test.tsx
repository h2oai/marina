// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `useMemoryMapLive` against a fake dashboard WebSocket: the hook owns its own
 * `message` listener (the shared socket hook only routes the `{type:"event"}`
 * envelope), so these tests pin the contract the canvas MEMORY layer relies on
 * — in-place job patches, one debounced refetch per burst of shape-changing
 * service events, clean detach/re-attach, and no JSON.parse on foreign frames.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  memoryGraphUrl,
  type UseMemoryMapLiveOptions,
  useMemoryMapLive,
  useMemoryMapState,
} from "../unified/hooks/use-memory-map";
import { MEMORY_REFETCH_DEBOUNCE_MS, type MemoryGraph } from "../unified/lib/memory-map-types";

const fetchApi = vi.fn();

vi.mock("../lib/api", () => ({
  fetchApi: (...args: unknown[]) => fetchApi(...args),
}));

/** Minimal stand-in for the dashboard WebSocket: an EventTarget with `readyState`. */
class FakeSocket extends EventTarget {
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  /** Deliver a frame — objects are serialized, strings/binary go through verbatim. */
  emit(frame: unknown): void {
    const data =
      typeof frame === "string" || frame instanceof ArrayBuffer ? frame : JSON.stringify(frame);
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function graph(): MemoryGraph {
  return {
    nodes: [
      { id: "helper:reflector-1", kind: "helper", label: "reflector-1", role: "memory-reflector" },
      {
        id: "job:7",
        kind: "job",
        label: "reflector 7",
        state: "pending",
        role: "reflector",
        entityName: "alice",
        meta: { remainingOperations: 10, initialOperations: 10 },
      },
    ],
    edges: [],
    truncated: false,
  };
}

function options(overrides: Partial<UseMemoryMapLiveOptions> = {}): UseMemoryMapLiveOptions {
  return {
    enabled: true,
    entityName: undefined,
    wsRef: { current: new FakeSocket() as unknown as WebSocket },
    connected: true,
    ...overrides,
  };
}

const state = () => useMemoryMapState.getState();
const jobNode = () => state().graph.nodes.find((node) => node.id === "job:7");

/** Let the mocked fetch promise settle and React commit — no timers involved. */
async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  state().reset();
  fetchApi.mockReset();
  fetchApi.mockResolvedValue(graph());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useMemoryMapLive", () => {
  it("does nothing while disabled: no fetch, no listener", () => {
    const ws = new FakeSocket();
    const add = vi.spyOn(ws, "addEventListener");
    renderHook(() =>
      useMemoryMapLive(options({ enabled: false, wsRef: { current: ws as unknown as WebSocket } })),
    );
    expect(fetchApi).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("fetches the graph on enable and patches job nodes from memory_job frames (top-level and enveloped)", async () => {
    const ws = new FakeSocket();
    renderHook(() => useMemoryMapLive(options({ wsRef: { current: ws as unknown as WebSocket } })));
    await waitFor(() => expect(state().loaded).toBe(true));
    expect(fetchApi).toHaveBeenCalledWith(memoryGraphUrl(undefined));
    expect(jobNode()?.state).toBe("pending");

    // Top-level contract shape.
    act(() => {
      ws.emit({
        type: "memory_job",
        job: { id: "7", state: "running", remainingOperations: 8, workerName: "reflector-1" },
        timestamp: 2000,
      });
    });
    expect(jobNode()?.state).toBe("running");
    expect(jobNode()?.meta?.remainingOperations).toBe(8);
    expect(state().pulses["job:7"]).toBe(2000);
    // The worker edge is synthesised because the helper node is already known.
    expect(state().graph.edges).toContainEqual(
      expect.objectContaining({
        relationship: "worker",
        source: "helper:reflector-1",
        target: "job:7",
      }),
    );

    // Dashboard envelope shape.
    act(() => {
      ws.emit({
        type: "event",
        data: { type: "memory_job", job: { id: "7", state: "answered" }, timestamp: 3000 },
      });
    });
    expect(jobNode()?.state).toBe("answered");
    expect(state().pulses["job:7"]).toBe(3000);

    // An unknown job is inserted rather than dropped.
    act(() => {
      ws.emit({
        type: "memory_job",
        job: { id: "8", state: "pending", role: "librarian" },
        timestamp: 4000,
      });
    });
    expect(state().graph.nodes.some((node) => node.id === "job:8")).toBe(true);
    // Patches never triggered a refetch.
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst of shape-changing service events into ONE refetch after the debounce; unrelated kinds never refetch", async () => {
    vi.useFakeTimers();
    const ws = new FakeSocket();
    renderHook(() => useMemoryMapLive(options({ wsRef: { current: ws as unknown as WebSocket } })));
    await flush();
    expect(state().loaded).toBe(true);
    expect(fetchApi).toHaveBeenCalledTimes(1);

    act(() => {
      ws.emit({ type: "memory_service_event", kind: "memory.resolved", timestamp: 1 });
      ws.emit({
        type: "event",
        data: { type: "memory_service_event", kind: "assistance.adopted" },
      });
      ws.emit({ type: "memory_service_event", kind: "memory.created", timestamp: 3 });
    });
    // Trailing edge: nothing until the debounce elapses.
    expect(fetchApi).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEMORY_REFETCH_DEBOUNCE_MS - 1);
    });
    expect(fetchApi).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchApi).toHaveBeenCalledTimes(2);
    expect(MEMORY_REFETCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(2000);

    act(() => {
      ws.emit({ type: "memory_service_event", kind: "memory.revised", timestamp: 5 });
      ws.emit({ type: "memory_service_event", kind: "source.captured", timestamp: 6 });
      ws.emit({
        type: "event",
        data: { type: "memory_service_event", kind: "assistance.created" },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEMORY_REFETCH_DEBOUNCE_MS * 2);
    });
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });

  it("detaches its listener on unmount and re-attaches to the new socket when `connected` flips", async () => {
    const ws1 = new FakeSocket();
    const add1 = vi.spyOn(ws1, "addEventListener");
    const remove1 = vi.spyOn(ws1, "removeEventListener");
    const wsRef = { current: ws1 as unknown as WebSocket };
    const { rerender, unmount } = renderHook(
      (props: UseMemoryMapLiveOptions) => useMemoryMapLive(props),
      {
        initialProps: options({ wsRef }),
      },
    );
    await waitFor(() => expect(state().loaded).toBe(true));
    expect(add1).toHaveBeenCalledWith("message", expect.any(Function));
    const fetchesBeforeReconnect = fetchApi.mock.calls.length;

    // Drop → the socket hook swaps in a new WebSocket → connected flips back on.
    rerender(options({ wsRef, connected: false }));
    const ws2 = new FakeSocket();
    const add2 = vi.spyOn(ws2, "addEventListener");
    const remove2 = vi.spyOn(ws2, "removeEventListener");
    wsRef.current = ws2 as unknown as WebSocket;
    rerender(options({ wsRef, connected: true }));
    await flush();

    expect(remove1).toHaveBeenCalledWith("message", expect.any(Function));
    expect(add2).toHaveBeenCalledWith("message", expect.any(Function));
    // Reconnect refetches so the graph cannot go stale across the gap.
    expect(fetchApi.mock.calls.length).toBeGreaterThan(fetchesBeforeReconnect);

    // Frames on the dead socket are ignored; the live one is applied.
    act(() => {
      ws1.emit({ type: "memory_job", job: { id: "7", state: "cancelled" }, timestamp: 10 });
    });
    expect(jobNode()?.state).toBe("pending");
    act(() => {
      ws2.emit({ type: "memory_job", job: { id: "7", state: "running" }, timestamp: 11 });
    });
    expect(jobNode()?.state).toBe("running");

    unmount();
    expect(remove2).toHaveBeenCalledWith("message", expect.any(Function));
    act(() => {
      ws2.emit({ type: "memory_job", job: { id: "7", state: "answered" }, timestamp: 12 });
    });
    expect(jobNode()?.state).toBe("running");
  });

  it("ignores non-memory frames without JSON-parsing them", async () => {
    const ws = new FakeSocket();
    renderHook(() => useMemoryMapLive(options({ wsRef: { current: ws as unknown as WebSocket } })));
    await waitFor(() => expect(state().loaded).toBe(true));

    const parse = vi.spyOn(JSON, "parse");
    act(() => {
      ws.emit({ type: "event", data: { type: "entity_enter", entity: "alice", timestamp: 1 } });
      ws.emit({ type: "world_state", entities: [], timestamp: 2 });
      ws.emit("not even json");
      ws.emit(new ArrayBuffer(8));
    });
    expect(parse).not.toHaveBeenCalled();
    expect(jobNode()?.state).toBe("pending");

    act(() => {
      ws.emit({ type: "memory_job", job: { id: "7", state: "running" }, timestamp: 3 });
    });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(jobNode()?.state).toBe("running");

    // A frame that merely mentions the prefix but is not a memory event is parsed then dropped.
    act(() => {
      ws.emit({ type: "memory_unrelated", timestamp: 4 });
    });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(jobNode()?.state).toBe("running");
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });
});
