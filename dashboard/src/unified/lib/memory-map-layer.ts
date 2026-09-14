// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * memory-map-layer -- Layer-visibility helpers shared by the UnifiedCanvas
 * keyboard handler and the layer chips.
 *
 * Layers: 1 WORLD · 2 CANVAS · 3 GRAPH · 4 FEED · 5 MEMORY. Plain key toggles
 * one layer; shift+key (or shift-click) solos it. Each layer persists its own
 * `uc:hide-<layer>` boolean in localStorage (mirrors `loadLayerPref` in
 * UnifiedCanvas — kept here so the MEMORY layer's persistence unit-tests).
 */

export type LayerName = "world" | "canvas" | "graph" | "feed" | "memory";

export const LAYER_ORDER: readonly LayerName[] = ["world", "canvas", "graph", "feed", "memory"];

/** `true` = hidden (matches the existing `hideWorld` / `hideGraph` state shape). */
export type LayerVisibility = Record<LayerName, boolean>;

export const MEMORY_LAYER_PREF_KEY = "uc:hide-memory";

export function layerPrefKey(layer: LayerName): string {
  return `uc:hide-${layer}`;
}

/** Map a digit key to a layer, or null when it's not a layer key. */
export function layerForKey(key: string): LayerName | null {
  const idx = Number(key);
  if (!Number.isInteger(idx) || idx < 1 || idx > LAYER_ORDER.length) return null;
  return LAYER_ORDER[idx - 1] ?? null;
}

/**
 * Apply a layer key press. Returns the next hidden-map, or null when `key` is
 * not a layer key (caller leaves the event alone).
 */
export function applyLayerKey(
  current: LayerVisibility,
  key: string,
  shift: boolean,
): LayerVisibility | null {
  const layer = layerForKey(key);
  if (!layer) return null;
  return shift ? soloLayer(layer) : { ...current, [layer]: !current[layer] };
}

/** Hide every layer except `layer`. */
export function soloLayer(layer: LayerName): LayerVisibility {
  const next = {} as LayerVisibility;
  for (const l of LAYER_ORDER) next[l] = l !== layer;
  return next;
}

export function loadLayerHidden(layer: LayerName, firstVisitDefault = false): boolean {
  try {
    const raw = localStorage.getItem(layerPrefKey(layer));
    if (raw === null) return firstVisitDefault;
    return raw === "true";
  } catch {
    return firstVisitDefault;
  }
}

export function saveLayerHidden(layer: LayerName, hidden: boolean): void {
  try {
    localStorage.setItem(layerPrefKey(layer), String(hidden));
  } catch {
    // private mode etc. — non-fatal
  }
}
