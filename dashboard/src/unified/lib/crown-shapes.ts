// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * District color mappings for room nodes. The district is derived from the
 * room ID prefix; unknown districts fall back to gold.
 */

/** Map from district name to hex color. */
export const DISTRICT_COLORS: Record<string, string> = {
  // Original design districts
  core: "#FFDD00",
  build: "#FFB800",
  knowledge: "#22c55e",
  exchange: "#FF9500",
  organic: "#555555",
  sense: "#FFB800",
  // Marina showcase-grid districts (derived from room ID prefix)
  world: "#FFDD00", // gold — hub/grid rooms
  mode: "#06b6d4", // cyan — agent mode rooms
  craft: "#FFB800", // amber — craft/build rooms
  demo: "#22c55e", // green — demo rooms
  demos: "#22c55e", // green — demo rooms (plural)
  market: "#FF9500", // orange — market rooms
  markets: "#FF9500", // orange — market rooms (plural)
  evolve: "#8b5cf6", // violet — benchmark/evolve rooms
  bench: "#8b5cf6", // violet — benchmark rooms
};

/** Get the color for a district, falling back to a dim gray. */
export function getDistrictColor(district: string): string {
  return DISTRICT_COLORS[district] ?? "#FFDD00"; // Default to gold, not grey
}
