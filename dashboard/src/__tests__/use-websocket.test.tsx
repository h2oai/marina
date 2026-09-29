// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEntityActivity } from "../hooks/use-entity-activity";
import { useFeedState } from "../hooks/use-feed-state";
import { useGraphState } from "../hooks/use-graph-state";
import { useDashboardWebSocket } from "../hooks/use-websocket";
import { useWorldState } from "../hooks/use-world-state";
import {
  HIDDEN_FLUSH_MS,
  MAX_PENDING_EVENTS,
  pushBounded,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  reconnectDelay,
} from "../hooks/ws-buffer";
import type { DashboardEvent } from "../lib/types";

vi.mock("../hooks/use-graph-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/use-graph-state")>();
  return { ...actual, loadGraphSnapshot: vi.fn(async () => {}) };
});
vi.mock("../hooks/use-feed-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/use-feed-state")>();
  return { ...actual, loadFeedSnapshot: vi.fn(async () => {}) };
});

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  emit(event: DashboardEvent) {
    this.onmessage?.({ data: JSON.stringify({ type: "event", data: event }) });
  }
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

describe("ws-buffer helpers", () => {
  it("pushBounded drops the oldest entries past the cap and counts them", () => {
    const buf = [1, 2, 3];
    expect(pushBounded(buf, 4, 3)).toBe(1);
    expect(buf).toEqual([2, 3, 4]);
    expect(pushBounded(buf, 5, 5)).toBe(0);
    expect(buf).toEqual([2, 3, 4, 5]);
  });

  it("reconnectDelay backs off exponentially with jitter and a cap", () => {
    const lo = () => 0;
    const hi = () => 1;
    expect(reconnectDelay(0, lo)).toBe(RECONNECT_BASE_MS / 2);
    expect(reconnectDelay(0, hi)).toBe(RECONNECT_BASE_MS);
    expect(reconnectDelay(3, hi)).toBe(RECONNECT_BASE_MS * 8);
    expect(reconnectDelay(50, hi)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelay(50, lo)).toBe(RECONNECT_MAX_MS / 2);
    for (let a = 0; a < 20; a++) {
      const d = reconnectDelay(a);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(RECONNECT_MAX_MS);
    }
  });
});

describe("useDashboardWebSocket", () => {
  const pushEvents = vi.fn();
  const applyActivity = vi.fn();
  const original = {
    world: useWorldState.getState().pushEvents,
    activity: useEntityActivity.getState().applyEvent,
    graph: useGraphState.getState().applyEvent,
    feed: useFeedState.getState().applyEvent,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    pushEvents.mockReset();
    applyActivity.mockReset();
    useWorldState.setState({ pushEvents });
    useEntityActivity.setState({ applyEvent: applyActivity });
    useGraphState.setState({ applyEvent: vi.fn() });
    useFeedState.setState({ applyEvent: vi.fn() });
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useWorldState.setState({ pushEvents: original.world });
    useEntityActivity.setState({ applyEvent: original.activity });
    useGraphState.setState({ applyEvent: original.graph });
    useFeedState.setState({ applyEvent: original.feed });
    setHidden(false);
  });

  it("flushes on a timer while the tab is hidden (rAF is paused)", () => {
    const raf = vi.spyOn(globalThis, "requestAnimationFrame");
    setHidden(true);
    renderHook(() => useDashboardWebSocket());
    const ws = FakeSocket.instances[0];
    act(() => ws.open());
    ws.emit({ type: "entity_moved" } as DashboardEvent);
    expect(raf).not.toHaveBeenCalled();
    expect(pushEvents).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    });
    expect(pushEvents).toHaveBeenCalledTimes(1);
    expect(pushEvents.mock.calls[0][0]).toHaveLength(1);
    raf.mockRestore();
  });

  it("bounds the pending buffer, dropping the oldest events and counting drops", () => {
    setHidden(true);
    const { result } = renderHook(() => useDashboardWebSocket());
    const ws = FakeSocket.instances[0];
    act(() => ws.open());
    const total = MAX_PENDING_EVENTS + 25;
    for (let i = 0; i < total; i++) {
      ws.emit({ type: "entity_moved", seq: i } as unknown as DashboardEvent);
    }
    act(() => {
      vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    });
    const flushed = pushEvents.mock.calls[0][0] as Array<{ seq: number }>;
    expect(flushed).toHaveLength(MAX_PENDING_EVENTS);
    expect(flushed[0].seq).toBe(25);
    expect(flushed.at(-1)?.seq).toBe(total - 1);
    expect(result.current.droppedEvents()).toBe(25);
  });

  it("keeps per-token deltas out of the event feed but delivers them to activity", () => {
    renderHook(() => useDashboardWebSocket());
    const ws = FakeSocket.instances[0];
    act(() => ws.open());
    ws.emit({ type: "agent_text_delta" } as DashboardEvent);
    act(() => {
      vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    });
    expect(pushEvents).not.toHaveBeenCalled();
    expect(applyActivity).toHaveBeenCalledTimes(1);
  });

  it("reconnects with growing backoff and resets after a successful open", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { result } = renderHook(() => useDashboardWebSocket());
    act(() => FakeSocket.instances[0].close());
    expect(result.current.connected).toBe(false);

    // attempt 0 → base delay
    act(() => {
      vi.advanceTimersByTime(RECONNECT_BASE_MS - 1);
    });
    expect(FakeSocket.instances).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeSocket.instances).toHaveLength(2);

    // attempt 1 → doubled
    act(() => FakeSocket.instances[1].close());
    act(() => {
      vi.advanceTimersByTime(RECONNECT_BASE_MS * 2 - 1);
    });
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeSocket.instances).toHaveLength(3);

    // a successful open resets the backoff
    act(() => FakeSocket.instances[2].open());
    expect(result.current.connected).toBe(true);
    act(() => FakeSocket.instances[2].close());
    act(() => {
      vi.advanceTimersByTime(RECONNECT_BASE_MS);
    });
    expect(FakeSocket.instances).toHaveLength(4);
    vi.mocked(Math.random).mockRestore();
  });

  it("stops reconnecting after unmount", () => {
    const { unmount } = renderHook(() => useDashboardWebSocket());
    unmount();
    act(() => {
      vi.advanceTimersByTime(RECONNECT_MAX_MS * 2);
    });
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
