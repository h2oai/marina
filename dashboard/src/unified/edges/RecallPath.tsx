// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom ReactFlow edge for `recall_trace` events — draws the agent's
 * *reasoning* as a path from its current room to each activated note.
 *
 * Previously `recall_trace` just pulsed the activated note silently. The
 * query → activated-set → decision chain is the teaching moment of the
 * graph layer — content over motion. This edge makes that chain visible:
 * amber paths with a query pill, so the reader can see *why* the notes
 * just lit up, not only that something lit up.
 *
 * - Amber stroke (`#f59e0b`) — memory/recall color, distinct from the
 *   say/tell/shout palette used by InteractionArc.
 * - Seed notes (the direct recall hits) get a brighter stroke than
 *   spreading-activation hits so the semantic weight is legible.
 * - Query pill renders once per trace at the source end. Dark glassy
 *   background with amber border, mono typography matching the
 *   InteractionArc bubble for visual unity.
 * - Fade curve holds full opacity for ~60% of lifetime then decays —
 *   readers who catch up a second late still see the chain.
 *
 * Time-based fade is driven by a single MotionValue animated once at mount
 * — no per-tick React re-renders.
 */

import { type EdgeProps, getBezierPath } from "@xyflow/react";
import { animate, type MotionValue, motion, useMotionValue, useTransform } from "motion/react";
import { memo, useEffect, useState } from "react";
import { prefersReducedMotion } from "../../lib/motion-prefs";
import { RECALL_PATH_LIFETIME_MS, type RecallPathEdgeData } from "../lib/recall-paths";

const RECALL_COLOR = "#f59e0b";
const RECALL_COLOR_SEED = "#fbbf24"; // brighter gold for seed activations
const PILL_HOLD_FRACTION = 0.6;
const PILL_MAX_CHARS = 56;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export const RecallPath = memo(function RecallPath({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const arc = data as unknown as RecallPathEdgeData | undefined;
  const createdAt = arc?.createdAt ?? Date.now();
  const query = arc?.query ?? "";
  const entity = arc?.entity ?? "";
  const showLabel = !!arc?.showLabel;
  const activatedCount = arc?.activatedCount ?? 0;
  const seed = !!arc?.seed;
  const color = seed ? RECALL_COLOR_SEED : RECALL_COLOR;

  // Single progress MotionValue — 0 at mount, 1 at lifetime end.
  const progress = useMotionValue(0);
  const fade = useTransform(progress, [0, 1], [1, 0]);
  const pillFade = useTransform(progress, (p) =>
    p < PILL_HOLD_FRACTION
      ? 1
      : Math.max(0, 1 - (p - PILL_HOLD_FRACTION) / (1 - PILL_HOLD_FRACTION)),
  );
  const strokeWidth = useTransform(fade, (f) => (seed ? 2 + f * 1.5 : 1.2 + f * 1));
  const glowWidth = useTransform(strokeWidth, (w) => w + 8);

  const [done, setDone] = useState(false);

  useEffect(() => {
    const elapsed = Date.now() - createdAt;
    const remaining = RECALL_PATH_LIFETIME_MS - elapsed;
    if (remaining <= 0) {
      progress.set(1);
      setDone(true);
      return;
    }
    progress.set(Math.max(0, elapsed / RECALL_PATH_LIFETIME_MS));
    const controls = animate(progress, 1, {
      duration: remaining / 1000,
      ease: "linear",
      onComplete: () => setDone(true),
    });
    return () => controls.stop();
  }, [progress, createdAt]);

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  if (done) return null;

  // The travelling-particle <animateMotion> samples the bezier path every frame
  // and, with many simultaneous recall edges, was a dominant continuous-CPU cost
  // — so it's dropped. The dashed-offset flow conveys the same direction far more
  // cheaply, and is itself disabled under reduce-motion (static path + fade only).
  const animateFlow = !prefersReducedMotion();

  return (
    <>
      {/* Line fades as a group. */}
      <motion.g style={{ opacity: fade }}>
        {/* Soft glow under the path */}
        <motion.path
          id={`${id}-glow`}
          d={edgePath}
          fill="none"
          stroke={color}
          opacity={0.12}
          style={{ strokeWidth: glowWidth }}
          className="react-flow__edge-path"
        />
        {/* Main recall path — dashed, slow moving */}
        <motion.path
          id={id}
          d={edgePath}
          fill="none"
          stroke={color}
          strokeDasharray={seed ? "6 3" : "3 3"}
          strokeLinecap="round"
          opacity={seed ? 0.75 : 0.55}
          style={{ strokeWidth }}
          className="react-flow__edge-path"
        >
          {animateFlow && (
            <animate
              attributeName="stroke-dashoffset"
              from="0"
              to="-18"
              dur="1.4s"
              repeatCount="indefinite"
            />
          )}
        </motion.path>
      </motion.g>

      {/* Query pill — rendered once per trace at the source (agent side).
          Holds longer than the line so the reader can still catch the
          query when the trace itself is fading. */}
      {showLabel && query && (
        <RecallPill
          x={sourceX}
          y={sourceY - 38}
          color={color}
          opacity={pillFade}
          entity={entity}
          query={query}
          activatedCount={activatedCount}
        />
      )}
    </>
  );
});

const PILL_CHAR_W = 6.3;
const PILL_HEAD_W = 6.0;
const PILL_PAD_X = 10;
const PILL_PAD_Y = 5;
const PILL_BODY_FONT = 11;
const PILL_HEAD_FONT = 10;

function RecallPill({
  x,
  y,
  color,
  opacity,
  entity,
  query,
  activatedCount,
}: {
  x: number;
  y: number;
  color: string;
  opacity: MotionValue<number>;
  entity: string;
  query: string;
  activatedCount: number;
}) {
  const head = entity ? `${entity} recalls` : "recall";
  const clippedQuery = clip(query, PILL_MAX_CHARS);
  const countLabel = activatedCount > 1 ? `  (${activatedCount} notes)` : "";

  const headW = head.length * PILL_HEAD_W;
  const queryW = (clippedQuery.length + 2) * PILL_CHAR_W; // + 2 for ": "
  const countW = countLabel.length * PILL_HEAD_W;
  const innerW = Math.max(100, headW + queryW + countW);
  const width = innerW + PILL_PAD_X * 2;
  const height = PILL_PAD_Y * 2 + Math.max(PILL_BODY_FONT, PILL_HEAD_FONT) + 2;
  const left = x - width / 2;
  const top = y - height / 2;
  const textY = top + height / 2 + PILL_BODY_FONT / 2 - 2;

  return (
    <motion.g pointerEvents="none" style={{ opacity }}>
      {/* Amber aura so the pill reads clearly over any background */}
      <rect
        x={left - 3}
        y={top - 3}
        width={width + 6}
        height={height + 6}
        rx={10}
        ry={10}
        fill={color}
        opacity={0.14}
      />
      <rect
        x={left}
        y={top}
        width={width}
        height={height}
        rx={8}
        ry={8}
        fill="rgba(12, 10, 6, 0.88)"
        stroke={color}
        strokeWidth={1.25}
      />
      <text
        x={left + PILL_PAD_X}
        y={textY}
        fontFamily="'JetBrains Mono', 'Fira Code', monospace"
        fontSize={PILL_BODY_FONT}
        textAnchor="start"
        dominantBaseline="alphabetic"
      >
        <tspan fontSize={PILL_HEAD_FONT} fontWeight={700} fill={color}>
          {head}
        </tspan>
        <tspan fill="#f0f2f5" opacity={0.92}>
          {`: ${clippedQuery}`}
        </tspan>
        {countLabel && (
          <tspan fontSize={PILL_HEAD_FONT} fill={color} opacity={0.75}>
            {countLabel}
          </tspan>
        )}
      </text>
    </motion.g>
  );
}
