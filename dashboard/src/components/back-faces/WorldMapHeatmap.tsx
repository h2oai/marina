// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { motion } from "motion/react";
import { useWorldState } from "../../hooks/use-world-state";
import type { WorldData } from "../../lib/types";
import { computeLayout, getDistrictColor } from "../../lib/world-graph";

interface WorldMapHeatmapProps {
  worldData?: WorldData;
}

export function WorldMapHeatmap({ worldData }: WorldMapHeatmapProps) {
  const eventFeed = useWorldState((s) => s.eventFeed);
  const wsRooms = useWorldState((s) => s.rooms);
  const wsStartRoom = useWorldState((s) => s.startRoom);

  const startRoom = wsStartRoom || worldData?.startRoom || "";
  const rooms = wsRooms.length > 0 ? wsRooms : (worldData?.rooms ?? []);
  const { positions } = computeLayout(rooms, startRoom);

  // Count events per room from feed
  const roomEventCounts = new Map<string, number>();
  for (const ev of eventFeed) {
    if (ev.room) {
      roomEventCounts.set(ev.room, (roomEventCounts.get(ev.room) ?? 0) + 1);
    }
  }
  const maxCount = Math.max(1, ...roomEventCounts.values());

  return (
    <div className="flex h-full flex-col p-2">
      <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">Event Heatmap</div>
      <svg viewBox="40 15 920 720" className="h-full w-full" role="img" aria-label="Event heatmap">
        {positions.map((pos, i) => {
          const count = roomEventCounts.get(pos.id) ?? 0;
          const intensity = count / maxCount;
          const color = getDistrictColor(pos.district);
          return (
            <motion.g
              key={pos.id}
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: "easeOut", delay: i * 0.03 }}
              style={{ transformOrigin: `${pos.x}px ${pos.y}px` }}
            >
              <circle cx={pos.x} cy={pos.y} r={18} fill={color} opacity={0.1 + intensity * 0.7} />
              <circle
                cx={pos.x}
                cy={pos.y}
                r={8 + intensity * 10}
                fill={color}
                opacity={0.2 + intensity * 0.5}
              />
              {count > 0 && (
                <text
                  x={pos.x}
                  y={pos.y + 3}
                  textAnchor="middle"
                  fill="var(--color-text)"
                  fontSize={7}
                  fontFamily="Share Tech Mono, monospace"
                >
                  {count}
                </text>
              )}
            </motion.g>
          );
        })}
      </svg>
    </div>
  );
}
