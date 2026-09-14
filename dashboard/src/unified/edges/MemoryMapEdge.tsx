// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * MemoryMapEdge -- Edge renderer for the memory-only relationships.
 *
 *   twin            short dotted gray, no label (record ↔ note)
 *   cites           thin dashed violet (proposal → cited records/notes)
 *   derived_from    orange dashed (matches GraphLinkEdge)
 *   resolves        solid emerald with arrowhead (resolution → winner)
 *   superseded_by   rose dashed "closed interval" — perpendicular ticks at
 *                   both ends (loser → resolution): the loser's valid_time
 *                   was closed, not deleted
 *   in_space        wide faint gold band — membership, not an arrow
 *   worker/requester light dotted arcs helper ↔ job
 *   adopted_as      gold, animated dash flow + arrowhead (job → record)
 *
 * `related_to` / `part_of` / `supersedes` / `contradicts` are routed to the
 * existing GraphLinkEdge by UnifiedCanvas so their styles stay unchanged.
 */

import { type EdgeProps, getBezierPath, getStraightPath } from "@xyflow/react";
import { memo } from "react";
import { prefersReducedMotion } from "../../lib/motion-prefs";
import { MEMORY_EDGE_STYLES } from "../lib/memory-map-types";

export interface MemoryMapEdgeData {
  relationship: string;
  /** Highlight (e.g. the selected node's edges). */
  emphasized?: boolean;
  [key: string]: unknown;
}

export const MemoryMapEdge = memo(function MemoryMapEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const d = data as MemoryMapEdgeData | undefined;
  const rel = d?.relationship ?? "twin";
  const style = MEMORY_EDGE_STYLES[rel] ?? MEMORY_EDGE_STYLES.twin!;
  const emphasized = d?.emphasized === true;

  const straight = rel === "twin" || rel === "in_space";
  const [edgePath, labelX, labelY] = straight
    ? getStraightPath({ sourceX, sourceY, targetX, targetY })
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });

  const baseOpacity = style.membership ? 0.16 : rel === "worker" || rel === "requester" ? 0.4 : 0.6;
  const opacity = emphasized ? Math.min(1, baseOpacity + 0.35) : baseOpacity;
  const width = emphasized && !style.membership ? style.width + 0.8 : style.width;
  const flow = style.flow && !prefersReducedMotion();
  const markerId = `mem-arrow-${id}`;

  // Interval ticks — perpendicular to the chord at both endpoints.
  let ticks: React.ReactNode = null;
  if (style.interval) {
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;
    const len = Math.hypot(dx, dy) || 1;
    const px = (-dy / len) * 5;
    const py = (dx / len) * 5;
    ticks = (
      <>
        <line
          x1={sourceX - px}
          y1={sourceY - py}
          x2={sourceX + px}
          y2={sourceY + py}
          stroke={style.color}
          strokeWidth={1.4}
          opacity={opacity + 0.2}
        />
        <line
          x1={targetX - px}
          y1={targetY - py}
          x2={targetX + px}
          y2={targetY + py}
          stroke={style.color}
          strokeWidth={1.4}
          opacity={opacity + 0.2}
        />
      </>
    );
  }

  const labelText = rel.replace(/_/g, " ");

  return (
    <>
      {style.arrow && (
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={7}
            markerHeight={7}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={style.color} opacity={opacity + 0.2} />
          </marker>
        </defs>
      )}
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={style.color}
        strokeWidth={width}
        strokeDasharray={style.dash}
        strokeLinecap={style.membership ? "round" : undefined}
        opacity={opacity}
        markerEnd={style.arrow ? `url(#${markerId})` : undefined}
        className="react-flow__edge-path"
      >
        {flow && (
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to="-18"
            dur="1.1s"
            repeatCount="indefinite"
          />
        )}
      </path>
      {ticks}
      {!style.noLabel && (
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
            opacity={emphasized ? 0.95 : 0.7}
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
      )}
    </>
  );
});
