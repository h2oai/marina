// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CanvasEvent, parseCanvasEvent } from "../canvas/hooks/use-canvas-ws";
import { authFetch } from "../lib/api";
import { useCanvasIntegration } from "../unified/hooks/use-canvas-integration";

vi.mock("../lib/api", () => ({ authFetch: vi.fn() }));

/**
 * `canvas delete` lifecycle: the backend broadcasts `canvas_deleted` on the
 * deleted canvas's socket. Consumers must clear the dead board, refresh the
 * canvas list, and reselect via the shared selectInitialCanvas fallback —
 * otherwise viewers keep a deleted board forever (the list is fetched once).
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
  vi.mocked(authFetch).mockReset();
});

afterEach(() => {
  globalThis.WebSocket = realWs;
});

describe("parseCanvasEvent — canvas_deleted", () => {
  it("accepts canvas_deleted for the subscribed canvas only", () => {
    expect(parseCanvasEvent({ type: "canvas_deleted", canvasId: "canvas-1" }, "canvas-1")).toEqual({
      type: "canvas_deleted",
      canvasId: "canvas-1",
    });
    expect(
      parseCanvasEvent({ type: "canvas_deleted", canvasId: "canvas-2" }, "canvas-1"),
    ).toBeNull();
  });
});

describe("useCanvasIntegration — canvas_deleted lifecycle", () => {
  const doomed = { id: "doomed-id", name: "workspace", nodes: [], edges: [] };
  const feed = { id: "feed-id", name: "feed", nodes: [], edges: [] };

  // Every response waits a macrotask so React commits pending effects (the
  // WS subscription reset) before the snapshot's markReady fires — mirroring
  // a real network round-trip, which always loses that race.
  async function jsonResponse(data: unknown): Promise<Response> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, json: async () => data } as Response;
  }

  it("clears the deleted canvas, refreshes the list, and reselects", async () => {
    let deleted = false;
    const listRequests: string[] = [];
    vi.mocked(authFetch).mockImplementation(async (url: string) => {
      if (url.endsWith("/api/canvases")) {
        listRequests.push(url);
        return jsonResponse(deleted ? [feed] : [doomed, feed]);
      }
      if (url.endsWith("/api/canvases/doomed-id")) {
        if (deleted) return { ok: false, status: 404, json: async () => ({}) } as Response;
        return jsonResponse(doomed);
      }
      if (url.endsWith("/api/canvases/feed-id")) return jsonResponse(feed);
      throw new Error(`unexpected request: ${url}`);
    });

    // Mirrors UnifiedCanvas's wiring: the selector state owner clears a
    // stale selection when the hook reports the active canvas was deleted.
    const deletedCallbacks: string[] = [];
    const { result } = renderHook(() => {
      const [selected, setSelected] = useState<string | null>("doomed-id");
      const onCanvasDeleted = useCallback((deletedId: string) => {
        deletedCallbacks.push(deletedId);
        setSelected((current) => (current === deletedId ? null : current));
      }, []);
      return useCanvasIntegration({}, ["room-1"], {}, selected, onCanvasDeleted);
    });

    // Deep-linked selection wins the initial pick.
    await waitFor(() => expect(result.current.activeCanvasId).toBe("doomed-id"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canvasList.map((c) => c.id)).toEqual(["doomed-id", "feed-id"]);

    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    act(() => ws.open());

    // The subscribed canvas is deleted server-side.
    deleted = true;
    act(() => {
      ws.emit({ type: "canvas_deleted", canvasId: "doomed-id" });
    });

    expect(deletedCallbacks).toEqual(["doomed-id"]);
    // List refreshed, dead board dropped, feed reselected via selectInitialCanvas.
    await waitFor(() => expect(result.current.activeCanvasId).toBe("feed-id"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canvasList.map((c) => c.id)).toEqual(["feed-id"]);
    expect(result.current.error).toBeNull();
    expect(listRequests.length).toBeGreaterThanOrEqual(2);
    // A fresh socket subscription targets the surviving canvas.
    expect(FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.url).toContain(
      "canvas=feed-id",
    );
  });

  it("clears the selection entirely when no canvas survives", async () => {
    let deleted = false;
    vi.mocked(authFetch).mockImplementation(async (url: string) => {
      if (url.endsWith("/api/canvases")) return jsonResponse(deleted ? [] : [doomed]);
      if (url.endsWith("/api/canvases/doomed-id")) return jsonResponse(doomed);
      throw new Error(`unexpected request: ${url}`);
    });

    const { result } = renderHook(() => {
      const [selected, setSelected] = useState<string | null>("doomed-id");
      const onCanvasDeleted = useCallback((deletedId: string) => {
        setSelected((current) => (current === deletedId ? null : current));
      }, []);
      return useCanvasIntegration({}, ["room-1"], {}, selected, onCanvasDeleted);
    });

    await waitFor(() => expect(result.current.activeCanvasId).toBe("doomed-id"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    act(() => ws.open());
    deleted = true;
    act(() => {
      ws.emit({ type: "canvas_deleted", canvasId: "doomed-id" });
    });

    await waitFor(() => expect(result.current.activeCanvasId).toBeNull());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canvasList).toEqual([]);
    expect(result.current.canvasNodes).toEqual([]);
  });
});
