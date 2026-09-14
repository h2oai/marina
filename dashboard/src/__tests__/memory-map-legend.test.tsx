// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MEMORY_GLYPHS, UNIFIED_TIERS } from "../unified/lib/memory-map-types";
import { LegendContent } from "../unified/overlays/Legend";

describe("Legend — MEMORY section", () => {
  it("adds a memory tab with the six glyphs and the five unified tier colors", () => {
    render(<LegendContent />);
    fireEvent.click(screen.getByRole("button", { name: /^memory$/i }));

    const section = screen.getByTestId("legend-memory");
    for (const g of MEMORY_GLYPHS) {
      expect(within(section).getByTitle(`${g.kind} glyph`)).toBeInTheDocument();
      expect(within(section).getByText(g.label)).toBeInTheDocument();
    }
    for (const tier of UNIFIED_TIERS) {
      expect(within(section).getByText(`[${tier}]`)).toBeInTheDocument();
    }
    // Job states and the H/A/S marker explainer are taught too
    for (const state of ["pending", "running", "answered", "abstained", "cancelled"]) {
      expect(within(section).getByText(state)).toBeInTheDocument();
    }
    expect(
      within(section).getByText(/H hygiene · A accumulation · S shared-write-review/),
    ).toBeInTheDocument();
  });

  it("keeps the existing tabs intact", () => {
    render(<LegendContent />);
    for (const tab of ["notes", "edges", "feed", "memory"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${tab}$`, "i") })).toBeInTheDocument();
    }
    // default tab still notes
    expect(screen.getByText(/Note types \(graph nodes\)/)).toBeInTheDocument();
  });
});
