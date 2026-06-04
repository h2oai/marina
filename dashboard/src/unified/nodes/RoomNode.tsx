/**
 * Custom ReactFlow node for rendering rooms as geometric structures.
 *
 * Inspired by isometric data dashboards — each room is a platform pedestal:
 * - Solid circular platform with radial grid texture (spatial layer)
 * - Glowing arc segments at cardinal exit positions (connection ports)
 * - Entity bars/pillars rising from the platform (population skyline)
 * - Crown shape floating above (network/communication layer)
 * - Column beam connecting platform to crown
 *
 * Visual grammar (bottom → top):
 * 1. Platform ring = WHERE (geography, exits, spatial topology)
 * 2. Entity bars = WHO (population, composition, state)
 * 3. Crown = WHAT (activity type, communication patterns)
 *
 * All animations use SVG SMIL (<animate> / <animateTransform>).
 */

import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo, useEffect, useMemo, useState } from "react";
import { useActivity } from "../hooks/use-activity";
import { useZoom } from "../hooks/use-zoom";
import { getDistrictColor } from "../lib/crown-shapes";
import { ROOM_MESSAGE_LIFETIME_MS, type RoomMessage } from "../lib/room-messages";

/** Room data passed via ReactFlow node data prop. */
export interface RoomNodeData {
  id: string;
  short: string;
  district: string;
  exits: Record<string, string>;
  throughput: number;
  entities: { name: string; kind: string; state: string }[];
  /** Callback when an entity is clicked inside the room. Includes screen position. */
  onEntityClick?: (name: string, screenX?: number, screenY?: number) => void;
  /** Callback when the room's action node is clicked (for intent/inspect). */
  onRoomAction?: (roomId: string, screenX: number, screenY: number) => void;
  /** Number of active tasks in this room's project context. */
  taskCount?: number;
  /**
   * Newest in-room message (say / emote) for this room, if fresh.
   * Rendered as a glass pill above the platform — content over motion
   * on the map layer. Complements InteractionArc bubbles (which render
   * cross-entity tells); this one carries what was said *in* the room.
   */
  latestMessage?: RoomMessage;
  [key: string]: unknown;
}

const ACTIVITY_TICK_MS = 500;

function hexToRgb(h: string): string {
  let hex = h.replace("#", "");
  if (hex.length === 3) hex = hex[0]! + hex[0]! + hex[1]! + hex[1]! + hex[2]! + hex[2]!;
  return `${Number.parseInt(hex.substring(0, 2), 16)},${Number.parseInt(hex.substring(2, 4), 16)},${Number.parseInt(hex.substring(4, 6), 16)}`;
}

const KIND_COLORS: Record<string, string> = {
  agent: "#FFDD00",
  human: "#f0f0f0",
  npc: "#22c55e",
  object: "#555555",
};

const STATE_COLORS: Record<string, string> = {
  thinking: "#FFDD00",
  working: "#22c55e",
  speaking: "#06b6d4",
  idle: "#444444",
  error: "#ef4444",
  online: "#f0f0f0",
};

/** Map exit direction to angle on the ring ellipse (0=right, π/2=bottom). */
const EXIT_ANGLES: Record<string, number> = {
  east: 0,
  se: Math.PI * 0.25,
  south: Math.PI * 0.5,
  sw: Math.PI * 0.75,
  west: Math.PI,
  nw: -Math.PI * 0.75,
  north: -Math.PI * 0.5,
  ne: -Math.PI * 0.25,
};

/** Cardinal handles component — shared between LOD and full render. */
function CardinalHandles() {
  return (
    <>
      <Handle
        type="source"
        position={Position.Top}
        id="top"
        className="!bg-transparent !border-0"
      />
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="!bg-transparent !border-0"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className="!bg-transparent !border-0"
      />
      <Handle
        type="target"
        position={Position.Bottom}
        id="bottom"
        className="!bg-transparent !border-0"
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left"
        className="!bg-transparent !border-0"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="!bg-transparent !border-0"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!bg-transparent !border-0"
      />
      <Handle
        type="target"
        position={Position.Right}
        id="right"
        className="!bg-transparent !border-0"
      />
    </>
  );
}

/** LOD: Minimal rendering at very low zoom. */
function RoomDotLOD({
  short,
  color,
  exits,
}: {
  short: string;
  color: string;
  exits: Record<string, string>;
}) {
  const exitDirs = Object.keys(exits);
  return (
    <div className="relative" style={{ width: 80, height: 80, overflow: "visible" }}>
      <CardinalHandles />
      <svg
        width={200}
        height={120}
        viewBox="-100 -60 200 120"
        style={{ overflow: "visible", position: "absolute", left: -60, top: -20 }}
      >
        <title>{short}</title>
        {/* Platform glow */}
        <ellipse cx={0} cy={0} rx={40} ry={20} fill={color} opacity={0.08} />
        <circle cx={0} cy={0} r={12} fill={color} opacity={0.7} />
        {/* Ring with exit ports */}
        <ellipse
          cx={0}
          cy={0}
          rx={35}
          ry={17}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeDasharray="4 3"
          opacity={0.3}
        >
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to="-40"
            dur="15s"
            repeatCount="indefinite"
          />
        </ellipse>
        {/* Exit port dots at LOD */}
        {exitDirs.map((dir) => {
          const angle = EXIT_ANGLES[dir];
          if (angle == null) return null;
          return (
            <circle
              key={dir}
              cx={Math.cos(angle) * 35}
              cy={Math.sin(angle) * 17}
              r={3}
              fill={color}
              opacity={0.8}
            />
          );
        })}
        <text
          x={0}
          y={32}
          textAnchor="middle"
          fontSize={10}
          fontFamily="'Press Start 2P', monospace"
          fill={color}
          opacity={0.8}
          letterSpacing={1.5}
        >
          {short.length > 12 ? `${short.substring(0, 11)}…` : short.toUpperCase()}
        </text>
      </svg>
    </div>
  );
}

/**
 * Full room node — platform pedestal with entity skyline and crown.
 */
export const RoomNode = memo(function RoomNode({ data }: NodeProps) {
  const roomData = data as unknown as RoomNodeData;
  const {
    id: roomId,
    short,
    district,
    throughput,
    entities,
    exits,
    onEntityClick,
    onRoomAction,
    taskCount,
    latestMessage,
  } = roomData;
  const zoom = useZoom((s) => s.zoom);

  const color = getDistrictColor(district);
  const rgb = hexToRgb(color);

  const eventsPerSecFn = useActivity((s) => s.eventsPerSec);
  const eventDiversityFn = useActivity((s) => s.eventDiversity);
  const lastEventAgeFn = useActivity((s) => s.lastEventAge);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), ACTIVITY_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces periodic recalculation
  const eps = useMemo(() => eventsPerSecFn(roomId), [eventsPerSecFn, roomId, tick]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces periodic recalculation
  const div = useMemo(() => eventDiversityFn(roomId), [eventDiversityFn, roomId, tick]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces periodic recalculation
  const age = useMemo(() => lastEventAgeFn(roomId), [lastEventAgeFn, roomId, tick]);

  const isActive = eps > 0.05;
  const isHot = eps > 0.5;

  // Dimensions
  const entityBoost = Math.min(entities.length * 20, 80);
  const t = Math.max(40, Math.min(100, throughput + entityBoost));
  const h = Math.max(110, Math.min(200, t * 1.8));
  const rr = 120 + t * 0.8; // ring radius X
  const rrY = rr * 0.5; // ring radius Y (isometric squish)
  const cr = 35 + t * 0.3; // crown radius

  // Animation speeds
  const ringSpeed = isActive ? Math.max(2, 20 / (eps + 0.1)) : 20;
  const ringOp = isActive ? Math.min(0.8, 0.5 + eps * 0.4) : 0.4;
  const crownSpeed = div > 0 ? Math.max(8, 40 / div) : 25;
  const breathAmp = age < 5 ? 1.08 : age < 15 ? 1.03 : 1.0;
  const breathDur = age < 5 ? 2 : age < 15 ? 4 : 0;
  const coreBright = age < 3 ? 0.85 : age < 10 ? 0.6 : 0.4;
  const colOp = isActive ? 0.55 : 0.35;

  // cr is used for the status node radius at the top of the column

  // Exit directions for port rendering
  const exitDirs = useMemo(() => Object.keys(exits), [exits]);
  const exitCount = exitDirs.length;

  // LOD
  if (zoom < 0.1) {
    return <RoomDotLOD short={short} color={color} exits={exits} />;
  }

  const showEntityDetail = zoom >= 0.5;
  const pulseDur = isActive ? Math.max(0.8, 2 / (eps + 0.1)) : 0;
  const showSonar = age < 4;

  // ── Platform grid rings (concentric) ─────────────────────────────────
  const gridRings = [0.3, 0.5, 0.7, 0.9].map((frac) => ({
    rx: rr * frac,
    ry: rrY * frac,
  }));

  // ── Exit port arc segments ───────────────────────────────────────────
  // Each exit direction gets a bright arc segment on the ring perimeter
  const portArcs = exitDirs
    .map((dir) => {
      const angle = EXIT_ANGLES[dir];
      if (angle == null) return null;
      const arcSpan = Math.PI * 0.15; // how wide each port arc is
      const startAngle = angle - arcSpan;
      const endAngle = angle + arcSpan;
      // Compute ellipse arc path
      const x1 = Math.cos(startAngle) * rr;
      const y1 = Math.sin(startAngle) * rrY;
      const x2 = Math.cos(endAngle) * rr;
      const y2 = Math.sin(endAngle) * rrY;
      return { dir, x1, y1, x2, y2, cx: Math.cos(angle) * rr, cy: Math.sin(angle) * rrY };
    })
    .filter(Boolean) as {
    dir: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    cx: number;
    cy: number;
  }[];

  // ── Entity orbital parameters ─────────────────────────────────────────
  // Entities orbit the ring like satellites — speed tied to state
  const orbitRx = rr * 0.55; // slightly inside the outer ring
  const orbitRy = rrY * 0.55;
  // SVG elliptical path for animateMotion
  const orbitPath = `M ${-orbitRx},0 A ${orbitRx},${orbitRy} 0 1,0 ${orbitRx},0 A ${orbitRx},${orbitRy} 0 1,0 ${-orbitRx},0`;

  // ── Pixel art face definitions (5x5 grid, 1=filled) ──────────────────
  // Each face is an array of [row, col] positions to fill with the face color
  const PIXEL_FACES: Record<string, [number, number][]> = {
    agent: [
      // Antenna
      [0, 2],
      // Eyes (wide, rectangular)
      [1, 1],
      [1, 3],
      // Visor bar
      [2, 0],
      [2, 1],
      [2, 2],
      [2, 3],
      [2, 4],
      // Mouth (single line)
      [3, 1],
      [3, 2],
      [3, 3],
      // Chin
      [4, 1],
      [4, 3],
    ],
    human: [
      // Hair
      [0, 1],
      [0, 2],
      [0, 3],
      // Eyes
      [1, 1],
      [1, 3],
      // Nose
      [2, 2],
      // Smile
      [3, 1],
      [3, 3],
      [4, 2],
    ],
    npc: [
      // Top edge
      [0, 0],
      [0, 4],
      // Eyes (dots)
      [1, 1],
      [1, 3],
      // Center
      [2, 2],
      // Flat mouth
      [3, 1],
      [3, 2],
      [3, 3],
      // Corners
      [4, 0],
      [4, 4],
    ],
    object: [
      // Box shape
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
      [1, 0],
      [1, 4],
      [2, 0],
      [2, 2],
      [2, 4],
      [3, 0],
      [3, 4],
      [4, 0],
      [4, 1],
      [4, 2],
      [4, 3],
      [4, 4],
    ],
  };

  const entitySprites = entities.map((ent, i) => {
    const ec = KIND_COLORS[ent.kind] ?? KIND_COLORS.agent!;
    const stateColor = STATE_COLORS[ent.state] ?? ec;
    const isIdle = ent.state === "idle";

    // Orbit speed: slow enough to click — state still affects speed
    const orbitDur = isIdle
      ? 90
      : ent.state === "thinking"
        ? 50
        : ent.state === "speaking"
          ? 35
          : ent.state === "working"
            ? 45
            : 60;
    const beginOffset = entities.length > 1 ? -(i / entities.length) * orbitDur : 0;

    // Sprite dimensions — wider, more substantial
    const sprW = 48;
    const sprH = 62;
    const face = PIXEL_FACES[ent.kind] ?? PIXEL_FACES.agent!;

    return { ent, i, ec, stateColor, isIdle, sprW, sprH, face, orbitDur, beginOffset };
  });

  return (
    <div className="relative uc-room-node" style={{ width: 120, height: 120, overflow: "visible" }}>
      <CardinalHandles />

      {latestMessage && (
        <RoomMessagePill message={latestMessage} districtColor={color} roomKey={roomId} />
      )}

      <svg
        width={500}
        height={500}
        viewBox="-250 -450 500 500"
        style={{ overflow: "visible", position: "absolute", left: -190, top: -190 }}
      >
        <title>{short}</title>
        <defs>
          <filter id={`g-${roomId}`}>
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* Radial gradient for platform fill — more solid */}
          <radialGradient id={`pf-${roomId}`} cx="50%" cy="50%" rx="50%" ry="50%">
            <stop offset="0%" stopColor={color} stopOpacity={0.22} />
            <stop offset="50%" stopColor={color} stopOpacity={0.12} />
            <stop offset="100%" stopColor={color} stopOpacity={0.04} />
          </radialGradient>
        </defs>

        {/* Ambient halo — stronger */}
        <circle cx={0} cy={0} r={rr * 0.6} fill={color} opacity={0.1} />

        <g>
          {/* ═══ LAYER 1: SPATIAL PLATFORM (geography) ═══ */}

          {/* Sonar pulse — recent event indicator */}
          {showSonar && (
            <ellipse rx={10} ry={5} fill="none" stroke={color} strokeWidth={3} opacity={0}>
              <animate attributeName="rx" values={`10;${rr + 30}`} dur="2s" repeatCount="1" />
              <animate
                attributeName="ry"
                values={`5;${(rr + 30) * 0.5}`}
                dur="2s"
                repeatCount="1"
              />
              <animate attributeName="opacity" values="0.45;0" dur="2s" repeatCount="1" />
            </ellipse>
          )}

          {/* Platform fill — solid isometric disc with radial gradient */}
          <ellipse rx={rr * 0.92} ry={rrY * 0.92} fill={`url(#pf-${roomId})`} />

          {/* Platform grid — concentric rings (bolder) */}
          {gridRings.map((ring, gi) => (
            <ellipse
              // biome-ignore lint/suspicious/noArrayIndexKey: concentric ring index is the visual identity
              key={gi}
              rx={ring.rx}
              ry={ring.ry}
              fill="none"
              stroke={color}
              strokeWidth={1}
              opacity={0.1 + gi * 0.03}
              strokeDasharray="3 5"
            />
          ))}

          {/* Platform grid — radial lines (stronger) */}
          {[0, 45, 90, 135].map((deg) => {
            const rad = (deg * Math.PI) / 180;
            return (
              <line
                key={deg}
                x1={Math.cos(rad) * rr * 0.15}
                y1={Math.sin(rad) * rrY * 0.15}
                x2={Math.cos(rad) * rr * 0.9}
                y2={Math.sin(rad) * rrY * 0.9}
                stroke={color}
                strokeWidth={0.8}
                opacity={0.08}
              />
            );
          })}
          {[0, 45, 90, 135].map((deg) => {
            const rad = ((deg + 180) * Math.PI) / 180;
            return (
              <line
                key={`r${deg}`}
                x1={Math.cos(rad) * rr * 0.15}
                y1={Math.sin(rad) * rrY * 0.15}
                x2={Math.cos(rad) * rr * 0.9}
                y2={Math.sin(rad) * rrY * 0.9}
                stroke={color}
                strokeWidth={0.8}
                opacity={0.08}
              />
            );
          })}

          {/* Outer ring — thick, solid, always spinning */}
          <ellipse
            rx={rr}
            ry={rrY}
            fill="none"
            stroke={color}
            strokeWidth={8}
            strokeDasharray="8 3 3 3"
            opacity={Math.min(0.9, ringOp + 0.15)}
            filter={`url(#g-${roomId})`}
          >
            <animate
              attributeName="stroke-dashoffset"
              from="0"
              to={`${-rr * 2}`}
              dur={`${ringSpeed}s`}
              repeatCount="indefinite"
            />
          </ellipse>

          {/* Outer ring solid underlay — continuous faint ring for solidity */}
          <ellipse rx={rr} ry={rrY} fill="none" stroke={color} strokeWidth={3} opacity={0.15} />

          {/* Notch ring — bolder */}
          <ellipse
            rx={rr}
            ry={rrY}
            fill="none"
            stroke={color}
            strokeWidth={8}
            strokeDasharray="2 16"
            opacity={ringOp * 0.4}
          >
            <animate
              attributeName="stroke-dashoffset"
              from="0"
              to={`${-rr * 2}`}
              dur={`${ringSpeed}s`}
              repeatCount="indefinite"
            />
          </ellipse>

          {/* Inner ring — high activity, thicker */}
          {isHot && (
            <ellipse
              rx={rr * 0.75}
              ry={rrY * 0.75}
              fill="none"
              stroke={color}
              strokeWidth={4}
              strokeDasharray="4 6"
              opacity={ringOp * 0.7}
            >
              <animate
                attributeName="stroke-dashoffset"
                from="0"
                to={`${rr * 1.5}`}
                dur={`${ringSpeed * 1.6}s`}
                repeatCount="indefinite"
              />
            </ellipse>
          )}

          {/* ── Exit port indicators — glowing arc segments ─────────── */}
          {portArcs.map((port) => (
            <g key={port.dir}>
              {/* Port glow — larger, brighter */}
              <circle
                cx={port.cx}
                cy={port.cy}
                r={16}
                fill={color}
                opacity={0.25}
                filter={`url(#g-${roomId})`}
              />
              {/* Port outer ring */}
              <circle cx={port.cx} cy={port.cy} r={9} fill={color} opacity={0.5} />
              {/* Port bright center */}
              <circle cx={port.cx} cy={port.cy} r={5} fill="#fff" opacity={0.6} />
              {/* Direction label near port */}
              <text
                x={port.cx + (port.cx > 0 ? 14 : port.cx < 0 ? -14 : 0)}
                y={port.cy + (port.cy > 0 ? 14 : port.cy < 0 ? -8 : 0)}
                textAnchor="middle"
                fontSize={7}
                fontFamily="'Press Start 2P'"
                fill={color}
                opacity={0.4}
                letterSpacing={1}
              >
                {port.dir.toUpperCase().substring(0, 1)}
              </text>
            </g>
          ))}

          {/* Exit count badge */}
          {exitCount > 0 && (
            <text
              x={rr + 12}
              y={-6}
              textAnchor="start"
              fontSize={9}
              fontFamily="Orbitron"
              fontWeight={700}
              fill={color}
              opacity={0.4}
            >
              {exitCount} exits
            </text>
          )}

          {/* ═══ LAYER 2: ENTITY SKYLINE (population) ═══ */}

          {/* Column beam — central spine, thicker and bolder */}
          <line
            x1={0}
            y1={0}
            x2={0}
            y2={-h}
            stroke={color}
            strokeWidth={10}
            opacity={colOp + 0.1}
          />
          {/* Column glow */}
          <line
            x1={0}
            y1={0}
            x2={0}
            y2={-h}
            stroke={color}
            strokeWidth={16}
            opacity={colOp * 0.12}
            filter={`url(#g-${roomId})`}
          />
          {/* Column highlight edge */}
          <line x1={-4} y1={0} x2={-4} y2={-h} stroke={color} strokeWidth={1} opacity={0.2} />

          {/* Data pulse up column */}
          {pulseDur > 0 && (
            <rect x={-2} width={4} height={5} fill={color} opacity={0}>
              <animate
                attributeName="y"
                values={`0;${-h}`}
                dur={`${pulseDur}s`}
                repeatCount="indefinite"
              />
              <animate
                attributeName="opacity"
                values="0.6;0"
                dur={`${pulseDur}s`}
                repeatCount="indefinite"
              />
            </rect>
          )}

          {/* Entity sprites — pixel art characters orbiting the ring */}
          {showEntityDetail &&
            entitySprites.map(
              ({ ent, ec, stateColor, isIdle, sprW, sprH, face, orbitDur, beginOffset }) => {
                const px = 5; // pixel size for the 5x5 face grid
                const faceW = 5 * px;
                const _faceH = 5 * px;
                const bodyOp = isIdle ? 0.55 : 0.92;

                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: SVG <g> sprite; cannot be a <button>, keyboard nav is via the entity panel
                  <g
                    key={ent.name}
                    style={{ cursor: onEntityClick ? "pointer" : undefined }}
                    onClick={(e) => {
                      if (onEntityClick) {
                        e.stopPropagation();
                        onEntityClick(ent.name, e.clientX, e.clientY);
                      }
                    }}
                  >
                    {/* Orbit animation */}
                    <animateMotion
                      dur={`${orbitDur}s`}
                      repeatCount="indefinite"
                      path={orbitPath}
                      begin={`${beginOffset}s`}
                    />

                    {/* Large invisible hit area for easier clicking */}
                    <rect
                      x={-sprW}
                      y={-sprH - 20}
                      width={sprW * 2}
                      height={sprH + 50}
                      fill="transparent"
                    />

                    {/* Shadow on platform — stronger */}
                    <ellipse
                      rx={sprW * 0.5}
                      ry={sprW * 0.18}
                      fill={ec}
                      opacity={isIdle ? 0.12 : 0.25}
                    />

                    {/* ── Body glow halo ── */}
                    <rect
                      x={-sprW / 2 - 4}
                      y={-sprH - 4}
                      width={sprW + 8}
                      height={sprH + 8}
                      rx={6}
                      fill={ec}
                      opacity={0.08}
                      filter={`url(#g-${roomId})`}
                    />

                    {/* ── Body (wide rounded rectangle) — solid ── */}
                    <rect
                      x={-sprW / 2}
                      y={-sprH}
                      width={sprW}
                      height={sprH}
                      rx={5}
                      fill={ec}
                      opacity={bodyOp}
                    />
                    {/* Body edge shadow */}
                    <rect
                      x={-sprW / 2 + 2}
                      y={-sprH + 2}
                      width={sprW - 4}
                      height={sprH - 4}
                      rx={4}
                      fill="#000"
                      opacity={0.2}
                    />
                    {/* Body inner fill — bright */}
                    <rect
                      x={-sprW / 2 + 3}
                      y={-sprH + 3}
                      width={sprW - 6}
                      height={sprH - 6}
                      rx={3}
                      fill={ec}
                      opacity={bodyOp * 0.8}
                    />

                    {/* ── Pixel art face — larger, higher contrast ── */}
                    <g transform={`translate(${-faceW / 2},${-sprH + 10})`}>
                      {face.map(([row, col]) => (
                        <rect
                          key={`${row}-${col}`}
                          x={col * px}
                          y={row * px}
                          width={px}
                          height={px}
                          fill={isIdle ? "#1a1a1a" : "#000"}
                          opacity={isIdle ? 0.6 : 1}
                        />
                      ))}
                    </g>

                    {/* State ring around head */}
                    {!isIdle && (
                      <circle
                        cx={0}
                        cy={-sprH + 16}
                        r={sprW * 0.42}
                        fill="none"
                        stroke={stateColor}
                        strokeWidth={1.5}
                        strokeDasharray="3 3"
                        opacity={0.5}
                      >
                        <animate
                          attributeName="stroke-dashoffset"
                          from="0"
                          to="-18"
                          dur={
                            ent.state === "thinking"
                              ? "1.5s"
                              : ent.state === "speaking"
                                ? "0.6s"
                                : "2s"
                          }
                          repeatCount="indefinite"
                        />
                      </circle>
                    )}

                    {/* Speaking indicator — sound waves */}
                    {ent.state === "speaking" && (
                      <>
                        <path
                          d={`M ${sprW / 2 + 4} ${-sprH + 12} q 4 4 0 8`}
                          fill="none"
                          stroke={stateColor}
                          strokeWidth={1.5}
                          opacity={0.4}
                        />
                        <path
                          d={`M ${sprW / 2 + 8} ${-sprH + 9} q 6 7 0 14`}
                          fill="none"
                          stroke={stateColor}
                          strokeWidth={1}
                          opacity={0.25}
                        />
                      </>
                    )}

                    {/* Thinking indicator — dots */}
                    {ent.state === "thinking" && (
                      <g>
                        <circle cx={-6} cy={-sprH - 6} r={2} fill={stateColor} opacity={0.5}>
                          <animate
                            attributeName="opacity"
                            values="0.2;0.6;0.2"
                            dur="1.5s"
                            repeatCount="indefinite"
                          />
                        </circle>
                        <circle cx={0} cy={-sprH - 10} r={2.5} fill={stateColor} opacity={0.5}>
                          <animate
                            attributeName="opacity"
                            values="0.2;0.6;0.2"
                            dur="1.5s"
                            begin="0.3s"
                            repeatCount="indefinite"
                          />
                        </circle>
                        <circle cx={6} cy={-sprH - 6} r={2} fill={stateColor} opacity={0.5}>
                          <animate
                            attributeName="opacity"
                            values="0.2;0.6;0.2"
                            dur="1.5s"
                            begin="0.6s"
                            repeatCount="indefinite"
                          />
                        </circle>
                      </g>
                    )}

                    {/* Entity name below — bolder */}
                    <text
                      y={14}
                      textAnchor="middle"
                      fontFamily="'Press Start 2P'"
                      fontSize={8}
                      fontWeight="bold"
                      fill={ec}
                      opacity={0.95}
                      letterSpacing={0.5}
                    >
                      {ent.name.length > 7 ? `${ent.name.substring(0, 6)}…` : ent.name}
                    </text>

                    {/* State label — more visible */}
                    <text
                      y={25}
                      textAnchor="middle"
                      fontFamily="'VT323'"
                      fontSize={12}
                      fill={stateColor}
                      opacity={0.75}
                    >
                      {ent.state}
                    </text>
                  </g>
                );
              },
            )}

          {/* Mini entity sprites for when zoomed out — orbiting blips */}
          {!showEntityDetail &&
            entities.length > 0 &&
            entities.slice(0, 8).map((ent, i) => {
              const count = Math.min(entities.length, 8);
              const dur = 25;
              const offset = count > 1 ? -(i / count) * dur : 0;
              const ec = KIND_COLORS[ent.kind] ?? "#FFDD00";
              return (
                <g key={ent.name}>
                  <animateMotion
                    dur={`${dur}s`}
                    repeatCount="indefinite"
                    path={orbitPath}
                    begin={`${offset}s`}
                  />
                  {/* Mini body */}
                  <rect x={-6} y={-14} width={12} height={14} rx={2} fill={ec} opacity={0.7} />
                  {/* Mini eyes */}
                  <rect x={-4} y={-11} width={2} height={2} fill="#000" opacity={0.7} />
                  <rect x={2} y={-11} width={2} height={2} fill="#000" opacity={0.7} />
                </g>
              );
            })}

          {/* ═══ LAYER 3: STATUS NODE (clickable intent/action point) ═══ */}

          {/* biome-ignore lint/a11y/noStaticElementInteractions: SVG <g> status node; cannot be a <button>, keyboard nav is via the room action menu */}
          <g
            transform={`translate(0,${-h})`}
            style={{ cursor: onRoomAction ? "pointer" : undefined }}
            onClick={(e) => {
              if (onRoomAction) {
                e.stopPropagation();
                onRoomAction(roomId, e.clientX, e.clientY);
              }
            }}
          >
            {/* Outer ring — activity indicator, bolder */}
            <circle
              r={cr}
              fill="none"
              stroke={color}
              strokeWidth={3}
              strokeDasharray={isActive ? "5 3" : "3 5"}
              opacity={isActive ? 0.7 : 0.35}
            >
              {isActive && (
                <animate
                  attributeName="stroke-dashoffset"
                  from="0"
                  to="-18"
                  dur={`${crownSpeed}s`}
                  repeatCount="indefinite"
                />
              )}
            </circle>

            {/* Background disc — more solid */}
            <circle
              r={cr * 0.82}
              fill={`rgba(${rgb},0.25)`}
              stroke={color}
              strokeWidth={1.5}
              opacity={isActive ? 0.8 : 0.5}
            />

            {/* Center content — shows entity count or task count */}
            {entities.length > 0 ? (
              <>
                {/* Entity count number */}
                <text
                  textAnchor="middle"
                  y={-3}
                  fontSize={cr * 0.55}
                  fontFamily="Orbitron"
                  fontWeight={700}
                  fill={color}
                  opacity={0.9}
                >
                  {entities.length}
                </text>
                {/* Label */}
                <text
                  textAnchor="middle"
                  y={cr * 0.35}
                  fontSize={Math.max(5, cr * 0.2)}
                  fontFamily="'Press Start 2P'"
                  fill={color}
                  opacity={0.5}
                  letterSpacing={0.5}
                >
                  {entities.length === 1 ? "ENTITY" : "HERE"}
                </text>
              </>
            ) : taskCount && taskCount > 0 ? (
              <>
                <text
                  textAnchor="middle"
                  y={-3}
                  fontSize={cr * 0.55}
                  fontFamily="Orbitron"
                  fontWeight={700}
                  fill="#22c55e"
                  opacity={0.9}
                >
                  {taskCount}
                </text>
                <text
                  textAnchor="middle"
                  y={cr * 0.35}
                  fontSize={Math.max(5, cr * 0.2)}
                  fontFamily="'Press Start 2P'"
                  fill="#22c55e"
                  opacity={0.5}
                  letterSpacing={0.5}
                >
                  TASKS
                </text>
              </>
            ) : (
              <>
                {/* Empty room — action prompt dot */}
                <circle r={4} fill={color} opacity={coreBright} />
                {isHot && (
                  <circle r={4} fill={color} opacity={0}>
                    <animate attributeName="r" values="4;12" dur="2s" repeatCount="indefinite" />
                    <animate
                      attributeName="opacity"
                      values="0.4;0"
                      dur="2s"
                      repeatCount="indefinite"
                    />
                  </circle>
                )}
              </>
            )}

            {/* Breathing pulse on activity */}
            {breathDur > 0 && (
              <animateTransform
                attributeName="transform"
                type="scale"
                values={`1;${breathAmp};1`}
                dur={`${breathDur}s`}
                repeatCount="indefinite"
                additive="sum"
              />
            )}
          </g>

          {/* ═══ LABELS ═══ */}

          {/* Room name */}
          <text
            y={-h - cr - 28}
            textAnchor="middle"
            fontSize={15}
            fontFamily="'Press Start 2P'"
            fill={color}
            opacity={0.8}
            letterSpacing={2}
          >
            {short.length > 14 ? `${short.substring(0, 13)}…` : short.toUpperCase()}
          </text>

          {/* Entity count — only when populated */}
          {entities.length > 0 && (
            <text
              y={-h - cr - 10}
              textAnchor="middle"
              fontSize={18}
              fontFamily="Orbitron"
              fontWeight={700}
              fill={color}
              filter={`url(#g-${roomId})`}
              opacity={0.85}
            >
              {entities.length} {entities.length === 1 ? "entity" : "entities"}
            </text>
          )}
        </g>
      </svg>
    </div>
  );
});

/** Kind → colors for the pill. Keep in lockstep with InteractionArc colors
 *  so the same kind reads the same everywhere on the map. */
const ROOM_MSG_KIND_COLOR: Record<RoomMessage["kind"], string> = {
  say: "#06b6d4", // cyan — matches INTERACTION_COLORS.say
  emote: "#ec4899", // fuchsia — matches INTERACTION_COLORS.emote
};

const PILL_FADE_HOLD = 0.65; // portion of lifetime before fade starts

/**
 * Glass pill floating above the room platform. Shows sender + body of
 * the most recent `say` / `emote` inside the room. Dark background for
 * legibility over any district color; kind-tinted border so the reader
 * can distinguish a spoken line from an emote at a glance. Fades after
 * most of the lifetime has elapsed so the reader can catch up.
 */
const RoomMessagePill = memo(function RoomMessagePill({
  message,
  districtColor: _districtColor,
  roomKey: _roomKey,
}: {
  message: RoomMessage;
  districtColor: string;
  roomKey: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(interval);
  }, []);

  const age = now - message.timestamp;
  const t = age / ROOM_MESSAGE_LIFETIME_MS;
  if (t >= 1) return null;
  const opacity =
    t < PILL_FADE_HOLD ? 1 : Math.max(0, 1 - (t - PILL_FADE_HOLD) / (1 - PILL_FADE_HOLD));

  const color = ROOM_MSG_KIND_COLOR[message.kind];
  const bodyClipped = message.body.length > 58 ? `${message.body.slice(0, 57)}…` : message.body;

  return (
    <div
      style={{
        position: "absolute",
        top: -46,
        left: 60, // room node width/2 so the pill centers over the platform
        transform: "translateX(-50%)",
        maxWidth: 260,
        pointerEvents: "none",
        opacity,
        transition: "opacity 0.2s ease-out",
        zIndex: 5,
      }}
    >
      <div
        style={{
          background: "rgba(10, 12, 16, 0.88)",
          border: `1px solid ${color}`,
          borderRadius: 8,
          padding: "4px 9px",
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: 10,
          lineHeight: 1.3,
          color: "#f0f2f5",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          boxShadow: `0 0 12px ${color}22`,
        }}
      >
        <span style={{ color, fontWeight: 700, marginRight: 6 }}>
          {message.sender}
          {message.kind === "emote" ? " *" : ""}
        </span>
        <span style={{ opacity: 0.92 }}>{bodyClipped}</span>
      </div>
    </div>
  );
});
