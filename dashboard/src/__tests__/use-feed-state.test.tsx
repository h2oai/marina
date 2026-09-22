// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NarrativePlayback } from "../components/NarrativePlayback";
import { loadFeedSnapshot, useFeedState } from "../hooks/use-feed-state";
import type { FeedEvent } from "../lib/types";

const originalFetch = globalThis.fetch;

function mockFetch(impl: () => Promise<Response> | Response) {
  const fn = vi.fn(impl);
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const sampleEvent: FeedEvent = {
  id: 1,
  kind: "task_approved",
  entity: "alice",
  ref: "task:1",
  summary: "alice approved task 1",
  payload: null,
  timestamp: Date.now(),
};

beforeEach(() => {
  useFeedState.getState().reset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("loadFeedSnapshot — error state", () => {
  it("starts with no error and no fetch timestamp", () => {
    const s = useFeedState.getState();
    expect(s.error).toBeNull();
    expect(s.lastFetchAt).toBeNull();
    expect(s.snapshotLoaded).toBe(false);
  });

  it("records an HTTP error on a non-OK response and does not mark the snapshot loaded", async () => {
    mockFetch(() => new Response("nope", { status: 503, statusText: "Service Unavailable" }));
    await loadFeedSnapshot();
    const s = useFeedState.getState();
    expect(s.error).toBe("HTTP 503 Service Unavailable");
    expect(s.lastFetchAt).toEqual(expect.any(Number));
    expect(s.snapshotLoaded).toBe(false);
    expect(s.events).toEqual([]);
  });

  it("records the thrown message when fetch rejects instead of propagating it", async () => {
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(loadFeedSnapshot()).resolves.toBeUndefined();
    expect(useFeedState.getState().error).toBe("Failed to fetch");
  });

  it("records a parse failure when the body is not JSON", async () => {
    mockFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    await loadFeedSnapshot();
    expect(useFeedState.getState().error).toEqual(expect.any(String));
    expect(useFeedState.getState().snapshotLoaded).toBe(false);
  });

  it("clears a prior error on the next successful load", async () => {
    useFeedState.getState().setError("HTTP 500");
    mockFetch(() => jsonResponse([sampleEvent]));
    await loadFeedSnapshot(50);
    const s = useFeedState.getState();
    expect(s.error).toBeNull();
    expect(s.snapshotLoaded).toBe(true);
    expect(s.events).toHaveLength(1);
    expect(s.lastFetchAt).toEqual(expect.any(Number));
  });

  it("passes the limit through to /api/feed", async () => {
    const fn = mockFetch(() => jsonResponse([]));
    await loadFeedSnapshot(42);
    expect(fn).toHaveBeenCalledWith("/api/feed?limit=42", { credentials: "same-origin" });
  });

  it("reset() clears the error and timestamp", () => {
    useFeedState.getState().setError("boom");
    useFeedState.getState().reset();
    expect(useFeedState.getState().error).toBeNull();
    expect(useFeedState.getState().lastFetchAt).toBeNull();
  });
});

describe("NarrativePlayback — feed fetch error", () => {
  it("shows the error with a retry button when the feed is empty and errored", async () => {
    useFeedState.getState().setError("HTTP 502 Bad Gateway");
    render(<NarrativePlayback />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load feed: HTTP 502 Bad Gateway");

    const fn = mockFetch(() => jsonResponse([sampleEvent]));
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(fn).toHaveBeenCalledTimes(1);
    // The retry re-runs loadFeedSnapshot, which clears the error on success.
    await vi.waitFor(() => expect(useFeedState.getState().error).toBeNull());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("alice approved task 1")).toBeInTheDocument();
  });

  it("does not show the notice when there is no error", () => {
    render(<NarrativePlayback />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Playback will appear once feed events arrive.")).toBeInTheDocument();
  });

  it("prefers live events over a stale error once WS events have arrived", () => {
    useFeedState.getState().setError("HTTP 500");
    useFeedState.getState().applyEvent({
      type: "feed_event",
      kind: "note_created",
      summary: "a live note",
      timestamp: Date.now(),
    } as never);
    render(<NarrativePlayback />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("a live note")).toBeInTheDocument();
  });
});
