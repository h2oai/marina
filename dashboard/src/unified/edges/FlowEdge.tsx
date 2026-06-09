/**
 * Custom ReactFlow edge for room-to-room connections.
 *
 * Visual characteristics:
 * - Dashed line whose offset animates to convey flow direction (disabled under
 *   reduce-motion). The travelling <animateMotion> particle was removed — these
 *   edges are persistent, so the particle ran indefinitely for the whole graph
 *   and was a dominant always-on cost; the dashed flow conveys it far cheaper.
 * - Color derived from source room's district
 * - Width scales with min(source.throughput, target.throughput)
 */

import { type EdgeProps, getBezierPath } from "@xyflow/react";
import { memo } from "react";
import { prefersReducedMotion } from "../../lib/motion-prefs";

/** Short labels for cardinal directions. */
const DIR_LABELS: Record<string, string> = {
  north: "N",
  south: "S",
  east: "E",
  west: "W",
  enter: "ENTER",
  leave: "LEAVE",
  up: "UP",
  down: "DN",
  ne: "NE",
  nw: "NW",
  se: "SE",
  sw: "SW",
};

export interface FlowEdgeData {
  /** District color hex string for the edge. */
  color: string;
  /** Combined throughput metric (min of source and target). */
  throughput: number;
  /** Exit direction (north, south, east, west, enter, etc). */
  direction?: string;
  /** Whether this edge crosses between districts. */
  crossDistrict?: boolean;
}

/**
 * Custom edge component for room-to-room flow connections.
 * Renders an animated dashed bezier path with throughput-scaled width
 * and a particle that travels along the path.
 */
export const FlowEdge = memo(function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const edgeData = data as FlowEdgeData | undefined;
  const color = edgeData?.color ?? "#FFDD00";
  const throughput = edgeData?.throughput ?? 20;
  const direction = edgeData?.direction;
  const crossDistrict = edgeData?.crossDistrict ?? false;
  const dirLabel = direction ? (DIR_LABELS[direction] ?? "") : "";

  // Volume factor for scaling
  const vol = Math.max(10, throughput * 0.5);

  // Width: bold — these are the world's arteries
  const strokeWidth = crossDistrict
    ? Math.max(8, Math.min(14, 8 + throughput * 0.1))
    : Math.max(6, Math.min(10, 6 + throughput * 0.06));
  // Opacity: vivid and unmissable
  const opacity = crossDistrict
    ? Math.max(0.7, Math.min(0.95, 0.65 + throughput * 0.008))
    : Math.max(0.55, Math.min(0.8, 0.5 + throughput * 0.006));

  // These flow edges are PERSISTENT (one per room connection), so a per-edge
  // <animateMotion> particle ran indefinitely for the whole world graph the entire
  // time the canvas was open — a dominant always-on CPU/paint cost. The particle is
  // dropped; the dashed-offset flow conveys the same "artery" motion far cheaper and
  // is disabled under reduce-motion (static arteries, no animation at all).
  const animateFlow = !prefersReducedMotion();

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  // Dash animation speed: faster with more throughput
  const dashDur = Math.max(0.5, 2 - vol * 0.03);

  return (
    <>
      {/* Wide background glow — stronger */}
      <path
        id={`${id}-bg`}
        d={edgePath}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth + 12}
        opacity={opacity * 0.2}
        className="react-flow__edge-path"
      />
      {/* Main animated path — thick, bright, vibrant */}
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray="10 5"
        opacity={opacity}
        strokeLinecap="round"
        className="react-flow__edge-path"
      >
        {animateFlow && (
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to="-24"
            dur={`${dashDur}s`}
            repeatCount="indefinite"
          />
        )}
      </path>

      {/* Cross-district gradient overlay */}
      {crossDistrict && (
        <path
          d={edgePath}
          fill="none"
          stroke="#fff"
          strokeWidth={strokeWidth * 0.6}
          strokeDasharray="3 12"
          opacity={0.15}
          className="react-flow__edge-path"
        />
      )}

      {/* Cardinal direction label at midpoint */}
      {dirLabel && (
        <text
          x={(sourceX + targetX) / 2}
          y={(sourceY + targetY) / 2 - 8}
          textAnchor="middle"
          fontSize={crossDistrict ? 10 : 8}
          fontFamily="'Press Start 2P', monospace"
          fill={color}
          opacity={crossDistrict ? 0.6 : 0.35}
          letterSpacing={1}
        >
          {dirLabel}
        </text>
      )}
    </>
  );
});
