// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The library's selection model, pure so it is tested without a DOM:
 * plain click selects one item, Ctrl/Cmd toggles one, Shift extends a range
 * from the anchor over the CURRENT ordering (adding to the selection when
 * combined with Ctrl/Cmd), and select-all takes every loaded item.
 */

export interface Selection {
  selected: ReadonlySet<string>;
  /** Where the next Shift range starts. */
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { selected: new Set(), anchor: null };

export interface ClickModifiers {
  shift?: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  toggle?: boolean;
}

export function selectClick(
  state: Selection,
  id: string,
  order: readonly string[],
  mods: ClickModifiers = {},
): Selection {
  if (mods.shift && state.anchor !== null) {
    const from = order.indexOf(state.anchor);
    const to = order.indexOf(id);
    if (from >= 0 && to >= 0) {
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      const range = order.slice(lo, hi + 1);
      const next = new Set(mods.toggle ? state.selected : []);
      for (const r of range) next.add(r);
      return { selected: next, anchor: state.anchor };
    }
  }
  if (mods.toggle || mods.shift) return toggleOne(state, id);
  return { selected: new Set([id]), anchor: id };
}

export function toggleOne(state: Selection, id: string): Selection {
  const next = new Set(state.selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return { selected: next, anchor: id };
}

export function selectAll(order: readonly string[]): Selection {
  return { selected: new Set(order), anchor: order[0] ?? null };
}

/** Drop ids that are no longer listed (deleted, or filtered away). */
export function pruneSelection(state: Selection, order: readonly string[]): Selection {
  const present = new Set(order);
  let changed = false;
  const next = new Set<string>();
  for (const id of state.selected) {
    if (present.has(id)) next.add(id);
    else changed = true;
  }
  if (!changed && (state.anchor === null || present.has(state.anchor))) return state;
  return {
    selected: next,
    anchor: state.anchor && present.has(state.anchor) ? state.anchor : null,
  };
}

/**
 * The index an arrow key moves to in a grid of `columns` columns (clamped;
 * Home/End go to the ends, PageUp/PageDown move `pageRows` rows).
 */
export function gridMove(
  key: string,
  index: number,
  count: number,
  columns: number,
  pageRows = 4,
): number | null {
  if (count === 0) return null;
  const cols = Math.max(1, columns);
  const clamp = (i: number) => Math.min(count - 1, Math.max(0, i));
  switch (key) {
    case "ArrowRight":
      return clamp(index + 1);
    case "ArrowLeft":
      return clamp(index - 1);
    case "ArrowDown":
      return clamp(index + cols);
    case "ArrowUp":
      return clamp(index - cols);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return clamp(index + cols * pageRows);
    case "PageUp":
      return clamp(index - cols * pageRows);
    default:
      return null;
  }
}
