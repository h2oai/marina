// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { WorldMap } from "../components/WorldMap";
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
    expect(screen.getByRole("img", { name: "World map" })).toBeInTheDocument();
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
    expect(screen.getByRole("img", { name: "World map" })).toBeInTheDocument();
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

  it("exposes a reset-view control that restores the default viewBox", () => {
    renderWithProviders(<WorldMap worldData={SAMPLE_WORLD_DATA} />);
    const svg = screen.getByRole("img", { name: "World map" });
    const defaultViewBox = svg.getAttribute("viewBox");
    expect(defaultViewBox).toBe("50 10 900 730");

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
