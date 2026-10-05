// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  calcGridItemPosition,
  calcWH,
  calcXY,
  cloneLayout,
  collides,
  type Layout,
  moveElement,
  verticalCompactor,
} from "react-grid-layout";
import { correctBounds } from "react-grid-layout/core";

/** Explicitly balance each row; honor minimums, maximums and fixed panels. */
export function balanceWorkspaceRows(layout: Layout, cols: number): Layout {
  const next = layout.map((item) => ({ ...item }));
  const rows = new Map<number, Array<Layout[number]>>();
  for (const item of next) rows.set(item.y, [...(rows.get(item.y) ?? []), item]);
  for (const row of rows.values()) {
    if (row.some((item) => item.static || item.isResizable === false || item.isDraggable === false))
      continue;
    row.sort((a, b) => a.x - b.x);
    const widths = row.map((item) => Math.max(1, item.minW ?? 1));
    let remaining = cols - widths.reduce((sum, w) => sum + w, 0);
    if (remaining < 0) continue;
    while (remaining > 0) {
      const eligible = row
        .map((item, i) => ({ item, i }))
        .filter(({ item, i }) => widths[i]! < (item.maxW ?? cols));
      eligible.sort((a, b) => widths[a.i]! - widths[b.i]! || a.i - b.i);
      if (!eligible.length) break;
      widths[eligible[0]!.i]!++;
      remaining--;
    }
    let x = 0;
    row.forEach((item, i) => {
      item.x = x;
      item.w = widths[i]!;
      x += item.w;
    });
  }
  // Staggered rows may overlap vertically. Never balance them through another panel.
  if (next.some((item) => next.some((other) => item.i !== other.i && collides(item, other))))
    return layout;
  return next;
}

/** Keyboard/button movement uses the same collision policy as dragging. */
export function nudgeWorkspacePanel(
  layout: Layout,
  id: string,
  dx: number,
  dy: number,
  cols: number,
): Layout {
  const next = cloneLayout(layout);
  const item = next.find((entry) => entry.i === id);
  if (!item || item.static || item.isDraggable === false) return layout;
  return verticalCompactor.compact(
    moveElement(
      next,
      item,
      Math.max(0, Math.min(cols - item.w, item.x + dx)),
      Math.max(0, item.y + dy),
      true,
      false,
      "vertical",
      cols,
    ),
    cols,
  );
}

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
