// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * ContextPanel inspectors against REST fixtures: room (API and WebSocket
 * fallback), entity (detail, agent status, compass, knowledge graph, core
 * memory), note, canvas node and memory node, plus their navigation callbacks.
 */

import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorldState } from "../hooks/use-world-state";
import { ContextPanel, type ContextType } from "../unified/panels/ContextPanel";
import { CONTEXT_PANEL_RESPONSES } from "./context-panel-fixtures";
import { renderWithProviders, resetWorldState } from "./test-utils";

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  fetchApi: async (path: string) => {
    if (path in CONTEXT_PANEL_RESPONSES) return CONTEXT_PANEL_RESPONSES[path];
    if (path.startsWith("/api/media-jobs")) return [];
    throw new Error(`API error: 404 ${path}`);
  },
}));

const onClose = vi.fn();
const onEntityClick = vi.fn();
const onRoomClick = vi.fn();
const onVisitEntityCanvas = vi.fn();
const onMemoryNodeClick = vi.fn();
const sendCommand = vi.fn();

function show(type: ContextType | null, id: string | null) {
  return renderWithProviders(
    <ContextPanel
      type={type}
      id={id}
      onClose={onClose}
      onEntityClick={onEntityClick}
      onRoomClick={onRoomClick}
      onVisitEntityCanvas={onVisitEntityCanvas}
      onMemoryNodeClick={onMemoryNodeClick}
      sendCommand={sendCommand}
      memoryGraph={
        {
          nodes: [{ id: "helper:r1", kind: "helper", label: "r1" }],
          edges: [],
          truncated: false,
        } as never
      }
    />,
  );
}

beforeEach(() => {
  resetWorldState();
  for (const fn of [
    onClose,
    onEntityClick,
    onRoomClick,
    onVisitEntityCanvas,
    onMemoryNodeClick,
    sendCommand,
  ]) {
    fn.mockClear();
  }
  useWorldState.setState({
    rooms: [{ id: "zone/ws-only", short: "WS Room", district: "zone", exits: {} }],
    entities: [
      {
        id: "e_1",
        name: "Ada",
        kind: "agent",
        room: "zone/lobby",
        rank: 2,
        agentStatus: {
          state: "running",
          model: "m",
          role: "builder",
          focus: null,
          uptime: 3700,
          toolCalls: 4,
          errors: 0,
          errorReason: null,
          supports: { tools: true },
        },
      },
    ] as never,
  });
});

describe("ContextPanel", () => {
  it("renders nothing without a target", () => {
    const { container } = show(null, null);
    expect(container).toBeEmptyDOMElement();
  });

  it("inspects a room and navigates to its occupants and exits", async () => {
    show("room", "zone/lobby");
    expect(screen.getByText("Room Inspector")).toBeInTheDocument();
    expect(await screen.findByText("A quiet entrance hall.")).toBeInTheDocument();
    expect(screen.getByText("Entities (2)")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Bob"));
    expect(onEntityClick).toHaveBeenCalledWith("Bob");
    fireEvent.click(screen.getByText("zone/hall"));
    expect(onRoomClick).toHaveBeenCalledWith("zone/hall");
    fireEvent.click(screen.getByRole("button", { name: "Close context panel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("falls back to the WebSocket snapshot when the room API fails", async () => {
    show("room", "zone/ws-only");
    expect(await screen.findByText("WS Room")).toBeInTheDocument();
  });

  it("inspects an agent with status, compass, core memory and knowledge graph", async () => {
    show("entity", "Ada");
    expect(screen.getByText("Entity Inspector")).toBeInTheDocument();
    expect(await screen.findByText("1h 1m")).toBeInTheDocument();
    expect(await screen.findByText("Lay pilings", { exact: false })).toBeInTheDocument();
    expect(await screen.findByText("Knowledge Graph (1)")).toBeInTheDocument();
    expect(screen.getAllByText("Build docks").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Go to room →"));
    expect(onRoomClick).toHaveBeenCalledWith("zone/lobby");
  });

  it("reports an unknown entity when its API fails", async () => {
    show("entity", "Ghost");
    expect(await screen.findByText("API unavailable")).toBeInTheDocument();
  });

  it("inspects a note and reports a missing one", async () => {
    const { unmount } = show("note", "7");
    expect(await screen.findByText("Tides peak at noon")).toBeInTheDocument();
    expect(screen.getByText(/verified · confidence 0.90/)).toBeInTheDocument();
    unmount();
    show("note", "99");
    expect(await screen.findByText("Note #99 not found.")).toBeInTheDocument();
  });

  it("inspects canvas and memory nodes", () => {
    const { unmount } = show("canvas", "canvas-n1");
    expect(screen.getByText("canvas-n1")).toBeInTheDocument();
    unmount();
    show("memory", "helper:r1");
    expect(screen.getByText("Memory Inspector")).toBeInTheDocument();
    expect(screen.getByText("No jobs worked yet.")).toBeInTheDocument();
  });
});
