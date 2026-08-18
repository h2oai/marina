// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom ReactFlow edge for temporary interaction arcs.
 *
 * Content over motion: when the arc carries a message body (say / tell /
 * shout / emote / broadcast), a pretty pill-shaped bubble renders at the
 * midpoint showing `sender: body` or `sender → recipient: body`. The
 * bubble stays legible longer than the line fade — content persists so
 * readers can catch up after the animation settles.
 *
 * - Color: unique per type (cyan=say, violet=tell, yellow=shout, etc.)
 * - Width: louder/more important events get thicker strokes
 * - Bubble: content-bearing pill with dark glassy bg + type-colored border
 * - Particles: animated circles flow along the path
 * - Fade: opacity decreases over the arc's type-specific lifetime
 * - Arrowhead: directional marker showing flow direction
 *
 * Time-based fade is driven by a single MotionValue animated once at mount
 * — no per-tick React re-renders. SVG `<animate>` children handle the
 * dash and particle pulses (browser-native, compositor-friendly).
 */

import { type EdgeProps, getBezierPath } from "@xyflow/react";
import { animate, type MotionValue, motion, useMotionValue, useTransform } from "motion/react";
import { memo, useEffect, useState } from "react";
import { prefersReducedMotion } from "../../lib/motion-prefs";
import type { InteractionType } from "../hooks/use-interactions";
import {
  INTERACTION_COLORS,
  INTERACTION_LIFETIMES,
  INTERACTION_WIDTHS,
} from "../hooks/use-interactions";

/** Data passed to the InteractionArc edge. */
export interface InteractionArcData {
  /** Interaction type determines arc color and style. */
  type: InteractionType;
  /** Timestamp when the interaction was created. */
  createdAt: number;
  /** Message body for content-bearing arcs (say/tell/shout/emote/broadcast). */
  body?: string;
  /** Recipient name for `tell` arcs. */
  recipient?: string;
  /** Sender entity name — rendered on the bubble. */
  from?: string;
  /** Target entity name. */
  to?: string;
}

/** Duration to show the type label in milliseconds (when no body). */
const LABEL_DURATION_MS = 2500;

/** Bubble holds full opacity for this fraction of lifetime, then decays. */
const BUBBLE_HOLD_FRACTION = 0.7;

/** Max visible characters in a bubble body before ellipsis. */
const BUBBLE_MAX_CHARS = 60;

/** Human-readable labels per type. */
const TYPE_LABELS: Record<InteractionType, string> = {
  say: "SAY",
  tell: "TELL",
  shout: "SHOUT",
  emote: "EMOTE",
  broadcast: "BCAST",
  move: "MOVE",
  task: "TASK",
  command: "CMD",
  connect: "JOIN",
  disconnect: "LEAVE",
};

/**
 * Temporary ReactFlow edge for entity interactions.
 * Automatically fades over its lifetime and displays
 * animated particles, type label, and directional arrowhead.
 */
export const InteractionArc = memo(function InteractionArc({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const arcData = data as InteractionArcData | undefined;
  const type = arcData?.type ?? "say";
  const createdAt = arcData?.createdAt ?? Date.now();
  const body = arcData?.body?.trim();
  const recipient = arcData?.recipient;
  const fromName = arcData?.from;
  const color = INTERACTION_COLORS[type] ?? INTERACTION_COLORS.say;
  const lifetime = INTERACTION_LIFETIMES[type] ?? 5000;
  const baseWidth = INTERACTION_WIDTHS[type] ?? 3;
  const label = TYPE_LABELS[type] ?? type.toUpperCase();
  const labelEndProgress = Math.min(1, LABEL_DURATION_MS / lifetime);

  // Single progress MotionValue — 0 at mount, 1 at lifetime end.
  const progress = useMotionValue(0);
  const fade = useTransform(progress, [0, 1], [1, 0]);
  const bubbleFade = useTransform(progress, (p) =>
    p < BUBBLE_HOLD_FRACTION
      ? 1
      : Math.max(0, 1 - (p - BUBBLE_HOLD_FRACTION) / (1 - BUBBLE_HOLD_FRACTION)),
  );
  const strokeWidth = useTransform(fade, (f) => baseWidth + f * baseWidth);
  const glowWidth = useTransform(strokeWidth, (w) => w + 10);
  const arrowOpacity = useTransform(fade, (f) => f * 0.7);
  const labelOpacity = useTransform(progress, (p) =>
    p < labelEndProgress ? (1 - p / labelEndProgress) * 0.8 : 0,
  );
  const showBubble = !!body;

  const [done, setDone] = useState(false);

  useEffect(() => {
    const elapsed = Date.now() - createdAt;
    const remaining = lifetime - elapsed;
    if (remaining <= 0) {
      progress.set(1);
      setDone(true);
      return;
    }
    progress.set(Math.max(0, elapsed / lifetime));
    const controls = animate(progress, 1, {
      duration: remaining / 1000,
      ease: "linear",
      onComplete: () => setDone(true),
    });
    return () => controls.stop();
  }, [progress, createdAt, lifetime]);

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  if (done) return null;

  // Midpoint for the type label — arched above the path
  const midX = (sourceX + targetX) / 2;
  const midY = Math.min(sourceY, targetY) - 40 - Math.abs(sourceX - targetX) * 0.1;

  // The two travelling particles used <animateMotion> to sample the bezier path
  // every frame — multiplied across every live say/tell/shout arc, that was a
  // dominant continuous-CPU cost. They're dropped; the dashed-offset flow carries
  // the same direction far more cheaply and is itself disabled under reduce-motion.
  const animateFlow = !prefersReducedMotion();

  return (
    <>
      {/* Arrowhead marker — opacity fades with the line */}
      <defs>
        <marker
          id={`arrow-${id}`}
          viewBox="0 0 12 12"
          refX="10"
          refY="6"
          markerWidth="8"
          markerHeight="8"
          orient="auto"
        >
          <motion.path d="M 0 0 L 12 6 L 0 12 z" fill={color} style={{ opacity: arrowOpacity }} />
        </marker>
      </defs>

      {/* Line + particles fade together as a group — single composited
          opacity replaces per-element fade math. */}
      <motion.g style={{ opacity: fade }}>
        {/* Wide background glow */}
        <motion.path
          id={`${id}-glow`}
          d={edgePath}
          fill="none"
          stroke={color}
          opacity={0.15}
          style={{ strokeWidth: glowWidth }}
          className="react-flow__edge-path"
        />

        {/* Main animated dashed path with arrowhead */}
        <motion.path
          id={id}
          d={edgePath}
          fill="none"
          stroke={color}
          opacity={0.75}
          strokeDasharray="8 4"
          strokeLinecap="round"
          markerEnd={`url(#arrow-${id})`}
          style={{ strokeWidth }}
          className="react-flow__edge-path"
        >
          {animateFlow && (
            <animate
              attributeName="stroke-dashoffset"
              from="0"
              to="-36"
              dur="0.5s"
              repeatCount="indefinite"
            />
          )}
        </motion.path>

        {/* Type label at midpoint — only when the arc has no body
            (movement, command, presence). */}
        {!showBubble && (
          <motion.text
            x={midX}
            y={midY - 12}
            textAnchor="middle"
            fontSize={12}
            fontFamily="'Press Start 2P', monospace"
            fontWeight="bold"
            fill={color}
            letterSpacing={2}
            style={{ opacity: labelOpacity }}
          >
            {label}
          </motion.text>
        )}
      </motion.g>

      {/* Message bubble — content-bearing arcs carry their body at midpoint.
          Holds full opacity for ~70% of lifetime, then decays so the reader
          can catch up after the line quiets. */}
      {showBubble && (
        <MessageBubble
          x={midX}
          y={midY}
          color={color}
          opacity={bubbleFade}
          sender={fromName}
          recipient={recipient}
          body={body!}
        />
      )}
    </>
  );
});

/** Approx width of a mono char at the bubble body font size. */
const BUBBLE_CHAR_W = 6.3;
const BUBBLE_SENDER_CHAR_W = 6.0;
const BUBBLE_PAD_X = 10;
const BUBBLE_PAD_Y = 6;
const BUBBLE_BODY_FONT = 11;
const BUBBLE_SENDER_FONT = 10;
const BUBBLE_GAP = 6;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Pretty message bubble rendered at the midpoint of a content-bearing arc.
 * Dark glassy background for legibility over any map color, type-colored
 * border, sender + recipient + body on one line. Sizes to its content.
 */
function MessageBubble({
  x,
  y,
  color,
  opacity,
  sender,
  recipient,
  body,
}: {
  x: number;
  y: number;
  color: string;
  opacity: MotionValue<number>;
  sender?: string;
  recipient?: string;
  body: string;
}) {
  const senderText = sender ?? "";
  const arrow = recipient ? ` → ${recipient}` : "";
  const senderLabel = senderText + arrow;
  const bodyText = clip(body, BUBBLE_MAX_CHARS);

  // Approximate bubble size from text lengths
  const senderW = senderLabel.length * BUBBLE_SENDER_CHAR_W;
  const bodyW = bodyText.length * BUBBLE_CHAR_W;
  const sepW = senderLabel ? BUBBLE_GAP + 6 : 0; // ":" + space
  const innerW = Math.max(60, senderW + sepW + bodyW);
  const width = innerW + BUBBLE_PAD_X * 2;
  const height = BUBBLE_PAD_Y * 2 + Math.max(BUBBLE_BODY_FONT, BUBBLE_SENDER_FONT) + 2;

  const left = x - width / 2;
  const top = y - height - 6; // float just above the midpoint
  const textY = top + height / 2 + BUBBLE_BODY_FONT / 2 - 2;

  return (
    <motion.g pointerEvents="none" style={{ opacity }}>
      {/* Soft colored glow behind bubble so it stands out without being loud */}
      <rect
        x={left - 2}
        y={top - 2}
        width={width + 4}
        height={height + 4}
        rx={9}
        ry={9}
        fill={color}
        opacity={0.12}
      />
      {/* Dark glassy background — legibility over any map color */}
      <rect
        x={left}
        y={top}
        width={width}
        height={height}
        rx={8}
        ry={8}
        fill="rgba(10, 12, 16, 0.88)"
        stroke={color}
        strokeWidth={1.25}
      />
      {/* Sender (+ arrow + recipient) then body — inline single line */}
      <text
        x={left + BUBBLE_PAD_X}
        y={textY}
        fontFamily="'JetBrains Mono', 'Fira Code', monospace"
        fontSize={BUBBLE_BODY_FONT}
        textAnchor="start"
        dominantBaseline="alphabetic"
      >
        {senderLabel && (
          <tspan fontSize={BUBBLE_SENDER_FONT} fontWeight={700} fill={color}>
            {senderLabel}
          </tspan>
        )}
        {senderLabel && (
          <tspan fontSize={BUBBLE_SENDER_FONT} fill={color} opacity={0.65}>
            {"  "}
          </tspan>
        )}
        <tspan fill="#f0f2f5" opacity={0.92}>
          {bodyText}
        </tspan>
      </text>
    </motion.g>
  );
}
