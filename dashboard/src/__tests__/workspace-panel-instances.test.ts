// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { collides, type ResponsiveLayouts } from "react-grid-layout";
import { describe, expect, it } from "vitest";
import { WORKSPACE_LAYOUTS } from "../lib/workspace-layouts";
import {
  closePanelInstance,
  MAX_EXTRA_PANELS,
  openPanelBelow,
  panelInstance,
  panelInstanceIds,
} from "../lib/workspace-panel-instances";

const columns = { lg: 20, md: 20 };
const sorted = (layouts: ResponsiveLayouts<"lg" | "md">) =>
  Object.fromEntries(
    Object.entries(layouts).map(([bp, items]) => [
      bp,
      [...items].sort((a, b) => a.i.localeCompare(b.i)),
    ]),
  );

describe("local panel instances", () => {
  it("separates view identity from trusted component identity", () => {
    expect(panelInstance("view:worldmap:2")).toEqual({
      id: "view:worldmap:2",
      panelId: "worldmap",
      number: 2,
    });
    for (const id of [
      "worldmap",
      "view:https://example.com:1",
      "view:worldmap:0",
      "view:worldmap:01",
      "view:worldmap:1:2",
    ])
      expect(panelInstance(id)).toBeNull();
  });

  it("splits the source at both breakpoints, preserving neighbors and the input preset", () => {
    const original = structuredClone(WORKSPACE_LAYOUTS);
    const next = openPanelBelow(WORKSPACE_LAYOUTS, "workspace", "worldmap", columns)!;
    expect(next.id).toBe("view:worldmap:1");
    for (const bp of ["lg", "md"] as const) {
      expect(next.layouts[bp]!.find((item) => item.i === "workspace")).toMatchObject({
        h: 6,
        y: 0,
      });
      expect(next.layouts[bp]!.find((item) => item.i === next.id)).toMatchObject({
        h: 6,
        y: 6,
        minH: 4,
      });
      for (const id of ["webchat", "context"])
        expect(next.layouts[bp]!.find((item) => item.i === id)).toMatchObject(
          original[bp]!.find((item) => item.i === id)!,
        );
    }
    expect(WORKSPACE_LAYOUTS).toEqual(original);
    expect(panelInstanceIds(next.layouts)).toEqual([next.id]);
    expect(sorted(closePanelInstance(next.layouts, next.id, columns))).toMatchObject(
      sorted(original),
    );
  });

  it("preserves minimum height and inserts without collisions when there is no space to split", () => {
    let layouts: ResponsiveLayouts<"lg" | "md"> = WORKSPACE_LAYOUTS;
    for (let i = 0; i < MAX_EXTRA_PANELS; i++) {
      layouts = openPanelBelow(layouts, "workspace", "worldmap", columns)!.layouts;
      for (const items of Object.values(layouts)) {
        for (const item of items) {
          expect(item.h).toBeGreaterThanOrEqual(item.minH ?? 1);
          expect(items.some((other) => other.i !== item.i && collides(item, other))).toBe(false);
        }
      }
    }
    expect(panelInstanceIds(layouts)).toHaveLength(MAX_EXTRA_PANELS);
    expect(Math.max(...layouts.lg!.map((item) => item.y + item.h))).toBeGreaterThan(12);
    expect(openPanelBelow(layouts, "workspace", "worldmap", columns)).toBeNull();
    layouts = closePanelInstance(layouts, "view:worldmap:2", columns);
    const reopened = openPanelBelow(layouts, "view:worldmap:1", "worldmap", columns)!;
    expect(reopened.id).toBe("view:worldmap:2");
    expect(panelInstanceIds(reopened.layouts)).toHaveLength(MAX_EXTRA_PANELS);
  });

  it("refuses to remove base panels, split static/missing panels, or shrink below a source minimum", () => {
    expect(closePanelInstance(WORKSPACE_LAYOUTS, "workspace", columns)).toBe(WORKSPACE_LAYOUTS);
    expect(openPanelBelow(WORKSPACE_LAYOUTS, "missing", "worldmap", columns)).toBeNull();
    const fixed = { lg: [{ i: "workspace", x: 0, y: 0, w: 10, h: 12, static: true }] };
    expect(openPanelBelow(fixed, "workspace", "worldmap", columns)).toBeNull();
    const tall = { lg: [{ i: "workspace", x: 0, y: 0, w: 10, h: 12, minH: 8 }] };
    const next = openPanelBelow(tall, "workspace", "worldmap", columns)!;
    expect(next.layouts.lg!.find((item) => item.i === "workspace")!.h).toBe(8);
    expect(next.layouts.md).toEqual(next.layouts.lg);
  });

  it("honors a neighbor's maximum height on close", () => {
    const layout = {
      lg: [
        { i: "workspace", x: 0, y: 0, w: 10, h: 4, maxH: 4 },
        { i: "view:worldmap:1", x: 0, y: 4, w: 10, h: 4 },
      ],
    };
    const closed = closePanelInstance(layout, "view:worldmap:1", columns);
    expect(closed.lg).toMatchObject([layout.lg[0]]);
    expect(closed.md).toEqual(closed.lg);
  });
});
