// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Layout utility functions for the unified canvas-map view.
 *
 * Provides geometric helpers for distributing canvas nodes around rooms,
 * resolving overlaps via collision repulsion, and computing world bounds.
 *
 * The primary layout is grid-aware: rooms with parseable grid coordinates
 * (e.g. "world/2-3" → row 2, col 3) are placed in a proper spatial grid
 * where north=up, south=down, east=right, west=left. Non-grid districts
 * are clustered near their entry points on the grid.
 *
 * Visual footprint: each RoomNode renders a 500x500 SVG positioned at
 * left:-190, top:-190 from a 120x120 container. All spacing must account
 * for this ~500px visual diameter per room.
 */

/** A positioned item with an x,y coordinate. */
interface Positioned {
  x: number;
  y: number;
}

/** Room info needed for layout. */
interface LayoutRoom {
  id: string;
  exits: Record<string, string>;
  throughput?: number;
}

/**
 * Minimum distance between room centers to avoid visual overlap.
 * RoomNode SVG is 500px wide, but we can tolerate slight ring overlap.
 */
const MIN_ROOM_DISTANCE = 420;

/** Parse grid coordinates from a room ID like "world/2-3" → { row: 2, col: 3 }. */
function parseGridCoord(id: string): { row: number; col: number } | null {
  const after = id.split("/")[1];
  if (!after) return null;
  const m = after.match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  return { row: Number(m[1]), col: Number(m[2]) };
}

/**
 * Grid-aware layout for rooms.
 *
 * Strategy:
 * 1. Parse grid coordinates from room IDs in the start district (default "world").
 *    Place grid rooms in a proper 5x5 (or NxM) spatial grid with sufficient spacing.
 * 2. Identify non-grid district clusters and their grid entry points
 *    (rooms that have an "enter" exit leading to the district).
 * 3. Place each district cluster near its entry point, offset outward from
 *    the grid center. Ring radius scales with cluster size so rooms don't overlap.
 * 4. Mode rooms (no grid anchor) go in a ring around the periphery.
 * 5. Final collision repulsion pass ensures no remaining overlaps.
 *
 * @param rooms - Array of rooms with exits.
 * @param _iterations - Unused (kept for API compatibility).
 * @param startDistrict - District prefix for grid rooms (default "world").
 * @returns Map of room ID -> {x, y} position.
 */
export function forceDirectedLayout(
  rooms: LayoutRoom[],
  _iterations = 80,
  startDistrict = "world",
  positionMap?: Record<string, { row: number; col: number }> | null,
): Record<string, { x: number; y: number }> {
  if (rooms.length === 0) return {};

  const positions: Record<string, { x: number; y: number }> = {};
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  // ── Step 1: Separate grid rooms from non-grid rooms ───────────────────
  const gridCoords = new Map<string, { row: number; col: number }>();
  const nonGridRooms: LayoutRoom[] = [];

  // Use explicit position map if provided (semantic room IDs)
  if (positionMap) {
    for (const [id, coord] of Object.entries(positionMap)) {
      gridCoords.set(id, coord);
    }
  }

  for (const room of rooms) {
    if (gridCoords.has(room.id)) continue; // already mapped
    const district = room.id.split("/")[0] ?? "";
    if (district === startDistrict) {
      const coord = parseGridCoord(room.id);
      if (coord) {
        gridCoords.set(room.id, coord);
        continue;
      }
    }
    nonGridRooms.push(room);
  }

  // ── Step 2: Place grid rooms in a proper spatial grid ─────────────────
  // 600px between centers — each room's 500px SVG gets 100px clearance
  const GRID_SPACING = 450;

  if (gridCoords.size > 0) {
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

    // Center the grid at (0,0) — ReactFlow's fitView will handle viewport
    const centerRow = (minRow + maxRow) / 2;
    const centerCol = (minCol + maxCol) / 2;

    for (const [id, { row, col }] of gridCoords) {
      positions[id] = {
        x: (col - centerCol) * GRID_SPACING,
        y: (row - centerRow) * GRID_SPACING,
      };
    }
  }

  // ── Step 3: Find grid entry points for each district ──────────────────
  const districtEntryPoints = new Map<string, { x: number; y: number }>();

  for (const [gridId] of gridCoords) {
    const room = roomById.get(gridId);
    if (!room) continue;
    for (const [exitName, targetId] of Object.entries(room.exits)) {
      const targetDistrict = targetId.split("/")[0] ?? "";
      if (targetDistrict !== startDistrict && exitName === "enter") {
        const gridPos = positions[gridId];
        if (gridPos) {
          districtEntryPoints.set(targetDistrict, gridPos);
        }
      }
    }
  }

  // ── Step 4: Group non-grid rooms by district ──────────────────────────
  const districtGroups = new Map<string, LayoutRoom[]>();
  for (const room of nonGridRooms) {
    const district = room.id.split("/")[0] ?? "_other";
    if (!districtGroups.has(district)) districtGroups.set(district, []);
    districtGroups.get(district)!.push(room);
  }

  // ── Step 5: Position each district cluster ────────────────────────────
  const gridCenter = { x: 0, y: 0 };
  let unanchoredIndex = 0;

  for (const [district, clusterRooms] of districtGroups) {
    const entryPos = districtEntryPoints.get(district);

    if (entryPos) {
      // Direction from grid center to entry point — offset cluster further out
      let dx = entryPos.x - gridCenter.x;
      let dy = entryPos.y - gridCenter.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= dist;
      dy /= dist;

      // Ring radius scales with number of spoke rooms so they don't overlap:
      // circumference = N * MIN_ROOM_DISTANCE, radius = circumference / (2π)
      const spokeCount = Math.max(0, clusterRooms.length - 1); // minus hub
      const ringR = spokeCount <= 1 ? 0 : (spokeCount * MIN_ROOM_DISTANCE) / (2 * Math.PI);

      // Cluster hub offset: clear the grid edge + ring radius + buffer
      const clusterOffset = GRID_SPACING + ringR + MIN_ROOM_DISTANCE * 0.5;
      const clusterCx = entryPos.x + dx * clusterOffset;
      const clusterCy = entryPos.y + dy * clusterOffset;

      // Find the hub room (the one connected to the grid via "enter" exit)
      const hubId =
        clusterRooms.find((r) => {
          for (const [gridId] of gridCoords) {
            const gridRoom = roomById.get(gridId);
            if (gridRoom && Object.values(gridRoom.exits).includes(r.id)) return true;
          }
          return false;
        })?.id ?? clusterRooms[0]?.id;

      if (clusterRooms.length === 1) {
        positions[clusterRooms[0]!.id] = { x: clusterCx, y: clusterCy };
      } else if (clusterRooms.length === 2) {
        // Two rooms: hub at center, other offset perpendicular
        const perpX = -dy;
        const perpY = dx;
        positions[hubId!] = { x: clusterCx, y: clusterCy };
        const other = clusterRooms.find((r) => r.id !== hubId)!;
        positions[other.id] = {
          x: clusterCx + perpX * MIN_ROOM_DISTANCE * 0.5 + dx * MIN_ROOM_DISTANCE * 0.3,
          y: clusterCy + perpY * MIN_ROOM_DISTANCE * 0.5 + dy * MIN_ROOM_DISTANCE * 0.3,
        };
      } else {
        // Hub-and-spoke: hub at center, others in a ring
        positions[hubId!] = { x: clusterCx, y: clusterCy };
        const nonHub = clusterRooms.filter((r) => r.id !== hubId);
        const actualRingR = Math.max(ringR, MIN_ROOM_DISTANCE);

        for (let i = 0; i < nonHub.length; i++) {
          const room = nonHub[i]!;
          const angle = (2 * Math.PI * i) / nonHub.length - Math.PI / 2;
          positions[room.id] = {
            x: clusterCx + Math.cos(angle) * actualRingR,
            y: clusterCy + Math.sin(angle) * actualRingR,
          };
        }
      }
    } else {
      // No grid anchor (e.g. mode rooms) — place in a ring far from the grid
      const totalUnanchored = [...districtGroups.entries()].filter(
        ([d]) => !districtEntryPoints.has(d),
      ).length;

      // Place each unanchored district in its own angular sector
      const baseAngle =
        (2 * Math.PI * unanchoredIndex) / Math.max(1, totalUnanchored) - Math.PI * 0.75;
      unanchoredIndex++;

      // Ring radius around the grid: just outside the furthest grid room
      const gridExtent = gridCoords.size > 0 ? GRID_SPACING * 3.5 : 800;
      const clusterCx = Math.cos(baseAngle) * gridExtent;
      const clusterCy = Math.sin(baseAngle) * gridExtent;

      // Ring radius for rooms within this cluster
      const innerRingR =
        clusterRooms.length <= 1 ? 0 : (clusterRooms.length * MIN_ROOM_DISTANCE) / (2 * Math.PI);

      for (let i = 0; i < clusterRooms.length; i++) {
        const room = clusterRooms[i]!;
        if (clusterRooms.length === 1) {
          positions[room.id] = { x: clusterCx, y: clusterCy };
        } else {
          const angle = (2 * Math.PI * i) / clusterRooms.length - Math.PI / 2;
          positions[room.id] = {
            x: clusterCx + Math.cos(angle) * innerRingR,
            y: clusterCy + Math.sin(angle) * innerRingR,
          };
        }
      }
    }
  }

  // ── Step 6: Final collision repulsion pass ────────────────────────────
  // Convert positions to array, run collision resolution, write back
  const ids = Object.keys(positions);
  const posArray: Positioned[] = ids.map((id) => ({ ...positions[id]! }));
  collisionRepulse(posArray, 8, MIN_ROOM_DISTANCE);
  for (let i = 0; i < ids.length; i++) {
    positions[ids[i]!] = posArray[i]!;
  }

  return positions;
}

/**
 * Compute x,y position for an item distributed evenly around a circle.
 *
 * @param index - Which item in the ring (0-based).
 * @param total - Total number of items in the ring.
 * @param radius - Radius of the ring.
 * @returns Position offset from the ring center.
 */
export function ringPosition(
  index: number,
  total: number,
  radius: number,
): { x: number; y: number } {
  if (total <= 0) return { x: 0, y: 0 };
  const angle = -Math.PI * 0.6 + (2 * Math.PI * index) / total;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}

/**
 * Push overlapping nodes apart via iterative collision repulsion.
 *
 * Mutates positions in-place within the provided array. Each node is treated
 * as a circle with the given radius for collision purposes.
 *
 * @param nodes - Array of positioned items to adjust.
 * @param iterations - Number of repulsion passes (default 4).
 * @param minDistance - Minimum distance between node centers (default 80).
 */
export function collisionRepulse(nodes: Positioned[], iterations = 4, minDistance = 80): void {
  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;

        if (dist < minDistance) {
          const push = (minDistance - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;
          a.x -= nx * push;
          a.y -= ny * push;
          b.x += nx * push;
          b.y += ny * push;
        }
      }
    }
  }
}

/**
 * Lightweight force-lite layout for the knowledge graph. Places notes in a
 * deterministic spiral offset from the world-map center, then nudges linked
 * notes toward each other and repulses colliders.
 *
 * Deterministic on note id + link set — positions stay stable across re-renders
 * unless new nodes/links arrive. Cheap enough to recompute on snapshot + event
 * bursts (target: <10ms for ~500 notes, ~1000 links).
 */
export function computeNoteLayout(
  notes: { id: number; importance: number }[],
  links: { sourceId: number; targetId: number }[],
  opts?: {
    center?: { x: number; y: number };
    baseRadius?: number;
    existing?: Map<number, { x: number; y: number }>;
  },
): Map<number, { x: number; y: number }> {
  const center = opts?.center ?? { x: 0, y: 3200 };
  const baseRadius = opts?.baseRadius ?? 400;
  const existing = opts?.existing;
  const positions = new Map<number, { x: number; y: number }>();

  // Phase 1: seed positions. Reuse existing coordinates so nodes don't jump
  // when new events arrive; new nodes land on a deterministic spiral.
  const SPIRAL_STEP = 35;
  let newIdx = 0;
  for (const n of notes) {
    const prior = existing?.get(n.id);
    if (prior) {
      positions.set(n.id, { ...prior });
      continue;
    }
    // Spiral around center; higher-importance notes closer to the core.
    const ring = baseRadius + Math.sqrt(newIdx) * SPIRAL_STEP * 2.5;
    const theta = newIdx * 0.618 * Math.PI * 2;
    const impOffset = (10 - n.importance) * 18;
    positions.set(n.id, {
      x: center.x + Math.cos(theta) * (ring + impOffset),
      y: center.y + Math.sin(theta) * (ring + impOffset),
    });
    newIdx++;
  }

  // Phase 2: attraction along links — pull linked notes toward each other.
  const ATTRACT_ITER = 4;
  const ATTRACT_K = 0.08;
  const TARGET_LINK_LEN = 110;
  for (let iter = 0; iter < ATTRACT_ITER; iter++) {
    for (const l of links) {
      const a = positions.get(l.sourceId);
      const b = positions.get(l.targetId);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const delta = (dist - TARGET_LINK_LEN) * ATTRACT_K;
      const nx = dx / dist;
      const ny = dy / dist;
      a.x += nx * delta;
      a.y += ny * delta;
      b.x -= nx * delta;
      b.y -= ny * delta;
    }
  }

  // Phase 3: collision repulsion so notes don't stack.
  const posArray: Positioned[] = [];
  const idList: number[] = [];
  for (const [id, p] of positions) {
    idList.push(id);
    posArray.push(p);
  }
  collisionRepulse(posArray, 5, 55);
  for (let i = 0; i < idList.length; i++) {
    positions.set(idList[i]!, posArray[i]!);
  }

  return positions;
}

/**
 * Compute the bounding center and radius that encompasses all room positions.
 * Accounts for asymmetric room visual extent: rooms extend ~200px above
 * their position (column/status) and ~100px below (ring/glow base).
 *
 * @param rooms - Array of room positions.
 * @param padding - Extra padding added to the computed radius (default 120).
 * @returns Center point and radius of the bounding circle.
 */
export function worldBounds(
  rooms: Positioned[],
  padding = 120,
): { cx: number; cy: number; radius: number } {
  if (rooms.length === 0) {
    return { cx: 0, cy: 0, radius: 200 };
  }

  // Compute visual bounding box (positions + asymmetric room extent)
  const extentUp = 200; // column + status node above position
  const extentDown = 120; // ring/glow below position
  const extentSide = 150; // ring width on each side

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const r of rooms) {
    minX = Math.min(minX, r.x - extentSide);
    maxX = Math.max(maxX, r.x + extentSide);
    minY = Math.min(minY, r.y - extentUp);
    maxY = Math.max(maxY, r.y + extentDown);
  }

  // Center of the visual bounding box (not geometric center of positions)
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Radius: half the diagonal of the visual bounding box
  const halfW = (maxX - minX) / 2;
  const halfH = (maxY - minY) / 2;
  const radius = Math.sqrt(halfW * halfW + halfH * halfH) + padding;

  return { cx, cy, radius };
}
