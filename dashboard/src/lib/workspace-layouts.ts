// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ResponsiveLayouts } from "react-grid-layout";
import type { LayoutPreset } from "../hooks/use-layout-presets";

type Bp = "lg" | "md";
export const WORKSPACE_LAYOUTS: ResponsiveLayouts<Bp> = Object.fromEntries(
  ["lg", "md"].map((bp) => [
    bp,
    [
      { i: "webchat", x: 0, y: 0, w: 6, h: 12, minW: 4, minH: 4 },
      { i: "workspace", x: 6, y: 0, w: 9, h: 12, minW: 5, minH: 4 },
      { i: "context", x: 15, y: 0, w: 5, h: 12, minW: 4, minH: 4 },
    ],
  ]),
);
export const BUILTIN_PRESETS: LayoutPreset[] = [
  { id: "default", name: "Operate", view: "work" },
  { id: "explore", name: "Explore", view: "map" },
  { id: "create", name: "Create", view: "canvas" },
  { id: "observe", name: "Observe", view: "observe" },
].map((p) => ({
  ...p,
  view: p.view as LayoutPreset["view"],
  layouts: WORKSPACE_LAYOUTS,
  locked: true,
  version: 2,
  createdAt: 0,
  updatedAt: 0,
}));
