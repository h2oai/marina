// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Dynamic room layout engine for the world map SVG.
// Computes positions from live room data — no hardcoded grid.
// Coordinates target a virtual 1000×750 space.

export interface RoomPosition {
  id: string;
  x: number;
  y: number;
  district: string;
}

export interface RoomEdge {
  from: string;
  to: string;
  crossDistrict: boolean;
  /** Both endpoints are grid-positioned rooms */
  gridEdge: boolean;
  /** Both rooms have reciprocal exits to each other */
  bidirectional: boolean;
  /** Grid edge between cardinally adjacent rooms (row/col diff = 1) */
  adjacent: boolean;
}

export interface RoomInput {
  id: string;
  short: string;
  district: string;
  exits: Record<string, string>;
}

// ── District colors — dynamic palette, theme-aware ───────────────────────────

import { DEFAULT_THEME, themes } from "./themes";

function getActivePalette(): string[] {
  const themeId = document.documentElement.getAttribute("data-theme") ?? DEFAULT_THEME;
  return (themes[themeId] ?? themes[DEFAULT_THEME]!).districtPalette;
}

let districtColorCache = new Map<string, string>();
let cachedThemeId: string | null = null;

export function getDistrictColor(district: string): string {
  const currentTheme = document.documentElement.getAttribute("data-theme") ?? DEFAULT_THEME;
  if (currentTheme !== cachedThemeId) {
    districtColorCache = new Map();
    cachedThemeId = currentTheme;
  }
  let color = districtColorCache.get(district);
  if (!color) {
    const palette = getActivePalette();
    const idx = districtColorCache.size % palette.length;
    color = palette[idx]!;
    districtColorCache.set(district, color);
  }
  return color;
}

export function getDistrictLabel(district: string): string {
  return district.toUpperCase();
}

// ── Layout ───────────────────────────────────────────────────────────────────

/** Try to parse a grid coordinate from room ID like "world/2-3" */
function parseGridCoord(id: string): { row: number; col: number } | null {
  const after = id.split("/")[1];
  if (!after) return null;
  const m = after.match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  return { row: Number(m[1]), col: Number(m[2]) };
}

// Virtual canvas center
const CX = 500;
const CY = 375;

/**
 * Compute positions for all rooms.
 *
 * Strategy:
 *  1. Parse grid coordinates from room IDs (e.g. "world/2-3" → row 2, col 3).
 *  2. Place ALL grid-parseable rooms in their proper grid positions —
 *     even if some rooms are non-grid (mixed layout).
 *  3. Place remaining non-grid rooms radially around their connected
 *     grid neighbours (or BFS from startRoom if fully non-grid).
 */
export function computeLayout(
  rooms: RoomInput[],
  startRoom?: string,
): { positions: RoomPosition[]; edges: RoomEdge[] } {
  if (rooms.length === 0) return { positions: [], edges: [] };

  // Reset color cache for fresh layout
  districtColorCache.clear();

  // ── Separate grid vs non-grid rooms ────────────────────────────────
  // Only rooms in the start room's district participate in grid layout.
  // This prevents e.g. "sanctum/2-2" from overlapping "world/2-2".
  const startDistrict = startRoom?.split("/")[0] ?? "";
  const gridCoords = new Map<string, { row: number; col: number }>();
  const nonGridRooms: RoomInput[] = [];

  for (const room of rooms) {
    const district = room.id.split("/")[0] ?? "";
    const coord = district === startDistrict ? parseGridCoord(room.id) : null;
    if (coord) {
      gridCoords.set(room.id, coord);
    } else {
      nonGridRooms.push(room);
    }
  }

  const posMap = new Map<string, RoomPosition>();

  if (gridCoords.size > 0) {
    // ── Place grid rooms at their proper positions ─────────────────────
    let minRow = Number.POSITIVE_INFINITY;
    let maxRow = Number.NEGATIVE_INFINITY;
    let minCol = Number.POSITIVE_INFINITY;
    let maxCol = Number.NEGATIVE_INFINITY;
    for (const { row, col } of gridCoords.values()) {
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
      minCol = Math.min(minCol, col);
      maxCol = Math.max(maxCol, col);
    }
    const numRows = maxRow - minRow + 1;
    const numCols = maxCol - minCol + 1;

    // Fill available space (leaving margin for labels and non-grid rooms)
    const spacingX = numCols > 1 ? 700 / (numCols - 1) : 0;
    const spacingY = numRows > 1 ? 550 / (numRows - 1) : 0;
    const totalW = (numCols - 1) * (spacingX || 150);
    const totalH = (numRows - 1) * (spacingY || 150);
    const offsetX = CX - totalW / 2;
    const offsetY = CY - totalH / 2;

    for (const room of rooms) {
      const coord = gridCoords.get(room.id);
      if (!coord) continue;
      posMap.set(room.id, {
        id: room.id,
        x: offsetX + (coord.col - minCol) * (spacingX || 150),
        y: offsetY + (coord.row - minRow) * (spacingY || 150),
        district: room.district,
      });
    }

    // ── Place non-grid rooms relative to their connected grid rooms ───
    if (nonGridRooms.length > 0) {
      // Build adjacency from exits
      const roomById = new Map(rooms.map((r) => [r.id, r]));
      const placed = new Set(posMap.keys());
      const pending = [...nonGridRooms];
      let iterations = 0;

      while (pending.length > 0 && iterations < 20) {
        iterations++;
        const still: RoomInput[] = [];

        for (const room of pending) {
          // Find a placed neighbour to anchor to
          let anchorX = 0;
          let anchorY = 0;
          let anchorCount = 0;

          // Check this room's exits
          for (const target of Object.values(room.exits)) {
            const p = posMap.get(target);
            if (p) {
              anchorX += p.x;
              anchorY += p.y;
              anchorCount++;
            }
          }
          // Check rooms that exit to this room
          for (const [id, r] of roomById) {
            if (placed.has(id) && Object.values(r.exits).includes(room.id)) {
              const p = posMap.get(id)!;
              anchorX += p.x;
              anchorY += p.y;
              anchorCount++;
            }
          }

          if (anchorCount > 0) {
            // Place near average of connected placed rooms, offset outward
            const ax = anchorX / anchorCount;
            const ay = anchorY / anchorCount;
            let dx = ax - CX;
            let dy = ay - CY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const push = 120;

            if (dist < 1) {
              // Anchor is at dead center — assign a unique angle to avoid
              // overlapping the center room
              const idx = placed.size;
              const angle = (2 * Math.PI * idx) / 8 - Math.PI / 2;
              dx = Math.cos(angle);
              dy = Math.sin(angle);
            } else {
              dx /= dist;
              dy /= dist;
            }

            posMap.set(room.id, {
              id: room.id,
              x: ax + dx * push,
              y: ay + dy * push,
              district: room.district,
            });
            placed.add(room.id);
          } else {
            still.push(room);
          }
        }

        if (still.length === pending.length) break; // no progress
        pending.length = 0;
        pending.push(...still);
      }

      // Any remaining unplaced: ring around the periphery
      if (pending.length > 0) {
        const ringR = Math.max(totalW, totalH) / 2 + 100;
        for (let i = 0; i < pending.length; i++) {
          const angle = (2 * Math.PI * i) / pending.length - Math.PI / 2;
          const room = pending[i]!;
          posMap.set(room.id, {
            id: room.id,
            x: CX + Math.cos(angle) * ringR,
            y: CY + Math.sin(angle) * ringR,
            district: room.district,
          });
        }
      }
    }
  } else {
    // ── Fully non-grid: BFS radial from startRoom ─────────────────────
    const adjacency = new Map<string, string[]>();
    for (const room of rooms) {
      adjacency.set(room.id, Object.values(room.exits));
    }

    const root = startRoom && rooms.some((r) => r.id === startRoom) ? startRoom : rooms[0]!.id;

    const visited = new Set<string>();
    const layers: string[][] = [];
    const queue: string[] = [root];
    visited.add(root);

    while (queue.length > 0) {
      const layer = [...queue];
      layers.push(layer);
      queue.length = 0;
      for (const id of layer) {
        for (const neighbor of adjacency.get(id) ?? []) {
          if (!visited.has(neighbor) && rooms.some((r) => r.id === neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }

    // Disconnected rooms
    for (const room of rooms) {
      if (!visited.has(room.id)) {
        layers.push([room.id]);
        visited.add(room.id);
      }
    }

    // Place root at center
    posMap.set(root, {
      id: root,
      x: CX,
      y: CY,
      district: rooms.find((r) => r.id === root)?.district ?? "",
    });

    // Radial placement
    for (let li = 1; li < layers.length; li++) {
      const layer = layers[li]!;
      const radius = li * 100;
      for (let ni = 0; ni < layer.length; ni++) {
        const angle = (2 * Math.PI * ni) / layer.length - Math.PI / 2;
        const id = layer[ni]!;
        posMap.set(id, {
          id,
          x: CX + Math.cos(angle) * radius,
          y: CY + Math.sin(angle) * radius,
          district: rooms.find((r) => r.id === id)?.district ?? "",
        });
      }
    }
  }

  // ── Build edges ──────────────────────────────────────────────────────
  const gridRoomIds = new Set(gridCoords.keys());

  // First pass: collect all directed exit pairs for bidirectional check
  const exitPairs = new Set<string>();
  for (const room of rooms) {
    for (const target of Object.values(room.exits)) {
      exitPairs.add(`${room.id}\0${target}`);
    }
  }

  const edgeSet = new Set<string>();
  const edges: RoomEdge[] = [];
  for (const room of rooms) {
    const srcDistrict = room.id.split("/")[0]!;
    for (const target of Object.values(room.exits)) {
      const tgtDistrict = target.split("/")[0]!;
      const key = [room.id, target].sort().join("|");
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        const bothGrid = gridRoomIds.has(room.id) && gridRoomIds.has(target);

        // Check if rooms are cardinally adjacent on the grid
        let adjacent = false;
        if (bothGrid) {
          const coordA = gridCoords.get(room.id);
          const coordB = gridCoords.get(target);
          if (coordA && coordB) {
            const dr = Math.abs(coordA.row - coordB.row);
            const dc = Math.abs(coordA.col - coordB.col);
            adjacent = (dr === 1 && dc === 0) || (dr === 0 && dc === 1);
          }
        }

        edges.push({
          from: room.id,
          to: target,
          crossDistrict: srcDistrict !== tgtDistrict,
          gridEdge: bothGrid,
          bidirectional: exitPairs.has(`${target}\0${room.id}`),
          adjacent,
        });
      }
    }
  }

  return { positions: Array.from(posMap.values()), edges };
}
