// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { useWorkspaceState } from "../hooks/use-workspace-state";
import { renderWithProviders, resetWorldState } from "./test-utils";

// Mock the WebSocket hook — no real WS connection in tests
vi.mock("../hooks/use-websocket", () => ({
  useDashboardWebSocket: () => ({ connected: false }),
}));

// Mock react-grid-layout: the real component needs measured container widths
// which jsdom cannot provide. Replace with a simple div that renders children.
vi.mock("react-grid-layout", async () => {
  const React = await import("react");
  return {
    ResponsiveGridLayout: ({ children }: { children: ReactNode }) =>
      React.createElement("div", { "data-testid": "grid-layout" }, children),
    verticalCompactor: () => {},
    useContainerWidth: () => ({
      width: 1200,
      containerRef: { current: null },
      mounted: true,
    }),
  };
});

beforeEach(() => {
  resetWorldState();
  localStorage.clear();
  window.history.replaceState(null, "", "/dashboard");
  useWorkspaceState.setState({
    view: "work",
    pane: "workspace",
    selection: null,
    fullscreen: false,
    attachment: null,
    pendingPin: null,
  });
});

describe("App", () => {
  it("renders without crashing", () => {
    const { container } = renderWithProviders(<App />);
    expect(container).toBeTruthy();
  });

  it("renders the header with MARINA title", () => {
    renderWithProviders(<App />);
    // The header renders each letter as a separate span ("A" appears twice in MARINA)
    expect(screen.getByText("M")).toBeInTheDocument();
    expect(screen.getByText("Mission Control")).toBeInTheDocument();
  });

  it("shows disconnected state when WebSocket is not connected", () => {
    renderWithProviders(<App />);
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("contains expected panel sections", () => {
    renderWithProviders(<App />);
    // GlassPanel titles rendered by child components
    expect(screen.getByText("Entities")).toBeInTheDocument();
  });

  it("renders the grid layout container", () => {
    renderWithProviders(<App />);
    expect(screen.getByTestId("grid-layout")).toBeInTheDocument();
  });

  it("maximizes the three-pane layout and ignores double-clicks on header buttons", () => {
    renderWithProviders(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Maximize Workspace/ }));
    const restore = screen.getByRole("button", { name: /^Restore Workspace/ });
    fireEvent.doubleClick(restore);
    expect(restore).toBeInTheDocument();
    expect(screen.getByTestId("grid-layout").children).toHaveLength(3);
    fireEvent.click(restore);
    expect(screen.getByRole("button", { name: /^Maximize Workspace/ })).toBeInTheDocument();
  });

  it("shows actionable first-run guidance on the standard dashboard", () => {
    renderWithProviders(<App />);
    expect(screen.getByRole("complementary", { name: /getting started/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose a name/i })).toBeInTheDocument();
  });

  it("opens the global attention inbox from the header alert indicator", () => {
    renderWithProviders(<App />);
    fireEvent.click(screen.getByTitle("Operations clear"));
    expect(screen.getByRole("complementary", { name: "Attention inbox" })).toBeInTheDocument();
  });

  it("opens the isolated trace explorer from Admin without changing the grid", async () => {
    renderWithProviders(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "Admin" }));
    fireEvent.click(screen.getByRole("button", { name: "traces" }));
    // The trace explorer is a lazy chunk (components/lazy-tabs.tsx).
    expect(await screen.findByText("Recent execution traces")).toBeInTheDocument();
    expect(screen.getByTestId("grid-layout")).toBeInTheDocument();
  });
});

it("opens the Admin workspace for health and spending hand-offs", () => {
  renderWithProviders(<App />);
  fireEvent(window, new CustomEvent("marina:open-admin", { detail: { tab: "readiness" } }));
  expect(screen.getByRole("tab", { name: "Admin" })).toHaveAttribute("aria-selected", "true");
});
