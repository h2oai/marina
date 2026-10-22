// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ResidentName } from "../components/ResidentName";
import { useWorldState } from "../hooks/use-world-state";

afterEach(() => {
  act(() => useWorldState.setState({ entities: [] }));
});

describe("ResidentName", () => {
  it("is the plain name for an entity with no vendor or presence", () => {
    render(<ResidentName name="qop" />);
    expect(screen.getByTestId("resident-name")).toHaveTextContent(/^qop$/);
  });

  it("reads vendor and presence from the world snapshot and follows changes", () => {
    act(() =>
      useWorldState.setState({
        entities: [
          {
            id: "e_1",
            name: "Wren",
            kind: "agent",
            room: "w/start",
            vendor: "claude",
            presence: "idle",
          },
        ],
      }),
    );
    render(<ResidentName name="Wren" />);
    expect(screen.getByTestId("resident-name")).toHaveTextContent("Wren[claude]idle");
    act(() =>
      useWorldState.setState({
        entities: [
          {
            id: "e_1",
            name: "Wren",
            kind: "agent",
            room: "w/start",
            vendor: "claude",
            presence: "needs_you",
          },
        ],
      }),
    );
    expect(screen.getByTitle("Presence: needs you")).toBeVisible();
  });

  it("prefers explicit props and can hide presence", () => {
    render(<ResidentName name="Swift" vendor="codex" presence="blocked" showPresence={false} />);
    expect(screen.getByText("[codex]")).toBeVisible();
    expect(screen.queryByText("blocked")).not.toBeInTheDocument();
  });
});
