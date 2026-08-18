// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Node } from "@xyflow/react";

/** Default tile dimensions per node type */
export const DEFAULT_SIZES: Record<string, { w: number; h: number }> = {
  image: { w: 300, h: 240 },
  video: { w: 400, h: 300 },
  audio: { w: 300, h: 140 },
  text: { w: 260, h: 180 },
  pdf: { w: 360, h: 480 },
  document: { w: 360, h: 320 },
  frame: { w: 500, h: 400 },
  embed: { w: 260, h: 180 },
  a2ui: { w: 400, h: 360 },
};

/** Tile gap between nodes */
const GAP = 20;

/** Number of columns for auto-tiling */
const COLS = 4;

/** Max tile width for uniform grid cell sizing */
const CELL_W = 420;
const CELL_H = 500;

/**
 * Compute a tiling position for the next node based on how many nodes
 * already exist. Tiles left-to-right, top-to-bottom, infinitely downward.
 */
export function tilePosition(index: number): { x: number; y: number } {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return {
    x: col * (CELL_W + GAP),
    y: row * (CELL_H + GAP),
  };
}

/**
 * Find the next available tile position that doesn't overlap existing nodes.
 * Scans grid cells until it finds an empty one.
 */
export function nextTilePosition(existing: Node[]): { x: number; y: number } {
  const occupied = new Set<string>();
  for (const n of existing) {
    const col = Math.round(n.position.x / (CELL_W + GAP));
    const row = Math.round(n.position.y / (CELL_H + GAP));
    occupied.add(`${col},${row}`);
  }

  for (let i = 0; i < 10000; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    if (!occupied.has(`${col},${row}`)) {
      return {
        x: col * (CELL_W + GAP),
        y: row * (CELL_H + GAP),
      };
    }
  }

  // Fallback: place after all existing nodes
  return tilePosition(existing.length);
}

/** Get default size for a node type */
export function defaultSize(type: string): { w: number; h: number } {
  return DEFAULT_SIZES[type] ?? { w: 300, h: 200 };
}
