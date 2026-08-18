// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * WorldRing — SVG overlay rendering a world boundary with the world
 * name and live stats (rooms · entities · events/s) labeled.
 *
 * Previously rendered a spinning outer ring, a counter-spinning inner
 * ring, a notch ring, and two sonar pulses — all purely decorative
 * motion whose only information was "the world is busy." That signal
 * now lives in the bottom-right stats label literally, plus a single
 * data-coupled cue: the ring's opacity gently breathes at a cadence
 * tied to total events/sec. Quiet world = slow drift; busy world =
 * faster pulse. Same geometric framing, content over motion.
 */

import { useViewport } from "@xyflow/react";
import { motion } from "motion/react";
import { memo, useMemo } from "react";
import { useActivity } from "../hooks/use-activity";
import { worldBounds } from "../lib/layout-utils";

interface WorldRingProps {
  /** World display name. */
  worldName: string;
  /** Total number of entities in the world. */
  entityCount: number;
  /** ALL node positions (rooms + canvas nodes) for bounding computation. */
  allPositions: { x: number; y: number }[];
}

/**
 * SVG overlay that renders spinning concentric rings around the world.
 * Positioned behind ReactFlow nodes via z-index and pointer-events: none.
 * Ring speed driven by total system events/sec.
 */
export const WorldRing = memo(function WorldRing({
  worldName,
  entityCount,
  allPositions,
}: WorldRingProps) {
  const { x: vpX, y: vpY, zoom } = useViewport();

  // Compute world bounds — visual extent already included, just add breathing room
  const bounds = useMemo(() => worldBounds(allPositions, 80), [allPositions]);

  // Read total events/sec from activity store
  const totalEventsPerSecFn = useActivity((s) => s.totalEventsPerSec);
  const totalEventsPerSec = totalEventsPerSecFn();

  const roomCount = allPositions.length;
  if (roomCount === 0) return null;

  const { cx, cy, radius } = bounds;
  const outerR = radius;

  // Transform from flow coordinates to screen coordinates
  const screenCx = cx * zoom + vpX;
  const screenCy = cy * zoom + vpY;
  const screenOuterR = outerR * zoom;

  // Don't render if too zoomed out (boundary too small to be meaningful)
  if (screenOuterR < 30) return null;

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
      width="100%"
      height="100%"
      role="presentation"
    >
      <defs>
        <filter id="uc-glow-lg" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Ambient glow fill — depth cue, not decoration */}
      <ellipse
        cx={screenCx}
        cy={screenCy}
        rx={screenOuterR}
        ry={screenOuterR}
        fill="#FFDD00"
        opacity={0.008}
        filter="url(#uc-glow-lg)"
      />

      {/* Outer ring — static geometry, opacity breathes in time with the
          world's overall activity. Idle ≈ 6s drift, busy ≈ 1s pulse. */}
      <motion.ellipse
        cx={screenCx}
        cy={screenCy}
        rx={screenOuterR}
        ry={screenOuterR}
        fill="none"
        stroke="#FFDD00"
        strokeWidth={Math.max(1.5, 2.5 * zoom)}
        strokeDasharray="14 8"
        animate={{ opacity: [0.22, 0.36, 0.22] }}
        transition={{
          duration: Math.max(1, 6 - Math.min(totalEventsPerSec, 5)),
          repeat: Number.POSITIVE_INFINITY,
          ease: "easeInOut",
        }}
      />

      {/* World name label at top */}
      {screenOuterR > 60 && (
        <text
          x={screenCx}
          y={screenCy - screenOuterR - 18 * zoom}
          textAnchor="middle"
          fontFamily="monospace"
          fontSize={Math.max(10, 14 * zoom)}
          fontWeight="bold"
          fill="#FFDD00"
          opacity={0.4}
          letterSpacing={4}
        >
          {worldName.toUpperCase()}
        </text>
      )}

      {/* Stats label at bottom — live counts */}
      {screenOuterR > 60 && (
        <text
          x={screenCx}
          y={screenCy + screenOuterR + 22 * zoom}
          textAnchor="middle"
          fontFamily="monospace"
          fontSize={Math.max(8, 12 * zoom)}
          fill="#FFDD00"
          opacity={0.25}
        >
          {roomCount} rooms &middot; {entityCount} entities &middot; {totalEventsPerSec.toFixed(1)}{" "}
          evt/s
        </text>
      )}
    </svg>
  );
});
