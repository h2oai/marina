// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CanvasEvent,
  parseCanvasEvent,
  useCanvasEventSocket,
} from "../canvas/hooks/use-canvas-ws";
import type { CanvasNodeData } from "../canvas/lib/types";

function node(id: string): CanvasNodeData {
  return {
    id,
    canvas_id: "canvas-1",
    type: "text",
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    asset_id: null,
    data: { content: id },
    creator_name: "test",
    parent_node_id: null,
    created_at: 1,
    updated_at: 1,
  };
}

/**
 * Race-condition fix: WebSocket events that arrive during the snapshot fetch
 * round-trip must not be lost. The hook subscribes first, buffers every
 * event until `markReady()` is called, then drains the buffer in order
 * before applying live events. These tests pin that contract.
 */

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  url: string;

  static instances: FakeWebSocket[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(event: CanvasEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

let realWs: typeof globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  realWs = globalThis.WebSocket;
  // biome-ignore lint/suspicious/noExplicitAny: stubbing WebSocket for tests
  globalThis.WebSocket = FakeWebSocket as any;
});

afterEach(() => {
  globalThis.WebSocket = realWs;
});

describe("useCanvasEventSocket — race-free fetch + stream", () => {
  it("buffers events received before markReady() and drains them in order", () => {
    const events: CanvasEvent[] = [];
    const { result } = renderHook(() =>
      useCanvasEventSocket("canvas-1", (event) => {
        events.push(event);
      }),
    );

    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.open());

    // Fire three events while the fake "fetch" is still in flight.
    act(() => {
      ws.emit({ type: "node_added", canvasId: "canvas-1", node: node("n1") });
      ws.emit({ type: "node_added", canvasId: "canvas-1", node: node("n2") });
      ws.emit({ type: "node_deleted", canvasId: "canvas-1", nodeId: "n1" });
    });

    // No events delivered yet — they're buffered until the consumer is ready.
    expect(events).toHaveLength(0);

    // Snapshot lands; consumer signals ready.
    act(() => result.current.markReady());

    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe("node_added");
    expect((events[0] as { node: { id: string } }).node.id).toBe("n1");
    expect((events[1] as { node: { id: string } }).node.id).toBe("n2");
    expect(events[2]?.type).toBe("node_deleted");
  });

  it("applies events live after markReady()", () => {
    const events: CanvasEvent[] = [];
    const { result } = renderHook(() =>
      useCanvasEventSocket("canvas-1", (event) => {
        events.push(event);
      }),
    );

    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.open());
    act(() => result.current.markReady());

    act(() => {
      ws.emit({ type: "node_added", canvasId: "canvas-1", node: node("n1") });
    });

    expect(events).toHaveLength(1);
    expect((events[0] as { node: { id: string } }).node.id).toBe("n1");
  });

  it("resetForFetch() returns to buffered mode for a re-fetch", () => {
    const events: CanvasEvent[] = [];
    const { result } = renderHook(() =>
      useCanvasEventSocket("canvas-1", (event) => {
        events.push(event);
      }),
    );

    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.open());
    act(() => result.current.markReady());

    // First batch — live.
    act(() => {
      ws.emit({ type: "node_added", canvasId: "canvas-1", node: node("n1") });
    });
    expect(events).toHaveLength(1);

    // Refetch starts — events should buffer again.
    act(() => result.current.resetForFetch());
    act(() => {
      ws.emit({ type: "node_added", canvasId: "canvas-1", node: node("n2") });
    });
    expect(events).toHaveLength(1);

    // Snapshot applied → drain.
    act(() => result.current.markReady());
    expect(events).toHaveLength(2);
    expect((events[1] as { node: { id: string } }).node.id).toBe("n2");
  });

  it("transitions status to reconnecting on close", () => {
    const { result } = renderHook(() =>
      useCanvasEventSocket("canvas-1", () => {
        // no-op
      }),
    );

    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.open());
    expect(result.current.status).toBe("live");

    act(() => ws.close());
    expect(result.current.status).toBe("reconnecting");
  });

  it("increments the connection generation and buffers recovery events", () => {
    vi.useFakeTimers();
    const events: CanvasEvent[] = [];
    const { result } = renderHook(() =>
      useCanvasEventSocket("canvas-1", (event) => events.push(event)),
    );

    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => result.current.markReady());
    expect(result.current.connectionGeneration).toBe(1);

    act(() => first.close());
    act(() => vi.advanceTimersByTime(1500));
    const replacement = FakeWebSocket.instances[1]!;
    act(() => replacement.open());
    expect(result.current.connectionGeneration).toBe(2);

    // The replacement subscription is live, but recovery has not applied its
    // snapshot yet, so this event must remain buffered.
    act(() => {
      replacement.emit({ type: "node_deleted", canvasId: "canvas-1", nodeId: "offline-node" });
    });
    expect(events).toHaveLength(0);

    // Starting the recovery fetch must not erase an event that won the race.
    act(() => result.current.resetForFetch());
    act(() => result.current.markReady());
    expect(events).toEqual([
      { type: "node_deleted", canvasId: "canvas-1", nodeId: "offline-node" },
    ]);
    vi.useRealTimers();
  });
});

describe("parseCanvasEvent", () => {
  it("rejects incomplete nodes and events for another canvas", () => {
    expect(
      parseCanvasEvent(
        { type: "node_added", canvasId: "canvas-1", node: { id: "blank" } },
        "canvas-1",
      ),
    ).toBeNull();
    expect(
      parseCanvasEvent(
        { type: "node_added", canvasId: "canvas-2", node: node("cross-canvas") },
        "canvas-1",
      ),
    ).toBeNull();
  });

  it("accepts complete node and typed edge events", () => {
    expect(
      parseCanvasEvent({ type: "node_added", canvasId: "canvas-1", node: node("full") }, "canvas-1")
        ?.type,
    ).toBe("node_added");
    expect(
      parseCanvasEvent(
        {
          type: "edge_added",
          canvasId: "canvas-1",
          edge: {
            id: "edge-1",
            sourceId: "a",
            targetId: "b",
            relationship: "references",
            data: null,
            creatorName: "test",
            createdAt: 1,
          },
        },
        "canvas-1",
      )?.type,
    ).toBe("edge_added");
  });
});
