// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * UnifiedCanvas rendered for real (ReactFlow, overlays, viewer) with the
 * network edges mocked: the dashboard socket, REST snapshots, canvas
 * integration, the chat socket, and the four heavy floating panels (stubbed
 * so the canvas's own wiring is what is under test).
 */

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorldState } from "../hooks/use-world-state";
import { renderWithProviders, resetWorldState } from "./test-utils";

vi.mock("../hooks/use-websocket", () => ({
  useDashboardWebSocket: () => ({ connected: true, wsRef: { current: null } }),
}));

vi.mock("../hooks/use-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/use-api")>()),
  useSystem: () => ({ data: { uptime: 3_720, projectCount: 2 } }),
  useSetupStatus: () => ({ data: { hasLlmKey: false, instanceName: "harbour" } }),
}));

const sent: string[] = [];
vi.mock("../hooks/use-chat-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/use-chat-state")>()),
  ensureChatWs: () => {},
  getChatWs: () => ({
    readyState: 1,
    send: (frame: string) => sent.push((JSON.parse(frame) as { command: string }).command),
  }),
}));

const canvasState = { nodes: [] as Node[] };
vi.mock("../unified/hooks/use-canvas-integration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../unified/hooks/use-canvas-integration")>()),
  useCanvasIntegration: () => ({
    canvasNodes: canvasState.nodes,
    canvasEdges: [],
    canvasList: [],
    activeCanvasId: null,
    loading: false,
    error: null,
    retry: () => {},
    wsStatus: "live",
    onDrop: async () => [],
    removeNode: () => {},
  }),
}));

vi.mock("../unified/hooks/use-memory-map", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../unified/hooks/use-memory-map")>()),
  useMemoryMapLive: () => {},
}));

vi.mock("../unified/panels/CommandBar", () => ({
  CommandBar: forwardRef(function CommandBarStub(
    { visible }: { visible: boolean },
    ref: React.Ref<unknown>,
  ) {
    useImperativeHandle(ref, () => ({
      expand() {},
      collapse() {},
      focus() {},
      addMessage() {},
    }));
    return <div data-testid="command-bar">{visible ? "bar shown" : "bar hidden"}</div>;
  }),
}));
vi.mock("../unified/panels/ContextPanel", () => ({
  ContextPanel: ({
    type,
    id,
    onClose,
  }: {
    type: string | null;
    id: string | null;
    onClose(): void;
  }) =>
    type ? (
      <div data-testid="context-panel">
        {type}:{id}
        <button type="button" onClick={onClose}>
          close context
        </button>
      </div>
    ) : null,
}));
vi.mock("../unified/panels/EntityPanel", () => ({
  EntityPanel: ({
    visible,
    onEntityClick,
  }: {
    visible: boolean;
    onEntityClick(name: string, x?: number, y?: number): void;
  }) =>
    visible ? (
      <button type="button" onClick={() => onEntityClick("Ada", 10, 20)}>
        pick Ada
      </button>
    ) : null,
}));
vi.mock("../unified/panels/WorldNav", () => ({ WorldNav: () => null }));

const { UnifiedCanvas } = await import("../unified/UnifiedCanvas");

function seedWorld() {
  useWorldState.setState({
    worldName: "harbor-world",
    rooms: [
      { id: "zone/lobby", short: "Lobby", district: "zone", exits: { north: "zone/hall" } },
      { id: "zone/hall", short: "Hall", district: "zone", exits: { south: "zone/lobby" } },
    ],
    entities: [
      { id: "e_1", name: "Ada", kind: "agent", room: "zone/lobby", rank: 1 },
      { id: "e_2", name: "Bob", kind: "human", room: "zone/hall", rank: 0 },
    ] as never,
    connections: 3,
  });
}

function nodeEl(container: HTMLElement, id: string): Element {
  const el = container.querySelector(`.react-flow__node[data-id="${id}"]`);
  if (!el) throw new Error(`node ${id} not rendered`);
  return el;
}

beforeEach(() => {
  resetWorldState();
  sent.length = 0;
  localStorage.clear();
  canvasState.nodes = [];
});

describe("UnifiedCanvas", () => {
  it("renders the topbar stats and a room node per world room", async () => {
    seedWorld();
    const { container } = renderWithProviders(<UnifiedCanvas embedded />);
    expect(screen.getByRole("region", { name: "World canvas" })).toBeInTheDocument();
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.getByText("harbour")).toBeInTheDocument();
    expect(screen.getByText("(no LLM — add key in Admin)")).toBeInTheDocument();
    expect(screen.getByText("1h2m")).toBeInTheDocument();
    expect(screen.getByText("proj")).toBeInTheDocument();
    await waitFor(() => nodeEl(container, "zone/lobby"));
    nodeEl(container, "zone/hall");
    expect(screen.getByTestId("command-bar")).toHaveTextContent("bar shown");
  });

  it("opens the context panel for a clicked room and an entity, and closes it", async () => {
    seedWorld();
    const { container } = renderWithProviders(<UnifiedCanvas embedded />);
    const lobby = await waitFor(() => nodeEl(container, "zone/lobby"));
    fireEvent.click(lobby);
    expect(screen.getByTestId("context-panel")).toHaveTextContent("room:zone/lobby");
    fireEvent.click(screen.getByRole("button", { name: "pick Ada" }));
    expect(screen.getByTestId("context-panel")).toHaveTextContent("entity:Ada");
    fireEvent.click(screen.getByRole("button", { name: "close context" }));
    expect(screen.queryByTestId("context-panel")).toBeNull();
  });

  it("opens canvas content in the viewer on double-click", async () => {
    seedWorld();
    canvasState.nodes = [
      {
        id: "canvas-n1",
        type: "text",
        position: { x: 900, y: 900 },
        data: { title: "Harbour plan", body: "Build docks", canvasId: "c1" },
      },
    ];
    const { container } = renderWithProviders(<UnifiedCanvas embedded />);
    const node = await waitFor(() => nodeEl(container, "canvas-n1"));
    fireEvent.doubleClick(node);
    expect(await screen.findByRole("button", { name: /Close/ })).toBeInTheDocument();
    expect(screen.getByText("UNKNOWN viewer -- content will render here")).toBeInTheDocument();
  });

  it("opens an intent node in the intent viewer", async () => {
    canvasState.nodes = [
      {
        id: "canvas-n2",
        type: "text",
        position: { x: 0, y: 0 },
        data: {
          title: "Needs work",
          canvasId: "c1",
          intent: { status: "pending", prompt: "Summarize this" },
        },
      },
    ];
    const { container } = renderWithProviders(<UnifiedCanvas embedded />);
    fireEvent.doubleClick(await waitFor(() => nodeEl(container, "canvas-n2")));
    expect(await screen.findByRole("button", { name: "Claim Intent" })).toBeInTheDocument();
    expect(screen.getAllByText("Summarize this").length).toBeGreaterThan(0);
  });

  it("adds a note to a room from the right-click menu", async () => {
    seedWorld();
    const { container } = renderWithProviders(<UnifiedCanvas embedded />);
    const lobby = await waitFor(() => nodeEl(container, "zone/lobby"));
    fireEvent.contextMenu(lobby, { clientX: 40, clientY: 50 });
    const menu = screen.getByRole("group", { name: "Node actions" });
    expect(within(menu).queryByRole("button", { name: "Open in viewer" })).toBeNull();
    fireEvent.click(within(menu).getByRole("button", { name: "Add note" }));
    const input = within(menu).getByPlaceholderText("Type note...");
    fireEvent.change(input, { target: { value: "check the tide" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sent).toEqual(["note create check the tide @zone/lobby"]);
    expect(screen.queryByRole("group", { name: "Node actions" })).toBeNull();
  });

  it("inspects a room from the right-click menu", async () => {
    seedWorld();
    const { container } = renderWithProviders(<UnifiedCanvas embedded />);
    fireEvent.contextMenu(await waitFor(() => nodeEl(container, "zone/hall")));
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(screen.getByTestId("context-panel")).toHaveTextContent("room:zone/hall");
  });

  it("runs keyboard shortcuts: help, clear view, command bar and layer keys", async () => {
    seedWorld();
    const { container } = renderWithProviders(<UnifiedCanvas embedded />);
    await waitFor(() => nodeEl(container, "zone/lobby"));

    fireEvent.keyDown(document, { key: "?" });
    expect(document.querySelector("dialog.shortcut-dialog")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector("dialog.shortcut-dialog")).toBeNull();

    fireEvent.keyDown(document, { key: " " });
    expect(screen.getByText(/CLEAR VIEW/)).toBeInTheDocument();
    expect(screen.getByTestId("command-bar")).toHaveTextContent("bar hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText(/CLEAR VIEW/)).toBeNull();

    fireEvent.keyDown(document, { key: "/" });
    expect(screen.getByTestId("command-bar")).toHaveTextContent("bar hidden");
    fireEvent.keyDown(document, { key: "/" });
    expect(screen.getByTestId("command-bar")).toHaveTextContent("bar shown");

    // Key 1 hides the World layer: room nodes leave the flow.
    act(() => {
      fireEvent.keyDown(document, { key: "1" });
    });
    await waitFor(() =>
      expect(container.querySelector('.react-flow__node[data-id="zone/lobby"]')).toBeNull(),
    );
    expect(localStorage.getItem("uc:hide-world")).toBe("true");
  });

  it("toggles clear view and the command bar from the topbar, and Reset restores both", () => {
    seedWorld();
    renderWithProviders(<UnifiedCanvas embedded />);
    const clear = screen.getByRole("button", { name: "Clear" });
    fireEvent.click(clear);
    expect(clear).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Toggle command bar (key /)" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(clear).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("command-bar")).toHaveTextContent("bar shown");
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(document.querySelector("dialog.shortcut-dialog")).not.toBeNull();
  });

  it("shows the connecting overlay while offline with no world yet", async () => {
    vi.resetModules();
    vi.doMock("../hooks/use-websocket", () => ({
      useDashboardWebSocket: () => ({ connected: false, wsRef: { current: null } }),
    }));
    const mod = await import("../unified/UnifiedCanvas");
    renderWithProviders(<mod.UnifiedCanvas embedded />);
    expect(screen.getByText("OFFLINE")).toBeInTheDocument();
    vi.doUnmock("../hooks/use-websocket");
  });
});
