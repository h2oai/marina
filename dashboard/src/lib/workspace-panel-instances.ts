// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { type ResponsiveLayouts, verticalCompactor } from "react-grid-layout";

export type PanelInstanceId = `view:${string}:${number}`;
export const MAX_EXTRA_PANELS = 4;
type Layouts = ResponsiveLayouts<"lg" | "md">;

/** Instance identity lives in the existing layout key, separate from the registry key. */
export function panelInstance(id: string) {
  const match = /^view:([a-z][a-z0-9-]*):([1-9]\d{0,3})$/.exec(id);
  return match ? { id: id as PanelInstanceId, panelId: match[1]!, number: Number(match[2]) } : null;
}

export function panelInstanceIds(layouts: Layouts): PanelInstanceId[] {
  return [...new Set([...(layouts.lg ?? []), ...(layouts.md ?? [])].map((item) => item.i))].filter(
    (id): id is PanelInstanceId => panelInstance(id) !== null,
  );
}

/** Split a tall tile; otherwise insert below it without shrinking other views. */
export function openPanelBelow(
  layouts: Layouts,
  sourceId: string,
  panelId: string,
  columns: { lg: number; md: number },
): { id: PanelInstanceId; layouts: Layouts } | null {
  const instances = panelInstanceIds(layouts);
  if (instances.length >= MAX_EXTRA_PANELS || !/^[a-z][a-z0-9-]*$/.test(panelId)) return null;
  let number = 1;
  while (instances.includes(`view:${panelId}:${number}`)) number++;
  const id: PanelInstanceId = `view:${panelId}:${number}`;
  const next: Layouts = {};
  for (const bp of ["lg", "md"] as const) {
    const items = (layouts[bp] ?? layouts.lg ?? layouts.md ?? []).map((item) => ({ ...item }));
    const source = items.find((item) => item.i === sourceId);
    if (!source || source.static) return null;
    const minH = 4;
    const canSplit = source.h >= (source.minH ?? 1) + minH;
    const height = canSplit
      ? Math.max(minH, Math.min(Math.floor(source.h / 2), source.h - (source.minH ?? 1)))
      : Math.max(minH, Math.min(source.h, 6));
    if (canSplit) source.h -= height;
    const added = {
      i: id,
      x: source.x,
      y: source.y + source.h,
      w: source.w,
      h: height,
      minW: Math.min(source.w, 4),
      minH,
    };
    // Earlier insertion wins ties in the existing grid's stable compactor.
    next[bp] = verticalCompactor.compact([added, ...items], columns[bp]);
  }
  return { id, layouts: next };
}

/** Closing a view is a local layout edit; reclaim an adjoining split when possible. */
export function closePanelInstance(
  layouts: Layouts,
  id: string,
  columns: { lg: number; md: number },
): Layouts {
  if (!panelInstance(id)) return layouts;
  return Object.fromEntries(
    (["lg", "md"] as const).map((bp) => {
      const items = layouts[bp] ?? layouts.lg ?? layouts.md ?? [];
      const removed = items.find((item) => item.i === id);
      const next = items.filter((item) => item.i !== id).map((item) => ({ ...item }));
      if (removed) {
        const above = next.find(
          (item) =>
            !item.static &&
            item.x === removed.x &&
            item.w === removed.w &&
            item.y + item.h === removed.y,
        );
        if (above && above.h + removed.h <= (above.maxH ?? Infinity)) above.h += removed.h;
      }
      return [bp, verticalCompactor.compact(next, columns[bp])];
    }),
  );
}
