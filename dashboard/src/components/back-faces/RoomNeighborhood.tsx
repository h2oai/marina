// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { motion } from "motion/react";
import { useWorld } from "../../hooks/use-api";
import { useWorldState } from "../../hooks/use-world-state";
import { getDistrictColor } from "../../lib/world-graph";

export function RoomNeighborhood() {
  const selectedRoom = useWorldState((s) => s.selectedRoom);
  const wsRooms = useWorldState((s) => s.rooms);
  const { data: worldData } = useWorld();

  const rooms = wsRooms.length > 0 ? wsRooms : (worldData?.rooms ?? []);
  const roomMap = new Map(rooms.map((r) => [r.id, r]));

  if (!selectedRoom) {
    return (
      <div className="flex h-full items-center justify-center p-2">
        <span className="text-text-dim text-[10px]">Select a room to see neighbors</span>
      </div>
    );
  }

  const center = roomMap.get(selectedRoom);
  if (!center) {
    return (
      <div className="flex h-full items-center justify-center p-2">
        <span className="text-text-dim text-[10px]">Room not found</span>
      </div>
    );
  }

  const neighbors = Object.entries(center.exits).map(([dir, targetId]) => ({
    dir,
    id: targetId,
    room: roomMap.get(targetId),
  }));

  const cx = 130;
  const cy = 80;
  const radius = 55;
  const centerColor = getDistrictColor(center.district);

  // Position neighbors radially
  const dirAngles: Record<string, number> = {
    north: -Math.PI / 2,
    south: Math.PI / 2,
    east: 0,
    west: Math.PI,
    northeast: -Math.PI / 4,
    northwest: (-3 * Math.PI) / 4,
    southeast: Math.PI / 4,
    southwest: (3 * Math.PI) / 4,
    up: -Math.PI / 2,
    down: Math.PI / 2,
  };

  const neighborPositions = neighbors.map((n, i) => {
    const angle = dirAngles[n.dir] ?? (2 * Math.PI * i) / neighbors.length - Math.PI / 2;
    return {
      ...n,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    };
  });

  return (
    <div className="flex h-full flex-col p-2">
      <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">
        Neighborhood: {center.short}
      </div>
      <svg
        viewBox="0 0 260 170"
        className="h-full w-full"
        role="img"
        aria-label="Room neighborhood map"
        // Re-key on selectedRoom so motion replays the entrance per room
        key={selectedRoom}
      >
        {/* Edges */}
        {neighborPositions.map((n, i) => (
          <motion.line
            key={`edge-${n.dir}`}
            x1={cx}
            y1={cy}
            x2={n.x}
            y2={n.y}
            stroke={centerColor}
            strokeWidth={1}
            strokeDasharray="4 3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            transition={{ duration: 0.3, delay: 0.2 + i * 0.04 }}
          />
        ))}

        {/* Center node */}
        <motion.g
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 220, damping: 14 }}
          style={{ transformOrigin: `${cx}px ${cy}px` }}
        >
          <circle
            cx={cx}
            cy={cy}
            r={16}
            fill={centerColor}
            fillOpacity={0.2}
            stroke={centerColor}
            strokeWidth={1.5}
          />
          <text
            x={cx}
            y={cy + 3}
            textAnchor="middle"
            fill={centerColor}
            fontSize={7}
            fontFamily="Share Tech Mono, monospace"
            fontWeight={700}
          >
            {center.short}
          </text>
        </motion.g>

        {/* Neighbor nodes — staggered after the center */}
        {neighborPositions.map((n, i) => {
          const nColor = n.room ? getDistrictColor(n.room.district) : "var(--color-text-dim)";
          return (
            <motion.g
              key={n.dir}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{
                type: "spring",
                stiffness: 220,
                damping: 14,
                delay: 0.1 + i * 0.05,
              }}
              style={{ transformOrigin: `${n.x}px ${n.y}px` }}
            >
              <circle
                cx={n.x}
                cy={n.y}
                r={12}
                fill={nColor}
                fillOpacity={0.15}
                stroke={nColor}
                strokeWidth={1}
              />
              <text
                x={n.x}
                y={n.y - 2}
                textAnchor="middle"
                fill={nColor}
                fontSize={6}
                fontFamily="Share Tech Mono, monospace"
              >
                {n.room?.short ?? n.id.split("/")[1] ?? "?"}
              </text>
              <text
                x={n.x}
                y={n.y + 7}
                textAnchor="middle"
                fill="var(--color-text-dim)"
                fontSize={5}
                fontFamily="Share Tech Mono, monospace"
              >
                {n.dir.slice(0, 2).toUpperCase()}
              </text>
            </motion.g>
          );
        })}
      </svg>
    </div>
  );
}
