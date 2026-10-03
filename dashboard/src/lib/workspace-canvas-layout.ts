// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  calcGridItemPosition,
  calcWH,
  calcXY,
  cloneLayout,
  type Layout,
  moveElement,
  verticalCompactor,
} from "react-grid-layout";
import { correctBounds } from "react-grid-layout/core";

/** Match the grid's default placement for newly registered local panels. */
export function completeWorkspaceLayout(
  layout: Layout,
  ids: readonly string[],
  cols: number,
): Layout {
  const next: Array<Layout[number]> = [];
  for (const id of ids) {
    const existing = layout.find((item) => item.i === id);
    next.push(
      existing
        ? { ...existing }
        : {
            i: id,
            x: 0,
            y: Math.max(0, ...next.map((item) => item.y + item.h)),
            w: 1,
            h: 1,
          },
    );
  }
  return verticalCompactor.compact(correctBounds(next, { cols }), cols);
}

/** Keep the Canvas projection in the existing preset format and grid geometry. */
export function workspaceGridMetrics(width: number, cols: number, rowHeight: number) {
  return {
    containerWidth: width,
    cols,
    rowHeight,
    margin: [4, 4] as const,
    containerPadding: [4, 4] as const,
    maxRows: Infinity,
  };
}
export type WorkspaceGridMetrics = ReturnType<typeof workspaceGridMetrics>;

export function workspacePanelRect(metrics: WorkspaceGridMetrics, item: Layout[number]) {
  return calcGridItemPosition(metrics, item.x, item.y, item.w, item.h);
}

/** Reuse the grid's collision/compaction policy; never mutate a saved preset. */
export function moveWorkspacePanel(
  layout: Layout,
  id: string,
  position: { x: number; y: number },
  metrics: WorkspaceGridMetrics,
): Layout {
  const next = cloneLayout(layout);
  const item = next.find((entry) => entry.i === id);
  if (!item || item.static || item.isDraggable === false) return layout;
  const { x, y } = calcXY(metrics, position.y, position.x, item.w, item.h);
  return verticalCompactor.compact(
    moveElement(next, item, x, y, true, false, "vertical", metrics.cols),
    metrics.cols,
  );
}

export function resizeWorkspacePanel(
  layout: Layout,
  id: string,
  size: { width: number; height: number },
  metrics: WorkspaceGridMetrics,
): Layout {
  const next = cloneLayout(layout);
  const item = next.find((entry) => entry.i === id);
  if (!item || item.static || item.isResizable === false) return layout;
  const { w, h } = calcWH(metrics, size.width, size.height, item.x, item.y, "se");
  item.w = Math.max(item.minW ?? 1, Math.min(w, item.maxW ?? metrics.cols, metrics.cols - item.x));
  item.h = Math.max(item.minH ?? 1, Math.min(h, item.maxH ?? Infinity));
  return verticalCompactor.compact(next, metrics.cols);
}
