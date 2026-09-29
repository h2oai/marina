// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * RoomNode: level-of-detail switching on zoom, entity and room action
 * controls, the centre count (entities, then tasks), and the in-room
 * message pill.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { type NodeProps, ReactFlowProvider } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useZoom } from "../unified/hooks/use-zoom";
import { RoomNode, type RoomNodeData } from "../unified/nodes/RoomNode";

function room(overrides: Partial<RoomNodeData> = {}): RoomNodeData {
  return {
    id: "zone/lobby",
    short: "Lobby",
    district: "zone",
    exits: { north: "zone/hall", east: "zone/yard" },
    throughput: 10,
    entities: [
      { name: "Ada", kind: "agent", state: "idle" },
      { name: "Bob", kind: "human", state: "thinking" },
    ],
    ...overrides,
  };
}

function show(data: RoomNodeData) {
  return render(
    <ReactFlowProvider>
      <RoomNode {...({ id: data.id, data } as unknown as NodeProps)} />
    </ReactFlowProvider>,
  );
}

beforeEach(() => {
  useZoom.setState({ zoom: 1 });
});

describe("RoomNode", () => {
  it("renders the minimal dot at very low zoom", () => {
    useZoom.setState({ zoom: 0.05 });
    const onEntityClick = vi.fn();
    const { container } = show(room({ onEntityClick }));
    expect(container.querySelector("title")?.textContent).toBe("Lobby");
    expect(screen.getByText("LOBBY")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspect Ada" })).toBeNull();
  });

  it("truncates long names on the dot", () => {
    useZoom.setState({ zoom: 0.05 });
    show(room({ short: "An Exceptionally Long Room" }));
    expect(screen.getByText("An Exceptio…")).toBeInTheDocument();
  });

  it("exposes entity and room actions at detail zoom", () => {
    const onEntityClick = vi.fn();
    const onRoomAction = vi.fn();
    show(room({ onEntityClick, onRoomAction }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect Ada" }), {
      detail: 1,
      clientX: 5,
      clientY: 6,
    });
    expect(onEntityClick).toHaveBeenCalledWith("Ada", 5, 6);
    fireEvent.click(screen.getByRole("button", { name: "Actions for zone/lobby" }), {
      detail: 1,
      clientX: 7,
      clientY: 8,
    });
    expect(onRoomAction).toHaveBeenCalledWith("zone/lobby", 7, 8);
    expect(screen.getByText("HERE")).toBeInTheDocument();
  });

  it("hides per-entity controls when zoomed out, keeping the room action", () => {
    useZoom.setState({ zoom: 0.3 });
    const onEntityClick = vi.fn();
    show(room({ onEntityClick, onRoomAction: vi.fn() }));
    expect(screen.queryByRole("button", { name: "Inspect Ada" })).toBeNull();
    expect(screen.getByRole("button", { name: "Actions for zone/lobby" })).toBeInTheDocument();
  });

  it("shows the task count in an empty room", () => {
    show(room({ entities: [], taskCount: 4 }));
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("labels a single occupant as ENTITY", () => {
    show(room({ entities: [{ name: "Ada", kind: "agent", state: "idle" }] }));
    expect(screen.getByText("ENTITY")).toBeInTheDocument();
  });

  it("floats a fresh in-room message and drops a stale one", () => {
    const { unmount } = show(
      room({
        latestMessage: { kind: "emote", sender: "Ada", body: "waves", timestamp: Date.now() },
      }),
    );
    expect(screen.getByTestId("room-message-pill")).toHaveTextContent("Ada *waves");
    unmount();
    show(room({ latestMessage: { kind: "say", sender: "Ada", body: "old", timestamp: 0 } }));
    expect(screen.queryByTestId("room-message-pill")).toBeNull();
  });
});
