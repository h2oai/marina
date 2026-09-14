// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * MemoryMapNode -- One ReactFlow node type for the six durable-side kinds.
 *
 *   record      hexagon, unified-tier color, docked beside its legacy note
 *   job         state-colored ring · role letter · H/A/S marker badge ·
 *               remaining-ops arc driven by a MotionValue
 *   proposal    rounded tag, dashed outline until adopted
 *   resolution  diamond labeled by policy abbreviation
 *   space       soft hull (institutional gravity well) with a name tag
 *   helper      entity-style disc with a role glyph (L / R / E)
 *
 * The `layoutId` hand-off: while a job is un-adopted its glyph carries
 * `memory-adopt-<job>`; when a live adoption lands, the job renders a plain
 * glyph and the adopted record mounts with the same `layoutId`, so motion
 * animates the glyph from the job to the record — "the job becomes the record".
 */

import { Handle, type NodeProps, Position } from "@xyflow/react";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { memo, useEffect } from "react";
import { prefersReducedMotion } from "../../lib/motion-prefs";
import { useZoom } from "../hooks/use-zoom";
import {
  helperRoleGlyph,
  jobMarkerBadge,
  jobStateColor,
  type MemoryGraphNode,
  policyAbbrev,
  tierColor,
} from "../lib/memory-map-types";

export interface MemoryMapNodeData {
  node: MemoryGraphNode;
  /** Timestamp of the last state transition — pulses for MEMORY_PULSE_MS. */
  pulseAt?: number;
  /** space: hull radius from the layout. */
  hullRadius?: number;
  /** space: ratified-record count for the tag. */
  memberCount?: number;
  /** job: 0..1 fraction of remaining operations (null = unknown, arc hidden). */
  remainingFraction?: number | null;
  /** job: true while its glyph has been handed to the adopted record. */
  handOff?: boolean;
  /** record: job node id it was just adopted from (mount with the shared layoutId). */
  adoptedFromJob?: string;
  /** proposal: adopted → solid outline. */
  adopted?: boolean;
  onClick?: (nodeId: string, screenX: number, screenY: number) => void;
  [key: string]: unknown;
}

const FONT = "'VT323', monospace";
const PIXEL = "'Press Start 2P', monospace";
const PULSE_WINDOW_MS = 2000;

/** Size (px) of the square node box for a kind — the layout offsets by half of this. */
export function memoryNodeSize(kind: MemoryGraphNode["kind"], hullRadius = 70): number {
  switch (kind) {
    case "space":
      return hullRadius * 2 + 24;
    case "job":
      return 44;
    case "helper":
      return 34;
    case "proposal":
      return 36;
    case "resolution":
      return 30;
    default:
      return 28;
  }
}

function hexagonPoints(r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    pts.push(`${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`);
  }
  return pts.join(" ");
}

const NodeHandles = memo(function NodeHandles() {
  const cls = "!bg-transparent !border-0 !w-1 !h-1 !min-w-0 !min-h-0";
  return (
    <>
      <Handle type="source" position={Position.Top} id="t" className={cls} />
      <Handle type="target" position={Position.Top} id="t" className={cls} />
      <Handle type="source" position={Position.Bottom} id="b" className={cls} />
      <Handle type="target" position={Position.Bottom} id="b" className={cls} />
      <Handle type="source" position={Position.Left} id="l" className={cls} />
      <Handle type="target" position={Position.Left} id="l" className={cls} />
      <Handle type="source" position={Position.Right} id="r" className={cls} />
      <Handle type="target" position={Position.Right} id="r" className={cls} />
    </>
  );
});

function PulseRing({ r, color, active }: { r: number; color: string; active: boolean }) {
  if (!active) return null;
  return (
    <circle r={r} fill="none" stroke={color} strokeWidth={1} opacity={0.7}>
      <animate attributeName="r" values={`${r};${r + 14}`} dur="1s" repeatCount="2" />
      <animate attributeName="opacity" values="0.7;0" dur="1s" repeatCount="2" />
    </circle>
  );
}

// ── Job ─────────────────────────────────────────────────────────────────────

function JobGlyph({ data, size }: { data: MemoryMapNodeData; size: number }) {
  const { node } = data;
  const color = jobStateColor(node.state);
  const r = 12;
  const arcR = r + 5;
  const circumference = 2 * Math.PI * arcR;
  const badge = jobMarkerBadge((node.meta?.marker as string | null | undefined) ?? undefined);
  const glyph = helperRoleGlyph(node.role);

  // Remaining-ops arc — MotionValue so live updates don't re-render the ring.
  const target = data.remainingFraction ?? 0;
  const frac = useMotionValue(target);
  useEffect(() => {
    const controls = animate(frac, target, { duration: 0.5, ease: "easeOut" });
    return () => controls.stop();
  }, [frac, target]);
  const dashOffset = useTransform(frac, (f) => circumference * (1 - Math.max(0, Math.min(1, f))));
  const showArc = data.remainingFraction !== null && data.remainingFraction !== undefined;

  const pulsing = !!data.pulseAt && Date.now() - data.pulseAt < PULSE_WINDOW_MS;
  const running = node.state === "running" && !prefersReducedMotion();
  const jobRef = node.id.replace(/^job:/, "");

  const ring = (
    <svg
      width={size}
      height={size}
      viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
      style={{ overflow: "visible", display: "block" }}
    >
      <title>{`${node.label} · ${node.state ?? "pending"}${badge ? ` · [${badge}]` : ""}`}</title>
      <PulseRing r={arcR + 2} color={color} active={pulsing} />
      <circle r={r} fill={color} opacity={0.14} />
      <circle
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeDasharray={running ? "4 3" : undefined}
        opacity={node.state === "cancelled" || node.state === "abstained" ? 0.55 : 0.95}
      >
        {running && (
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to="-14"
            dur="1.2s"
            repeatCount="indefinite"
          />
        )}
      </circle>
      {showArc && (
        <motion.circle
          r={arcR}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={circumference}
          style={{ strokeDashoffset: dashOffset, rotate: -90 }}
          opacity={0.8}
        />
      )}
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily={PIXEL}
        fontSize={8}
        fill={color}
      >
        {glyph}
      </text>
      <AnimatePresence>
        {badge && (
          <motion.g
            key={badge}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <circle cx={r + 2} cy={-r - 2} r={6} fill="#08080e" stroke={color} strokeWidth={1} />
            <text
              x={r + 2}
              y={-r - 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontFamily={PIXEL}
              fontSize={6}
              fill={color}
            >
              {badge}
            </text>
          </motion.g>
        )}
      </AnimatePresence>
    </svg>
  );

  // Separate elements (not a toggled prop) so the layoutId element truly unmounts on hand-off.
  return data.handOff ? (
    <div key="handed-off">{ring}</div>
  ) : (
    <motion.div key="live" layoutId={`memory-adopt-${jobRef}`} style={{ display: "block" }}>
      {ring}
    </motion.div>
  );
}

// ── Record ──────────────────────────────────────────────────────────────────

function RecordGlyph({ data, size }: { data: MemoryMapNodeData; size: number }) {
  const { node } = data;
  const color = tierColor(node.tier);
  const r = 9;
  const pulsing = !!data.pulseAt && Date.now() - data.pulseAt < PULSE_WINDOW_MS;
  const version = node.meta?.version;
  const svg = (
    <svg
      width={size}
      height={size}
      viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
      style={{ overflow: "visible", display: "block" }}
    >
      <title>{`${node.label}${node.tier ? ` [${node.tier}]` : ""}${version != null ? ` v${version}` : ""}`}</title>
      <PulseRing r={r + 3} color={color} active={pulsing} />
      <polygon points={hexagonPoints(r)} fill={color} opacity={0.22} />
      <polygon points={hexagonPoints(r)} fill="none" stroke={color} strokeWidth={1.5} />
      <polygon points={hexagonPoints(r * 0.4)} fill={color} />
    </svg>
  );
  if (data.adoptedFromJob) {
    const jobRef = data.adoptedFromJob.replace(/^job:/, "");
    return (
      <motion.div layoutId={`memory-adopt-${jobRef}`} style={{ display: "block" }}>
        {svg}
      </motion.div>
    );
  }
  return (
    <motion.div
      initial={{ scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      style={{ display: "block" }}
    >
      {svg}
    </motion.div>
  );
}

// ── Proposal ────────────────────────────────────────────────────────────────

function ProposalGlyph({ data, size }: { data: MemoryMapNodeData; size: number }) {
  const { node } = data;
  const color = tierColor("proposal");
  const adopted = data.adopted === true;
  const w = 24;
  const h = 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
      style={{ overflow: "visible", display: "block" }}
    >
      <title>{`${node.label} · ${adopted ? "adopted" : "proposal"}`}</title>
      <motion.rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        rx={3}
        fill={color}
        initial={false}
        animate={{ fillOpacity: adopted ? 0.28 : 0.1 }}
      />
      <motion.rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        rx={3}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        initial={false}
        animate={{ strokeDasharray: adopted ? "0 0" : "3 2" }}
        transition={{ duration: 0.4 }}
      />
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily={PIXEL}
        fontSize={6}
        fill={color}
      >
        {adopted ? "OK" : "?"}
      </text>
    </svg>
  );
}

// ── Resolution ──────────────────────────────────────────────────────────────

function ResolutionGlyph({ data, size }: { data: MemoryMapNodeData; size: number }) {
  const { node } = data;
  const color = "#f59e0b";
  const r = 10;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
      style={{ overflow: "visible", display: "block" }}
    >
      <title>{`${node.label} · ${node.policy ?? "resolution"}`}</title>
      <polygon points={`0,${-r} ${r},0 0,${r} ${-r},0`} fill={color} opacity={0.2} />
      <polygon
        points={`0,${-r} ${r},0 0,${r} ${-r},0`}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
      />
      <text
        y={r + 9}
        textAnchor="middle"
        fontFamily={PIXEL}
        fontSize={5.5}
        fill={color}
        opacity={0.9}
      >
        {policyAbbrev(node.policy)}
      </text>
    </svg>
  );
}

// ── Space ───────────────────────────────────────────────────────────────────

function SpaceGlyph({ data, size }: { data: MemoryMapNodeData; size: number }) {
  const { node } = data;
  const color = node.institutional === false ? "#9ca3af" : "#FFDD00";
  const r = data.hullRadius ?? 70;
  const zoom = useZoom((s) => s.zoom);
  const count = data.memberCount ?? 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
      style={{ overflow: "visible", display: "block", pointerEvents: "none" }}
    >
      <title>{`${node.label} · ${count} ratified`}</title>
      <circle r={r} fill={color} opacity={0.035} />
      <circle
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={1}
        strokeDasharray="2 6"
        opacity={0.35}
      />
      <circle r={r - 8} fill="none" stroke={color} strokeWidth={0.5} opacity={0.12} />
      <g transform={`translate(0, ${-r - 14})`} style={{ pointerEvents: "auto" }}>
        <rect
          x={-node.label.length * 3.6 - 8}
          y={-9}
          width={node.label.length * 7.2 + 16}
          height={18}
          rx={2}
          fill="rgba(8, 8, 14, 0.9)"
          stroke={color}
          strokeOpacity={0.6}
          strokeWidth={0.8}
        />
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily={PIXEL}
          fontSize={7}
          fill={color}
        >
          {node.label}
        </text>
      </g>
      {zoom >= 0.5 && (
        <text
          y={r + 14}
          textAnchor="middle"
          fontFamily={FONT}
          fontSize={11}
          fill={color}
          opacity={0.6}
        >
          {count} ratified
        </text>
      )}
    </svg>
  );
}

// ── Helper ──────────────────────────────────────────────────────────────────

function HelperGlyph({ data, size }: { data: MemoryMapNodeData; size: number }) {
  const { node } = data;
  const color = "var(--color-primary)";
  const r = 11;
  const zoom = useZoom((s) => s.zoom);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
      style={{ overflow: "visible", display: "block" }}
    >
      <title>{`${node.label} · ${node.role ?? "helper"}`}</title>
      <circle r={r} fill={color} opacity={0.18} />
      <circle r={r} fill="none" stroke={color} strokeWidth={1.5} />
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily={PIXEL}
        fontSize={8}
        fill={color}
      >
        {helperRoleGlyph(node.role)}
      </text>
      {zoom >= 0.7 && (
        <text
          y={r + 12}
          textAnchor="middle"
          fontFamily={FONT}
          fontSize={10}
          fill="#ccc"
          opacity={0.85}
        >
          {node.label}
        </text>
      )}
    </svg>
  );
}

// ── Node ────────────────────────────────────────────────────────────────────

export const MemoryMapNode = memo(function MemoryMapNode({ data }: NodeProps) {
  const d = data as unknown as MemoryMapNodeData;
  const { node } = d;
  const size = memoryNodeSize(node.kind, d.hullRadius);
  const clickable = !!d.onClick;

  let glyph: React.ReactNode;
  switch (node.kind) {
    case "job":
      glyph = <JobGlyph data={d} size={size} />;
      break;
    case "record":
      glyph = <RecordGlyph data={d} size={size} />;
      break;
    case "proposal":
      glyph = <ProposalGlyph data={d} size={size} />;
      break;
    case "resolution":
      glyph = <ResolutionGlyph data={d} size={size} />;
      break;
    case "space":
      glyph = <SpaceGlyph data={d} size={size} />;
      break;
    case "helper":
      glyph = <HelperGlyph data={d} size={size} />;
      break;
    default:
      glyph = null;
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: React Flow node wrapper hosts drag Handles + SVG; a <button> swallows the node's pointer/drag model
    <div
      role="button"
      tabIndex={clickable ? 0 : undefined}
      className={`uc-memory-node uc-memory-${node.kind}`}
      data-memory-id={node.id}
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: clickable ? "pointer" : undefined,
      }}
      onClick={(e) => {
        if (d.onClick) {
          e.stopPropagation();
          d.onClick(node.id, e.clientX, e.clientY);
        }
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && d.onClick) {
          e.preventDefault();
          const rect = (e.target as HTMLElement).getBoundingClientRect();
          d.onClick(node.id, rect.left, rect.top);
        }
      }}
    >
      <NodeHandles />
      {glyph}
    </div>
  );
});
