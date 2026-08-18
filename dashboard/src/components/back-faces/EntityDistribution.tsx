// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { motion } from "motion/react";
import { useWorldState } from "../../hooks/use-world-state";
import { AnimatedSvgNumber } from "../AnimatedNumber";

const KIND_COLORS: Record<string, string> = {
  agent: "var(--color-primary)",
  npc: "var(--color-warning)",
  object: "var(--color-text-dim)",
};

export function EntityDistribution() {
  const entities = useWorldState((s) => s.entities);

  // Kind distribution
  const kindCounts = new Map<string, number>();
  for (const e of entities) {
    kindCounts.set(e.kind, (kindCounts.get(e.kind) ?? 0) + 1);
  }
  const kindEntries = [...kindCounts.entries()].sort((a, b) => b[1] - a[1]);
  const maxKind = Math.max(1, kindEntries[0]?.[1] ?? 1);

  // Room distribution (top 5)
  const roomCounts = new Map<string, number>();
  for (const e of entities) {
    const short = e.room.split("/")[1] ?? e.room;
    roomCounts.set(short, (roomCounts.get(short) ?? 0) + 1);
  }
  const roomEntries = [...roomCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxRoom = Math.max(1, roomEntries[0]?.[1] ?? 1);

  const barH = 14;
  const gap = 4;
  const labelW = 60;
  const barMaxW = 120;

  return (
    <div className="flex h-full flex-col p-2">
      <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">
        Entity Distribution
      </div>
      <svg
        viewBox="0 0 220 180"
        className="h-full w-full"
        role="img"
        aria-label="Entity distribution chart"
      >
        {/* Kind distribution */}
        <text
          x={4}
          y={12}
          fill="var(--color-primary)"
          fontSize={8}
          fontFamily="Orbitron, monospace"
          fontWeight={600}
        >
          By Kind
        </text>
        {kindEntries.map(([kind, count], i) => {
          const y = 20 + i * (barH + gap);
          const w = (count / maxKind) * barMaxW;
          const color = KIND_COLORS[kind] ?? "var(--color-text-dim)";
          return (
            <g key={kind}>
              <text
                x={labelW - 4}
                y={y + barH / 2 + 3}
                textAnchor="end"
                fill="var(--color-text-dim)"
                fontSize={7}
                fontFamily="Share Tech Mono, monospace"
              >
                {kind}
              </text>
              <motion.rect
                x={labelW}
                y={y}
                height={barH}
                rx={2}
                fill={color}
                opacity={0.7}
                initial={{ scaleX: 0, opacity: 0 }}
                animate={{ width: w, scaleX: 1, opacity: 0.7 }}
                transition={{
                  width: { type: "spring", stiffness: 200, damping: 24 },
                  scaleX: { duration: 0.45, ease: "easeOut", delay: i * 0.06 },
                  opacity: { duration: 0.45, delay: i * 0.06 },
                }}
                style={{
                  transformOrigin: `${labelW}px ${y + barH / 2}px`,
                }}
              />
              <AnimatedSvgNumber
                value={count}
                x={labelW + w + 4}
                y={y + barH / 2 + 3}
                fill="var(--color-text)"
                fontSize={7}
                fontFamily="Share Tech Mono, monospace"
              />
            </g>
          );
        })}

        {/* Room distribution */}
        <text
          x={4}
          y={85}
          fill="var(--color-secondary)"
          fontSize={8}
          fontFamily="Orbitron, monospace"
          fontWeight={600}
        >
          Top Rooms
        </text>
        {roomEntries.map(([room, count], i) => {
          const y = 93 + i * (barH + gap);
          const w = (count / maxRoom) * barMaxW;
          return (
            <g key={room}>
              <text
                x={labelW - 4}
                y={y + barH / 2 + 3}
                textAnchor="end"
                fill="var(--color-text-dim)"
                fontSize={7}
                fontFamily="Share Tech Mono, monospace"
              >
                {room}
              </text>
              <motion.rect
                x={labelW}
                y={y}
                height={barH}
                rx={2}
                fill="var(--color-secondary)"
                opacity={0.6}
                initial={{ scaleX: 0, opacity: 0 }}
                animate={{ width: w, scaleX: 1, opacity: 0.6 }}
                transition={{
                  width: { type: "spring", stiffness: 200, damping: 24 },
                  scaleX: { duration: 0.45, ease: "easeOut", delay: i * 0.06 },
                  opacity: { duration: 0.45, delay: i * 0.06 },
                }}
                style={{
                  transformOrigin: `${labelW}px ${y + barH / 2}px`,
                }}
              />
              <AnimatedSvgNumber
                value={count}
                x={labelW + w + 4}
                y={y + barH / 2 + 3}
                fill="var(--color-text)"
                fontSize={7}
                fontFamily="Share Tech Mono, monospace"
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
