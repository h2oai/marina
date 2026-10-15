// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The library's windowed grid (or list): only the rows intersecting the
 * scroll viewport (plus overscan) are in the DOM, laid out absolutely inside
 * a spacer of the full height, so thousands of assets stay cheap. Columns
 * follow the container width (ResizeObserver).
 *
 * It is one `listbox` (aria-multiselectable) with `aria-activedescendant`:
 * arrows / Home / End / PageUp / PageDown move the active item (Shift extends
 * the selection), Enter opens it, Space toggles it, Ctrl/Cmd+A selects all.
 * Click selects, Ctrl/Cmd+click toggles, Shift+click selects a range,
 * double-click opens. Nearing the end asks for the next page.
 */

import { Check } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatBytes, formatDuration, type LibraryItem } from "../../lib/asset-library";
import { type ClickModifiers, gridMove } from "../../lib/asset-selection";
import { AssetThumb } from "./AssetThumb";

export type GridView = "grid" | "list";

const GAP = 8;
const MIN_CELL = 150;
const LABEL_H = 36;
const LIST_ROW = 56;
const OVERSCAN_ROWS = 2;
/** Size assumed before the container is measured (and in jsdom). */
const FALLBACK = { w: 720, h: 480 };

export function gridGeometry(width: number, view: GridView) {
  const w = width || FALLBACK.w;
  if (view === "list") return { columns: 1, cell: w, rowHeight: LIST_ROW, thumb: 40 };
  const columns = Math.max(1, Math.floor((w + GAP) / (MIN_CELL + GAP)));
  const cell = (w - GAP * (columns - 1)) / columns;
  return { columns, cell, rowHeight: cell + LABEL_H, thumb: Math.floor(cell) };
}

export function AssetGrid({
  items,
  view,
  selected,
  activeIndex,
  onActiveIndex,
  onSelect,
  onToggle,
  onSelectAll,
  onExtend,
  onOpen,
  onEndReached,
  label = "Assets",
}: {
  items: readonly LibraryItem[];
  view: GridView;
  selected: ReadonlySet<string>;
  activeIndex: number;
  onActiveIndex: (index: number) => void;
  onSelect: (id: string, mods: ClickModifiers) => void;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  /** Shift+arrow: extend the selection to `id`. */
  onExtend: (id: string) => void;
  onOpen: (index: number) => void;
  onEndReached?: () => void;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { columns, cell, rowHeight, thumb } = gridGeometry(size.w, view);
  const stride = rowHeight + (view === "grid" ? GAP : 0);
  const rows = Math.ceil(items.length / columns);
  const height = size.h || FALLBACK.h;
  const firstRow = Math.max(0, Math.floor(scrollTop / stride) - OVERSCAN_ROWS);
  const lastRow = Math.min(rows - 1, Math.ceil((scrollTop + height) / stride) + OVERSCAN_ROWS);
  const start = firstRow * columns;
  const end = Math.min(items.length, (lastRow + 1) * columns);

  // Ask for more while the window reaches the last rows (a short page —
  // rows hidden by the read check — just triggers the next one).
  useEffect(() => {
    if (rows === 0 || lastRow >= rows - 1 - OVERSCAN_ROWS) onEndReached?.();
  }, [lastRow, rows, onEndReached]);

  // Keep the active item in view.
  useEffect(() => {
    const el = ref.current;
    if (!el || activeIndex < 0) return;
    const top = Math.floor(activeIndex / columns) * stride;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight && el.clientHeight > 0)
      el.scrollTop = top + rowHeight - el.clientHeight;
  }, [activeIndex, columns, stride, rowHeight]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (items.length === 0) return;
      const current = activeIndex < 0 ? 0 : activeIndex;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        onSelectAll();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        onOpen(current);
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        const item = items[current];
        if (item) onToggle(item.id);
        if (activeIndex < 0) onActiveIndex(current);
        return;
      }
      const next = gridMove(e.key, activeIndex < 0 ? -1 : current, items.length, columns);
      if (next === null) return;
      e.preventDefault();
      const target = activeIndex < 0 && e.key.startsWith("Arrow") ? 0 : next;
      onActiveIndex(target);
      const item = items[target];
      if (e.shiftKey && item) onExtend(item.id);
    },
    [items, activeIndex, columns, onActiveIndex, onExtend, onOpen, onSelectAll, onToggle],
  );

  const active = items[activeIndex];
  return (
    <div
      ref={ref}
      role="listbox"
      aria-label={label}
      aria-multiselectable="true"
      aria-activedescendant={active ? `asset-opt-${active.id}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="relative h-full min-h-0 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <div style={{ height: rows * stride, position: "relative" }}>
        {items.slice(start, end).map((item, i) => {
          const index = start + i;
          const row = Math.floor(index / columns);
          const col = index % columns;
          const isSelected = selected.has(item.id);
          const isActive = index === activeIndex;
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled by the listbox (aria-activedescendant).
            <div
              key={item.id}
              id={`asset-opt-${item.id}`}
              role="option"
              tabIndex={-1}
              aria-selected={isSelected}
              aria-setsize={items.length}
              aria-posinset={index + 1}
              data-active={isActive || undefined}
              onClick={(e) => {
                onActiveIndex(index);
                const toggleMark = (e.target as HTMLElement).closest("[data-select-mark]");
                if (toggleMark) onToggle(item.id);
                else onSelect(item.id, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
              }}
              onDoubleClick={() => onOpen(index)}
              className={`group absolute cursor-pointer select-none rounded-md border p-1 transition-colors ${
                isSelected
                  ? "border-primary bg-primary/10"
                  : "border-transparent hover:border-border hover:bg-bg-hover/60"
              } ${isActive ? "ring-2 ring-primary/70" : ""}`}
              style={{
                top: row * stride,
                left: view === "grid" ? col * (cell + GAP) : 0,
                width: view === "grid" ? cell : "100%",
                height: rowHeight,
              }}
            >
              {view === "grid" ? (
                <GridCell item={item} thumb={thumb - 8} selected={isSelected} />
              ) : (
                <ListRow item={item} selected={isSelected} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SelectMark({ selected }: { selected: boolean }) {
  return (
    <span
      data-select-mark
      aria-hidden="true"
      className={`flex h-4 w-4 items-center justify-center rounded border text-bg ${
        selected
          ? "border-primary bg-primary"
          : "border-border bg-bg/70 opacity-0 group-hover:opacity-100"
      }`}
    >
      {selected && <Check size={10} />}
    </span>
  );
}

function meta(item: LibraryItem): string {
  if (item.durationMs != null) return formatDuration(item.durationMs);
  if (item.pages != null) return `${item.pages} p`;
  if (item.width && item.height) return `${item.width}×${item.height}`;
  return formatBytes(item.size);
}

function GridCell({
  item,
  thumb,
  selected,
}: {
  item: LibraryItem;
  thumb: number;
  selected: boolean;
}) {
  return (
    <div className="relative flex h-full flex-col items-center">
      <AssetThumb item={item} size={Math.max(40, thumb)} />
      <div className="absolute left-1 top-1">
        <SelectMark selected={selected} />
      </div>
      <div className="mt-1 w-full min-w-0 px-0.5 text-[10px] leading-tight">
        <div className="truncate text-text" title={item.filename}>
          {item.filename}
        </div>
        <div className="truncate text-text-dim">
          {item.type} · {meta(item)}
        </div>
      </div>
    </div>
  );
}

function ListRow({ item, selected }: { item: LibraryItem; selected: boolean }) {
  return (
    <div className="flex h-full items-center gap-2 px-1 text-[11px]">
      <SelectMark selected={selected} />
      <AssetThumb item={item} size={40} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-text" title={item.filename}>
          {item.filename}
        </div>
        <div className="truncate text-text-dim">
          {item.owner} · {item.origin}
          {item.tags.length > 0 && ` · ${item.tags.join(", ")}`}
        </div>
      </div>
      <span className="hidden shrink-0 text-text-dim sm:inline">{item.type}</span>
      <span className="w-20 shrink-0 text-right tabular-nums text-text-dim">{meta(item)}</span>
      <span className="hidden w-24 shrink-0 text-right text-text-dim md:inline">
        {new Date(item.createdAt).toLocaleDateString()}
      </span>
    </div>
  );
}
