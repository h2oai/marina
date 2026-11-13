// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { A2UIRenderer } from "../canvas/nodes/a2ui/A2UIRenderer";

it("draws a newer Marina's component as a named placeholder and keeps its children", () => {
  render(
    <A2UIRenderer
      nodeData={{
        components: [
          { id: "root", component: "Column", children: ["tabs", "ok"] },
          { id: "tabs", component: "Tabs", label: "Queues", children: ["inside"] },
          { id: "inside", component: "Text", text: "Open items" },
          { id: "ok", component: "Button", label: "Refresh", action: { event: { name: "r" } } },
        ],
      }}
    />,
  );
  expect(screen.getByRole("group", { name: "Tabs: Queues (needs a newer Marina)" })).toBeTruthy();
  expect(screen.getByText("Open items")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
});
