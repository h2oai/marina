// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { motion } from "motion/react";
import { useWorldState } from "../../hooks/use-world-state";
import { AnimatedSvgNumber } from "../AnimatedNumber";

const EVENT_COLORS: Record<string, string> = {
  command: "var(--color-primary)",
  entity_enter: "var(--color-secondary)",
  entity_leave: "var(--color-secondary)",
  connect: "var(--color-success)",
  disconnect: "var(--color-danger)",
  task_claimed: "var(--color-accent)",
  task_submitted: "var(--color-pink)",
  task_approved: "var(--color-warning)",
};

export function EventDistribution() {
  const eventFeed = useWorldState((s) => s.eventFeed);

  // Count by event type
  const typeCounts = new Map<string, number>();
  for (const ev of eventFeed) {
    typeCounts.set(ev.type, (typeCounts.get(ev.type) ?? 0) + 1);
  }

  const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const maxCount = Math.max(1, sorted[0]?.[1] ?? 1);

  const barH = 14;
  const gap = 4;
  const labelW = 90;
  const barMaxW = 160;
  const totalH = sorted.length * (barH + gap) + 20;

  return (
    <div className="flex h-full flex-col p-2">
      <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">
        Event Distribution
      </div>
      <svg
        viewBox={`0 0 280 ${totalH}`}
        className="h-full w-full"
        role="img"
        aria-label="Event distribution chart"
      >
        {sorted.map(([type, count], i) => {
          const y = i * (barH + gap) + 4;
          const w = (count / maxCount) * barMaxW;
          const color = EVENT_COLORS[type] ?? "var(--color-text-dim)";
          return (
            <g key={type}>
              <text
                x={labelW - 4}
                y={y + barH / 2 + 3}
                textAnchor="end"
                fill="var(--color-text-dim)"
                fontSize={7}
                fontFamily="Share Tech Mono, monospace"
              >
                {type.replace(/_/g, " ")}
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
                  scaleX: { duration: 0.4, ease: "easeOut", delay: i * 0.05 },
                  opacity: { duration: 0.4, delay: i * 0.05 },
                }}
                style={{ transformOrigin: `${labelW}px ${y + barH / 2}px` }}
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
