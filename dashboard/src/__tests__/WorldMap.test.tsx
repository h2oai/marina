// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { fitViewBox, legibleFontSize, WorldMap } from "../components/WorldMap";
import { useWorldState } from "../hooks/use-world-state";
import type { WorldData } from "../lib/types";
import { renderWithProviders, resetWorldState } from "./test-utils";

beforeEach(() => {
  resetWorldState();
});

const SAMPLE_WORLD_DATA: WorldData = {
  worldName: "test-world",
  startRoom: "zone/lobby",
  rooms: [
    {
      id: "zone/lobby",
      short: "The Lobby",
      district: "zone",
      exits: { north: "zone/hall" },
      entityCount: 2,
    },
    {
      id: "zone/hall",
      short: "Grand Hall",
      district: "zone",
      exits: { south: "zone/lobby" },
      entityCount: 0,
    },
  ],
  entities: [
    { id: "e_1", name: "Alice", kind: "agent", room: "zone/lobby", rank: 5 },
    { id: "e_2", name: "Bob", kind: "npc", room: "zone/lobby", rank: 1 },
  ],
};

describe("WorldMap", () => {
  it("exposes independent native room and entity controls", () => {
    useWorldState.setState({ entities: SAMPLE_WORLD_DATA.entities });
    renderWithProviders(<WorldMap worldData={SAMPLE_WORLD_DATA} />);
    const room = screen.getByRole("button", { name: "Inspect room The Lobby" });
    expect(room.tagName).toBe("BUTTON");
    fireEvent.click(room);
    expect(useWorldState.getState().selectedRoom).toBe("zone/lobby");
    const entity = screen.getByRole("button", { name: "Inspect Alice" });
    fireEvent.click(entity);
    expect(useWorldState.getState().selectedEntity).toBe("Alice");
  });

  it("labels a supervised resident with its vendor and rings it with its presence", () => {
    useWorldState.setState({
      entities: [
        {
          id: "e_1",
          name: "Wren",
          kind: "agent",
          room: "zone/lobby",
          vendor: "claude",
          presence: "needs_you",
        },
        { id: "e_2", name: "Bob", kind: "npc", room: "zone/lobby" },
      ],
    });
    renderWithProviders(<WorldMap worldData={SAMPLE_WORLD_DATA} />);
    expect(screen.getAllByTestId("map-resident-label").map((n) => n.textContent)).toEqual([
      "Wren [claude]",
    ]);
    expect(screen.getAllByTestId("map-presence-ring")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Inspect Wren [claude], needs you" })).toBeVisible();
  });

  it("floats a content-free thread mark with reply depth for each new message envelope", () => {
    useWorldState.setState({
      entities: [
        { id: "e_1", name: "Wren", kind: "agent", room: "zone/lobby", vendor: "claude" },
        { id: "e_3", name: "Swift", kind: "agent", room: "zone/lobby", vendor: "codex" },
      ],
      eventFeed: [],
    });
    renderWithProviders(<WorldMap worldData={SAMPLE_WORLD_DATA} />);
    act(() =>
      useWorldState.setState({
        eventFeed: [
          {
            type: "tell_sent",
            from: "Swift",
            to: "Wren",
            depth: 1,
            messageRef: "tell:2",
            timestamp: 20,
          },
          {
            type: "tell_sent",
            from: "Wren",
            to: "Swift",
            depth: 0,
            messageRef: "tell:1",
            timestamp: 10,
          },
        ],
      }),
    );
    // Newest on top of the room's stack.
    expect(screen.getAllByTestId("map-thread-mark").map((n) => n.textContent)).toEqual([
      "Swift → Wren ↳1",
      "Wren → Swift",
    ]);
  });

  it("stacks a busy room's thread marks: three visible, the rest as +N, click opens the room", () => {
    useWorldState.setState({
      entities: [
        { id: "e_1", name: "Wren", kind: "agent", room: "zone/lobby", vendor: "claude" },
        { id: "e_3", name: "Swift", kind: "agent", room: "zone/lobby", vendor: "codex" },
      ],
      eventFeed: [],
      selectedRoom: null,
    });
    renderWithProviders(<WorldMap worldData={SAMPLE_WORLD_DATA} />);
    const feed = Array.from({ length: 6 }, (_, i) => ({
      type: "tell_sent" as const,
      from: i % 2 ? "Swift" : "Wren",
      to: i % 2 ? "Wren" : "Swift",
      depth: i,
      messageRef: `tell:${i + 1}`,
      timestamp: 10 + i,
    })).reverse();
    act(() => useWorldState.setState({ eventFeed: feed }));
    expect(screen.getAllByTestId("map-thread-mark").map((n) => n.textContent)).toEqual([
      "Swift → Wren ↳5",
      "Wren → Swift ↳4",
      "Swift → Wren ↳3",
    ]);
    const stacks = screen.getAllByTestId("map-thread-stack");
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.textContent).toContain("+3 more");
    act(() => {
      stacks[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useWorldState.getState().selectedRoom).toBe("zone/lobby");
  });

  it("renders without crashing with no data", () => {
    const { container } = renderWithProviders(<WorldMap />);
    expect(container).toBeTruthy();
  });

  it("renders the World Map panel title", () => {
    renderWithProviders(<WorldMap />);
    expect(screen.getByText("World topology + 30s activity")).toBeInTheDocument();
  });

  it("renders with sample world data", () => {
    renderWithProviders(<WorldMap worldData={SAMPLE_WORLD_DATA} />);
    // When worldData has a worldName, the title includes it
    expect(screen.getByLabelText("World map")).toBeInTheDocument();
  });

  it("renders with world state populated from store", () => {
    useWorldState.setState({
      worldName: "test-world",
      startRoom: "zone/lobby",
      rooms: [
        { id: "zone/lobby", short: "The Lobby", district: "zone", exits: { north: "zone/hall" } },
      ],
      roomPopulations: { "zone/lobby": 3 },
    });

    renderWithProviders(<WorldMap worldData={SAMPLE_WORLD_DATA} />);
    // The SVG map should be present
    expect(screen.getByLabelText("World map")).toBeInTheDocument();
  });

  it("handles missing population data gracefully", () => {
    // Provide world data but leave roomPopulations empty in store
    useWorldState.setState({
      roomPopulations: {},
    });

    const { container } = renderWithProviders(<WorldMap worldData={SAMPLE_WORLD_DATA} />);
    // Should render without throwing even with no population data
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("exposes a reset-view control that restores the rooms' fitted view", () => {
    renderWithProviders(<WorldMap worldData={SAMPLE_WORLD_DATA} />);
    const svg = screen.getByLabelText("World map");
    // The starting view frames the rooms (not the fixed default canvas).
    const defaultViewBox = svg.getAttribute("viewBox");
    expect(defaultViewBox).not.toBe("50 10 900 730");

    // Zoom out via the wheel so the viewport leaves its default.
    fireEvent.wheel(svg, { deltaY: 100 });
    expect(svg.getAttribute("viewBox")).not.toBe(defaultViewBox);

    // The reset button restores the default viewport.
    fireEvent.click(screen.getByRole("button", { name: "Reset map view" }));
    expect(svg.getAttribute("viewBox")).toBe(defaultViewBox);
  });

  it("offers independently toggleable activity, alert, and presence layers", () => {
    renderWithProviders(<WorldMap worldData={SAMPLE_WORLD_DATA} />);
    const heat = screen.getByRole("button", { name: "Heat" });
    const alerts = screen.getByRole("button", { name: "Alerts" });
    const presence = screen.getByRole("button", { name: "Presence" });
    expect(heat).toHaveAttribute("aria-pressed", "true");
    expect(alerts).toHaveAttribute("aria-pressed", "true");
    expect(presence).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(heat);
    expect(heat).toHaveAttribute("aria-pressed", "false");
  });
});

describe("legibleFontSize", () => {
  it("keeps the design size when it is already readable", () => {
    expect(legibleFontSize(9, 0.5)).toBe(9);
  });

  it("grows text so it renders at least the minimum on-screen size", () => {
    // 900 viewBox units across 600 px: 1.5 units per pixel, 11 px minimum.
    expect(legibleFontSize(5.5, 1.5)).toBeCloseTo(16.5);
    expect(legibleFontSize(7.5, 1.5, 12)).toBeCloseTo(18);
  });

  it("falls back to the design size without a measured scale", () => {
    expect(legibleFontSize(6.5, 0)).toBe(6.5);
    expect(legibleFontSize(6.5, Number.NaN)).toBe(6.5);
  });
});

describe("fitViewBox", () => {
  it("frames every room with padding at the default aspect ratio", () => {
    const vb = fitViewBox([
      { x: 300, y: 300 },
      { x: 500, y: 380 },
    ]);
    expect(vb.x).toBeLessThan(300);
    expect(vb.x + vb.w).toBeGreaterThan(500);
    expect(vb.y).toBeLessThan(300);
    expect(vb.y + vb.h).toBeGreaterThan(380);
    expect(vb.w / vb.h).toBeCloseTo(900 / 730);
  });

  it("never blows a tiny world up past the minimum frame", () => {
    const vb = fitViewBox([{ x: 400, y: 400 }]);
    expect(vb.w).toBeGreaterThanOrEqual(420);
    expect(vb.h).toBeGreaterThanOrEqual(340);
  });

  it("uses the default view with no rooms", () => {
    expect(fitViewBox([])).toEqual({ x: 50, y: 10, w: 900, h: 730 });
  });
});
