// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GraphLinkEdge -- Renders a knowledge-graph note_link on the unified surface.
 *
 * Relationship → visual style:
 *   supports      solid green
 *   contradicts   dashed red
 *   extends       solid blue
 *   exemplifies   solid magenta
 *   related_to    faint gray (softest — auto-generated)
 *   supersedes    amber, ghost trail (temporal)
 *   part_of       teal (also reused for parent-child thread curves)
 *   derived_from  orange, animated (used for intent → result causal arcs)
 */

import { type EdgeProps, getBezierPath } from "@xyflow/react";
import { memo } from "react";

export interface GraphLinkEdgeData {
  relationship: string;
  /** True when the edge is part of the most recent recall trace — draws a travelling particle. */
  activated?: boolean;
}

const LINK_STYLE: Record<string, { color: string; dash?: string; width: number }> = {
  supports: { color: "#22c55e", width: 2 },
  contradicts: { color: "#ef4444", dash: "6 4", width: 2 },
  extends: { color: "#3b82f6", width: 2 },
  exemplifies: { color: "#d946ef", width: 2 },
  related_to: { color: "#6b7280", dash: "2 4", width: 1 },
  supersedes: { color: "#f59e0b", dash: "3 3", width: 1.5 },
  part_of: { color: "#14b8a6", width: 2 },
  derived_from: { color: "#f97316", dash: "4 3", width: 2 },
};

export const GraphLinkEdge = memo(function GraphLinkEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const d = data as GraphLinkEdgeData | undefined;
  const rel = d?.relationship ?? "related_to";
  const style = LINK_STYLE[rel] ?? LINK_STYLE.related_to!;
  const activated = d?.activated === true;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const labelText = rel.replace(/_/g, " ");

  return (
    <>
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={style.color}
        strokeWidth={style.width}
        strokeDasharray={style.dash}
        opacity={activated ? 0.95 : 0.5}
        className="react-flow__edge-path"
      />
      {activated && (
        <>
          <path
            d={edgePath}
            fill="none"
            stroke={style.color}
            strokeWidth={style.width + 3}
            opacity={0.3}
            className="react-flow__edge-path"
          />
          <circle r={3} fill={style.color}>
            <animateMotion dur="1.2s" repeatCount="3" path={edgePath} />
            <animate attributeName="opacity" values="0;1;0" dur="1.2s" repeatCount="3" />
          </circle>
        </>
      )}

      {/* Relationship label — small pill at edge midpoint */}
      <g transform={`translate(${labelX}, ${labelY})`} pointerEvents="none">
        <rect
          x={-labelText.length * 3.2 - 4}
          y={-8}
          width={labelText.length * 6.4 + 8}
          height={16}
          rx={3}
          fill="rgba(8, 8, 14, 0.85)"
          stroke={style.color}
          strokeOpacity={0.6}
          strokeWidth={0.6}
          opacity={0.8}
        />
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="'VT323', monospace"
          fontSize={10}
          fill={style.color}
          opacity={0.9}
        >
          {labelText}
        </text>
      </g>
    </>
  );
});
