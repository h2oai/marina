// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * VirtualList — dependency-free windowing for long, roughly uniform rows.
 *
 * Renders only the rows intersecting the scroll viewport plus `overscan` rows
 * on each side, padding the rest with spacer blocks so the scrollbar keeps the
 * full list's geometry. Rows are assumed to be about `rowHeight` px tall; a
 * taller row just means a little more overscan is consumed, never a gap.
 *
 * Deliberately simple (no dynamic measurement, no horizontal axis) — enough
 * for the log explorer's 100-row pages and event lists of a few hundred rows.
 * When `items.length <= threshold` it renders everything, so short lists
 * behave exactly like a plain `map`.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

export interface VirtualListProps<T> {
  items: readonly T[];
  /** Estimated row height in px (used for the window math and spacer sizes). */
  rowHeight: number;
  renderRow: (item: T, index: number) => ReactNode;
  /** Stable key per row. */
  itemKey: (item: T, index: number) => string | number;
  /** Rows rendered beyond the visible window on each side. Default 10. */
  overscan?: number;
  /** Lists at or below this length render fully (no windowing). Default 60. */
  threshold?: number;
  /**
   * Rows shown when the container has no measurable height yet (first paint,
   * jsdom). Default 40 — the "40-row window" that makes the initial render
   * bounded even before layout.
   */
  fallbackWindow?: number;
  className?: string;
  /** Extra props for the scroll container (role, aria-label, data-testid…). */
  containerProps?: React.HTMLAttributes<HTMLDivElement>;
}

/** Pure window math, exported for tests. */
export function computeWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan: number,
  fallbackWindow: number,
): { start: number; end: number } {
  const visible = viewportHeight > 0 ? Math.ceil(viewportHeight / rowHeight) + 1 : fallbackWindow;
  const first = Math.floor(scrollTop / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end };
}

export function VirtualList<T>({
  items,
  rowHeight,
  renderRow,
  itemKey,
  overscan = 10,
  threshold = 60,
  fallbackWindow = 40,
  className,
  containerProps,
}: VirtualListProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const frame = useRef<number | null>(null);

  const onScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const el = ref.current;
      if (el) setScrollTop(el.scrollTop);
    });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  const windowed = items.length > threshold;
  const { start, end } = windowed
    ? computeWindow(scrollTop, viewportHeight, rowHeight, items.length, overscan, fallbackWindow)
    : { start: 0, end: items.length };

  return (
    <div
      ref={ref}
      onScroll={windowed ? onScroll : undefined}
      className={className}
      {...containerProps}
      data-virtual-window={windowed ? `${start}-${end}` : undefined}
    >
      {windowed && start > 0 && <div style={{ height: start * rowHeight }} aria-hidden="true" />}
      {items.slice(start, end).map((item, i) => (
        <div key={itemKey(item, start + i)}>{renderRow(item, start + i)}</div>
      ))}
      {windowed && end < items.length && (
        <div style={{ height: (items.length - end) * rowHeight }} aria-hidden="true" />
      )}
    </div>
  );
}
