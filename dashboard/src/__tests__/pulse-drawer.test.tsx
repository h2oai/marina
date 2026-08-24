// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PulseDrawer } from "../components/PulseDrawer";
import { useWorldState } from "../hooks/use-world-state";

afterEach(() => {
  act(() => useWorldState.setState({ eventFeed: [], thinkingAgents: {}, connectedSince: 0 }));
});

describe("PulseDrawer", () => {
  it("labels its live window honestly and links trace evidence", () => {
    act(() =>
      useWorldState.setState({
        connectedSince: 1_700_000_000_000,
        thinkingAgents: { Builder: 1_700_000_000_001 },
        eventFeed: [
          {
            type: "agent_turn_end",
            timestamp: 1_700_000_000_002,
            name: "Builder",
            traceId: "trace-7",
            spanId: "span-3",
            error: "provider unavailable",
          },
        ],
      }),
    );

    render(<PulseDrawer open onClose={() => undefined} />);

    expect(screen.getByRole("complementary", { name: "Live pulse" })).toBeVisible();
    expect(screen.getByText(/live WebSocket window, not historical totals/i)).toBeVisible();
    expect(screen.getByText("1", { selector: "strong.text-secondary" })).toBeVisible();
    expect(screen.getByText("1", { selector: "strong.text-danger" })).toBeVisible();
    expect(screen.getByRole("link", { name: /turn done/ })).toHaveAttribute(
      "href",
      "/dashboard?trace=trace-7&span=span-3",
    );
  });
});
