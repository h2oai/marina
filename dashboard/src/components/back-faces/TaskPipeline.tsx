// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { motion } from "motion/react";
import { useSystem } from "../../hooks/use-api";
import { AnimatedSvgNumber } from "../AnimatedNumber";

const STAGES = [
  { key: "open", label: "Open", color: "var(--color-success)" },
  { key: "claimed", label: "Claimed", color: "var(--color-warning)" },
  { key: "submitted", label: "Submitted", color: "var(--color-secondary)" },
  { key: "completed", label: "Done", color: "var(--color-text-dim)" },
] as const;

export function TaskPipeline() {
  const { data: systemData } = useSystem();

  const tasks = systemData?.tasks ?? {
    open: 0,
    claimed: 0,
    submitted: 0,
    completed: 0,
  };
  const values = [tasks.open, tasks.claimed, tasks.submitted, tasks.completed];
  const maxVal = Math.max(1, ...values);

  const barW = 30;
  const gap = 20;
  const maxBarH = 100;
  const startX = 40;
  const baseY = 130;

  return (
    <div className="flex h-full flex-col p-2">
      <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">Task Pipeline</div>
      <svg
        viewBox="0 0 260 160"
        className="h-full w-full"
        role="img"
        aria-label="Task pipeline visualization"
      >
        {STAGES.map((stage, i) => {
          const x = startX + i * (barW + gap);
          const val = values[i]!;
          const h = (val / maxVal) * maxBarH;
          const y = baseY - h;

          return (
            <g key={stage.key}>
              {/* Bar — height/y animate smoothly when counts change */}
              <motion.rect
                x={x}
                width={barW}
                rx={3}
                fill={stage.color}
                opacity={0.7}
                initial={{ scaleY: 0, opacity: 0 }}
                animate={{ y, height: h, scaleY: 1, opacity: 0.7 }}
                transition={{
                  y: { type: "spring", stiffness: 220, damping: 22 },
                  height: { type: "spring", stiffness: 220, damping: 22 },
                  scaleY: { duration: 0.5, ease: "easeOut", delay: i * 0.08 },
                  opacity: { duration: 0.5, delay: i * 0.08 },
                }}
                style={{ transformOrigin: `${x + barW / 2}px ${baseY}px` }}
              />
              {/* Value on top */}
              <AnimatedSvgNumber
                value={val}
                x={x + barW / 2}
                y={y - 4}
                textAnchor="middle"
                fill="var(--color-text)"
                fontSize={9}
                fontFamily="Orbitron, monospace"
                fontWeight={700}
              />
              {/* Label below */}
              <text
                x={x + barW / 2}
                y={baseY + 12}
                textAnchor="middle"
                fill="var(--color-text-dim)"
                fontSize={7}
                fontFamily="Share Tech Mono, monospace"
              >
                {stage.label}
              </text>
              {/* Arrow between stages */}
              {i < STAGES.length - 1 && (
                <text
                  x={x + barW + gap / 2}
                  y={baseY - maxBarH / 2}
                  textAnchor="middle"
                  fill="var(--color-border)"
                  fontSize={12}
                >
                  →
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
