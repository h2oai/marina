// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGraphSnapshot, useGraphState } from "../hooks/use-graph-state";
import type { GraphSnapshot } from "../lib/types";

const originalFetch = globalThis.fetch;

function mockFetch(impl: () => Promise<Response> | Response) {
  const fn = vi.fn(impl);
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

const snapshot: GraphSnapshot = {
  notes: [
    {
      id: 7,
      entityName: "alice",
      content: "a note",
      importance: 5,
      noteType: "observation",
      createdAt: 1,
      lastAccessed: 1,
      roomId: null,
      poolId: null,
    },
  ],
  links: [],
} as GraphSnapshot;

beforeEach(() => {
  useGraphState.getState().reset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("loadGraphSnapshot — error state", () => {
  it("starts with no error and no fetch timestamp", () => {
    const s = useGraphState.getState();
    expect(s.error).toBeNull();
    expect(s.lastFetchAt).toBeNull();
    expect(s.snapshotLoaded).toBe(false);
  });

  it("records an HTTP error on a non-OK response and leaves the graph unloaded", async () => {
    mockFetch(() => new Response("denied", { status: 401, statusText: "Unauthorized" }));
    await loadGraphSnapshot();
    const s = useGraphState.getState();
    expect(s.error).toBe("HTTP 401 Unauthorized");
    expect(s.lastFetchAt).toEqual(expect.any(Number));
    expect(s.snapshotLoaded).toBe(false);
    expect(s.notes.size).toBe(0);
  });

  it("records the thrown message when fetch rejects instead of propagating it", async () => {
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(loadGraphSnapshot()).resolves.toBeUndefined();
    expect(useGraphState.getState().error).toBe("Failed to fetch");
  });

  it("clears a prior error on the next successful load", async () => {
    useGraphState.getState().setError("HTTP 500");
    mockFetch(() => new Response(JSON.stringify(snapshot), { status: 200 }));
    await loadGraphSnapshot(10);
    const s = useGraphState.getState();
    expect(s.error).toBeNull();
    expect(s.snapshotLoaded).toBe(true);
    expect(s.notes.get(7)?.content).toBe("a note");
    expect(s.lastFetchAt).toEqual(expect.any(Number));
  });

  it("passes the limit through to /api/graph", async () => {
    const fn = mockFetch(() => new Response(JSON.stringify({ notes: [], links: [] })));
    await loadGraphSnapshot(99);
    expect(fn).toHaveBeenCalledWith("/api/graph?limit=99", { credentials: "same-origin" });
  });

  it("reset() clears the error and timestamp", () => {
    useGraphState.getState().setError("boom");
    useGraphState.getState().reset();
    expect(useGraphState.getState().error).toBeNull();
    expect(useGraphState.getState().lastFetchAt).toBeNull();
  });
});
