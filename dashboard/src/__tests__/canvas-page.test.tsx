// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CanvasPage with the snapshot hook, the canvas WebSocket and the REST API
 * mocked: canvas list selection and deep links, the empty and error states,
 * creating canvases and notes, WS edge/deletion events, and opening the node
 * inspector on double-click.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasEvent } from "../canvas/hooks/use-canvas-ws";
import type { CanvasData } from "../canvas/lib/types";

const fetchCanvases = vi.fn<() => Promise<CanvasData[]>>();
const snapshot = {
  nodes: [] as Node[],
  loading: false,
  error: null as string | null,
  canvas: null as Partial<CanvasData> | null,
};
const persistNodeData = vi.fn(async () => {});
const deleteNodes = vi.fn();
let canvasEvent: ((event: CanvasEvent) => void) | undefined;
let requestedCanvasId: string | null = null;

vi.mock("../canvas/hooks/use-canvas", () => ({
  fetchCanvases: () => fetchCanvases(),
  useCanvas: (canvasId: string | null) => {
    requestedCanvasId = canvasId;
    const [nodes, setNodes] = useState<Node[]>(snapshot.nodes);
    return {
      canvas: snapshot.canvas,
      nodes,
      setNodes,
      loading: snapshot.loading,
      error: snapshot.error,
      onNodesChange: () => {},
      persistNodePosition: vi.fn(),
      persistNodeSize: vi.fn(),
      persistNodeData,
      deleteNodes,
    };
  },
}));

vi.mock("../canvas/hooks/use-canvas-ws", () => ({
  useCanvasWs: (_id: string | null, _setNodes: unknown, onEvent?: (e: CanvasEvent) => void) => {
    canvasEvent = onEvent;
    return { status: "live", connectionGeneration: 0, markReady() {}, resetForFetch() {} };
  },
}));

const authFetch = vi.fn();
vi.mock("../lib/api", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }));

const { CanvasPage } = await import("../canvas/CanvasPage");

function canvas(id: string, name: string): CanvasData {
  return { id, name } as CanvasData;
}

function canvasParam(): string | null {
  return new URL(window.location.href).searchParams.get("canvas");
}

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/canvas");
  fetchCanvases.mockReset();
  authFetch.mockReset();
  persistNodeData.mockClear();
  snapshot.nodes = [];
  snapshot.loading = false;
  snapshot.error = null;
  snapshot.canvas = null;
  canvasEvent = undefined;
  requestedCanvasId = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CanvasPage", () => {
  it("prefers the feed canvas and writes it into the URL", async () => {
    fetchCanvases.mockResolvedValue([canvas("c1", "notes"), canvas("c2", "feed")]);
    render(<CanvasPage />);
    await waitFor(() => expect(requestedCanvasId).toBe("c2"));
    expect(screen.getByText("MARINA CANVAS")).toBeInTheDocument();
    expect(screen.getByLabelText("Active canvas")).toHaveValue("c2");
    // `requestedCanvasId` is set during render; the URL is written by a passive
    // effect after commit, so a poll can land between the two.
    await waitFor(() => expect(canvasParam()).toBe("c2"));
    expect(screen.getByText("This canvas is empty")).toBeInTheDocument();
  });

  it("honours a deep-linked canvas and switches on selection", async () => {
    window.history.replaceState(null, "", "/canvas?canvas=c1");
    fetchCanvases.mockResolvedValue([canvas("c1", "notes"), canvas("c2", "feed")]);
    render(<CanvasPage />);
    await waitFor(() => expect(requestedCanvasId).toBe("c1"));
    fireEvent.change(screen.getByLabelText("Active canvas"), { target: { value: "c2" } });
    await waitFor(() => expect(requestedCanvasId).toBe("c2"));
    await waitFor(() => expect(canvasParam()).toBe("c2"));
  });

  it("offers to create a first canvas and selects it after creation", async () => {
    fetchCanvases.mockResolvedValueOnce([]);
    render(<CanvasPage />);
    expect(await screen.findByText("No Canvas Selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create your first canvas" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Plans" } });
    authFetch.mockResolvedValueOnce(json({ id: "c9", name: "Plans" }));
    fetchCanvases.mockResolvedValueOnce([canvas("c9", "Plans")]);
    fireEvent.click(screen.getByRole("button", { name: "Create canvas" }));
    expect(await screen.findByText("Created “Plans”.")).toBeInTheDocument();
    await waitFor(() => expect(requestedCanvasId).toBe("c9"));
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/canvases$/);
    expect(JSON.parse(String(init.body))).toMatchObject({ name: "Plans", scope: "global" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Created “Plans”.")).toBeNull();
  });

  it("reports a failed canvas creation", async () => {
    fetchCanvases.mockResolvedValue([]);
    render(<CanvasPage />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Canvas" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Plans" } });
    authFetch.mockResolvedValueOnce(json({ error: "name taken" }, false, 409));
    fireEvent.click(screen.getByRole("button", { name: "Create canvas" }));
    expect((await screen.findAllByText("name taken")).length).toBeGreaterThan(0);
  });

  it("shows a list error with a working retry", async () => {
    fetchCanvases.mockRejectedValueOnce(new Error("offline"));
    render(<CanvasPage />);
    expect(await screen.findByText("Could not load canvases: offline")).toBeInTheDocument();
    fetchCanvases.mockResolvedValueOnce([canvas("c1", "guide")]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(requestedCanvasId).toBe("c1"));
  });

  it("shows the loading and unavailable states from the snapshot hook", async () => {
    fetchCanvases.mockResolvedValue([canvas("c1", "guide")]);
    snapshot.loading = true;
    const { unmount } = render(<CanvasPage />);
    expect(screen.getByText("Loading canvas...")).toBeInTheDocument();
    unmount();
    snapshot.loading = false;
    snapshot.error = "gone";
    render(<CanvasPage />);
    expect(await screen.findByText("Canvas unavailable: gone")).toBeInTheDocument();
  });

  it("adds a note to the selected canvas", async () => {
    fetchCanvases.mockResolvedValue([canvas("c1", "guide")]);
    authFetch.mockResolvedValueOnce(json({}));
    render(<CanvasPage />);
    await waitFor(() => expect(requestedCanvasId).toBe("c1"));
    fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
    expect(await screen.findByText("Added a note to the canvas.")).toBeInTheDocument();
    expect(authFetch.mock.calls[0]?.[0]).toMatch(/\/api\/canvases\/c1\/nodes$/);
    authFetch.mockResolvedValueOnce(json({}, false, 500));
    fireEvent.click(screen.getByRole("button", { name: "+ Note" }));
    expect(await screen.findByText("Request failed (500)")).toBeInTheDocument();
  });

  it("falls back to the next canvas when the selected one is deleted", async () => {
    fetchCanvases.mockResolvedValueOnce([canvas("c1", "feed"), canvas("c2", "guide")]);
    render(<CanvasPage />);
    await waitFor(() => expect(requestedCanvasId).toBe("c1"));
    fetchCanvases.mockResolvedValueOnce([canvas("c2", "guide")]);
    act(() => canvasEvent?.({ type: "canvas_deleted", canvasId: "c1" } as CanvasEvent));
    await waitFor(() => expect(requestedCanvasId).toBe("c2"));
  });

  it("opens the node inspector on double-click and closes it", async () => {
    snapshot.nodes = [
      { id: "n1", position: { x: 0, y: 0 }, data: { label: "Hello node", title: "Hello" } },
    ];
    fetchCanvases.mockResolvedValue([canvas("c1", "feed")]);
    const { container } = render(<CanvasPage />);
    await waitFor(() => expect(requestedCanvasId).toBe("c1"));
    const nodeEl = await waitFor(() => {
      const el = container.querySelector('.react-flow__node[data-id="n1"]');
      if (!el) throw new Error("node not rendered");
      return el;
    });
    fireEvent.doubleClick(nodeEl);
    expect(
      await screen.findByRole("complementary", { name: "Node inspector" }),
    ).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get("node")).toBe("n1");
    fireEvent.click(screen.getByRole("button", { name: "Close node inspector" }));
    // The exit animation is motion's; the navigation state is ours.
    expect(new URL(window.location.href).searchParams.get("node")).toBeNull();
    expect(new URL(window.location.href).searchParams.get("canvas")).toBe("c1");
  });
});
