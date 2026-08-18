// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Zustand store tracking the current ReactFlow viewport zoom level.
 *
 * Updated from the UnifiedCanvas component via useViewport().
 * Consumed by RoomNode for LOD rendering.
 */

import { create } from "zustand";

interface ZoomState {
  /** Current viewport zoom level (default 1.0). */
  zoom: number;
  /** Update the zoom level. Called from UnifiedCanvas on viewport changes. */
  setZoom: (z: number) => void;
}

/**
 * Zustand store for the current viewport zoom level.
 * Used by custom nodes to implement level-of-detail rendering.
 */
export const useZoom = create<ZoomState>((set) => ({
  zoom: 1.0,
  setZoom: (z: number) => set({ zoom: z }),
}));
