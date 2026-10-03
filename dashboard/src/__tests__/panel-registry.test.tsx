// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  createDashboardPanelRegistry,
  type DashboardPanelDefinition,
  useDashboardPanels,
} from "../lib/panel-registry";

it("renders locally registered components, updates on disposal and isolates slots", () => {
  const registry = createDashboardPanelRegistry();
  function Sidebar() {
    const panels = useDashboardPanels(registry);
    return (
      <>
        {panels
          .filter((p) => p.slot === "sidebar")
          .map((p) => {
            const Panel = p.component;
            return <Panel key={p.id} />;
          })}
      </>
    );
  }
  render(<Sidebar />);
  let dispose!: () => void;
  act(() => {
    dispose = registry.register({
      id: "local-health",
      title: "Health",
      slot: "sidebar",
      component: () => <button type="button">Inspect local health</button>,
    });
    registry.register({
      id: "local-admin",
      title: "Admin",
      slot: "admin-tab",
      component: () => <p>Admin-only slot</p>,
    });
  });
  expect(screen.getByRole("button", { name: "Inspect local health" })).toBeInTheDocument();
  expect(screen.queryByText("Admin-only slot")).toBeNull();
  act(() => dispose());
  expect(screen.queryByRole("button")).toBeNull();
});

it("rejects URL/string components and collisions without modifying existing registrations", () => {
  const registry = createDashboardPanelRegistry();
  const definition: DashboardPanelDefinition = {
    id: "health",
    title: "Health",
    slot: "sidebar",
    component: () => <p>health</p>,
    repeatable: { fromView: "map", actionLabel: "Open health below" },
  };
  registry.register(definition);
  const snapshot = registry.getSnapshot();
  expect(() => registry.register(definition)).toThrow("already registered");
  expect(() =>
    registry.register({
      ...definition,
      id: "remote",
      component:
        "https://example.invalid/panel.js" as unknown as DashboardPanelDefinition["component"],
    }),
  ).toThrow("Invalid trusted");
  expect(registry.getSnapshot()).toBe(snapshot);
});

it("freezes metadata and a stale disposer cannot remove a replacement", () => {
  const registry = createDashboardPanelRegistry();
  const definition: DashboardPanelDefinition = {
    id: "health",
    title: "Health",
    slot: "sidebar",
    component: () => <p>health</p>,
    repeatable: { fromView: "map", actionLabel: "Open health below" },
  };
  const dispose = registry.register(definition);
  definition.title = "Mutated";
  definition.repeatable!.actionLabel = "Mutated";
  expect(registry.getSnapshot()[0]!.title).toBe("Health");
  expect(registry.getSnapshot()[0]!.repeatable?.actionLabel).toBe("Open health below");
  dispose();
  registry.register(definition);
  dispose();
  expect(registry.getSnapshot()).toHaveLength(1);
});
