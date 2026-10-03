// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { collides, type Layout } from "react-grid-layout";
import { describe, expect, it } from "vitest";
import {
  completeWorkspaceLayout,
  moveWorkspacePanel,
  resizeWorkspacePanel,
  workspaceGridMetrics,
  workspacePanelRect,
} from "../lib/workspace-canvas-layout";
import { WORKSPACE_LAYOUTS } from "../lib/workspace-layouts";

describe("the Canvas projection of saved grid layouts", () => {
  const layout = WORKSPACE_LAYOUTS.lg!;
  const metrics = workspaceGridMetrics(1432, 20, 70);

  it("retains the 30/45/25 proportions, four-pixel gutters and existing preset coordinates", () => {
    const [chat, workspace, context] = layout.map((item) => workspacePanelRect(metrics, item));
    expect(chat).toEqual({ left: 4, top: 4, width: 424, height: 884 });
    expect(workspace.left - (chat.left + chat.width)).toBe(4);
    expect(context.left - (workspace.left + workspace.width)).toBe(4);
    expect(context.left + context.width).toBe(1428);
  });

  it("moves and compacts colliding panels without changing the input preset", () => {
    const original = structuredClone(layout);
    const next = moveWorkspacePanel(layout, "context", { x: 4, y: 4 }, metrics);
    expect(next.find((item) => item.i === "context")?.x).toBe(0);
    for (const item of next) {
      expect(next.some((other) => item.i !== other.i && collides(item, other))).toBe(false);
    }
    expect(layout).toEqual(original);
  });

  it("bounds resize to the preset minimum and available columns", () => {
    const narrow = resizeWorkspacePanel(layout, "webchat", { width: 1, height: 1 }, metrics);
    expect(narrow.find((item) => item.i === "webchat")).toMatchObject({ w: 4, h: 4 });
    const wide = resizeWorkspacePanel(layout, "context", { width: 10000, height: 400 }, metrics);
    expect(wide.find((item) => item.i === "context")).toMatchObject({ x: 15, w: 5 });
    const bounded: Layout = [{ i: "bounded", x: 0, y: 0, w: 5, h: 4, maxW: 6, maxH: 5 }];
    expect(
      resizeWorkspacePanel(bounded, "bounded", { width: 5000, height: 5000 }, metrics)[0],
    ).toMatchObject({ w: 6, h: 5 });
  });

  it("leaves static and unknown panels untouched", () => {
    const fixed: Layout = [{ ...layout[0], static: true }];
    expect(moveWorkspacePanel(fixed, "webchat", { x: 500, y: 500 }, metrics)).toBe(fixed);
    expect(resizeWorkspacePanel(fixed, "webchat", { width: 500, height: 500 }, metrics)).toBe(
      fixed,
    );
    expect(moveWorkspacePanel(layout, "missing", { x: 500, y: 500 }, metrics)).toBe(layout);
  });

  it("places a newly registered panel without losing saved panels or mutating their layout", () => {
    const original = structuredClone(layout);
    const next = completeWorkspaceLayout(layout, ["webchat", "workspace", "context", "custom"], 20);
    expect(next.find((item) => item.i === "custom")).toMatchObject({ x: 0, y: 12, w: 1, h: 1 });
    expect(next).toHaveLength(4);
    expect(layout).toEqual(original);
    expect(completeWorkspaceLayout(next, ["webchat", "workspace", "context"], 20)).toHaveLength(3);
  });
});
