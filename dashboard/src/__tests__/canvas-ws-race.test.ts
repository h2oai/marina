// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CanvasEvent, useCanvasEventSocket } from "../canvas/hooks/use-canvas-ws";

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
      ws.emit({ type: "node_added", canvasId: "canvas-1", node: { id: "n1" } as never });
      ws.emit({ type: "node_added", canvasId: "canvas-1", node: { id: "n2" } as never });
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
      ws.emit({ type: "node_added", canvasId: "canvas-1", node: { id: "n1" } as never });
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
      ws.emit({ type: "node_added", canvasId: "canvas-1", node: { id: "n1" } as never });
    });
    expect(events).toHaveLength(1);

    // Refetch starts — events should buffer again.
    act(() => result.current.resetForFetch());
    act(() => {
      ws.emit({ type: "node_added", canvasId: "canvas-1", node: { id: "n2" } as never });
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
});
