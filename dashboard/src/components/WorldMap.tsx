import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crosshair,
  Map as MapIcon,
  Minus,
  Plus,
} from "lucide-react";
import { type AnimationPlaybackControlsWithThen, animate, motion } from "motion/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOperationalAlerts } from "../hooks/use-api";
import { useWorldState } from "../hooks/use-world-state";
import type { DashboardEvent, WorldData } from "../lib/types";
import {
  computeLayout,
  getDistrictColor,
  getDistrictLabel,
  type RoomPosition,
} from "../lib/world-graph";
import { TimelineStrip } from "../unified/overlays/TimelineStrip";
import { GlassPanel, type PanelFocusProps } from "./GlassPanel";

const DEFAULT_VIEWBOX = { x: 50, y: 10, w: 900, h: 730 };

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ── Memoized Room Node ────────────────────────────────────────────────
interface RoomNodeProps {
  room: RoomPosition;
  pop: number;
  isSelected: boolean;
  isHighlighted: boolean;
  isHub: boolean;
  shortName: string;
  entityNames: string[];
  onSelect: (roomId: string, isSelected: boolean) => void;
  onHover: (room: RoomPosition, radius: number, shortName: string, names: string[]) => void;
  onLeave: () => void;
}

const RoomNode = React.memo(function RoomNode({
  room,
  pop,
  isSelected,
  isHighlighted,
  isHub,
  shortName,
  entityNames,
  onSelect,
  onHover,
  onLeave,
}: RoomNodeProps) {
  const color = getDistrictColor(room.district);
  const baseRadius = isHub ? 14 : 8;
  const radius = baseRadius + Math.min(pop * 2.5, 10);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: SVG <g> cannot be a button; pointer-only room node, keyboard nav via room tree panel
    <g
      data-room-id={room.id}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(room.id, isSelected);
      }}
      onMouseEnter={() => onHover(room, radius, shortName, entityNames)}
      onMouseLeave={onLeave}
      className="cursor-pointer"
    >
      {/* Ambient halo */}
      <circle
        data-room-halo={room.id}
        cx={room.x}
        cy={room.y}
        r={radius + 8}
        fill="none"
        stroke={color}
        strokeWidth={0.5}
        opacity={isSelected ? 0.5 : 0.15}
      />

      {/* Population pulse ring */}
      {pop > 0 && (
        <circle
          cx={room.x}
          cy={room.y}
          r={radius + 5}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          opacity={0.2}
        >
          <animate
            attributeName="opacity"
            values="0.15;0.5;0.15"
            dur="2.5s"
            repeatCount="indefinite"
          />
        </circle>
      )}

      {/* Selection ring — shared layoutId so the ring smoothly morphs from
          the previously selected room to this one when selection changes. */}
      {isSelected && (
        <motion.circle
          layoutId="world-map-selection"
          cx={room.x}
          cy={room.y}
          r={radius + 11}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          opacity={0.7}
          filter="url(#glow-sm)"
          transition={{ type: "spring", stiffness: 280, damping: 26 }}
        />
      )}

      {/* Keyboard highlight ring */}
      {isHighlighted && !isSelected && (
        <circle
          cx={room.x}
          cy={room.y}
          r={radius + 11}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth={1}
          strokeDasharray="4 3"
          opacity={0.7}
        />
      )}

      {/* Hub decorative rotating rings */}
      {isHub && (
        <circle
          cx={room.x}
          cy={room.y}
          r={radius + 20}
          fill="none"
          stroke={color}
          strokeWidth={0.6}
          strokeDasharray="3 5"
          opacity={0.3}
        >
          <animateTransform
            attributeName="transform"
            type="rotate"
            from={`0 ${room.x} ${room.y}`}
            to={`360 ${room.x} ${room.y}`}
            dur="30s"
            repeatCount="indefinite"
          />
        </circle>
      )}
      {isHub && (
        <circle
          cx={room.x}
          cy={room.y}
          r={radius + 26}
          fill="none"
          stroke={color}
          strokeWidth={0.4}
          strokeDasharray="2 8"
          opacity={0.2}
        >
          <animateTransform
            attributeName="transform"
            type="rotate"
            from={`360 ${room.x} ${room.y}`}
            to={`0 ${room.x} ${room.y}`}
            dur="45s"
            repeatCount="indefinite"
          />
        </circle>
      )}

      {/* Room circle */}
      <circle
        cx={room.x}
        cy={room.y}
        r={radius}
        fill={pop > 0 ? color : "var(--color-bg-card)"}
        fillOpacity={pop > 0 ? 0.2 : 0.5}
        stroke={color}
        strokeWidth={isSelected ? 2 : isHub ? 1.5 : 1}
        opacity={isSelected ? 1 : 0.75}
        filter={pop > 0 || isHub ? "url(#glow-sm)" : undefined}
      />

      {/* Hub inner core glow */}
      {isHub && (
        <circle cx={room.x} cy={room.y} r={4} fill={color} opacity={0.6} filter="url(#glow-md)">
          <animate attributeName="opacity" values="0.4;0.8;0.4" dur="3s" repeatCount="indefinite" />
        </circle>
      )}

      {/* Room label */}
      <text
        x={room.x}
        y={room.y + radius + 12}
        textAnchor="middle"
        fill={isSelected ? color : "var(--color-text-dim)"}
        fontSize={isHub ? 9 : 7.5}
        fontFamily="Share Tech Mono, monospace"
        fontWeight={isHub ? 700 : 400}
      >
        {shortName}
      </text>
    </g>
  );
});

// ── Memoized Entity Dots ──────────────────────────────────────────────
interface EntityDotsProps {
  roomId: string;
  entities: { id: string; name: string; kind: string }[];
  pos: RoomPosition;
  isHub: boolean;
  onSelectEntity: (name: string) => void;
}

const EntityDots = React.memo(function EntityDots({
  entities,
  pos,
  isHub,
  onSelectEntity,
}: EntityDotsProps) {
  const baseRadius = (isHub ? 14 : 8) + Math.min(entities.length * 2.5, 10);

  return (
    <>
      {entities.map((ent, i) => {
        const angle = (2 * Math.PI * i) / entities.length - Math.PI / 2;
        const orbitR = baseRadius + 10;
        const ex = pos.x + Math.cos(angle) * orbitR;
        const ey = pos.y + Math.sin(angle) * orbitR;
        const dotColor =
          ent.kind === "agent"
            ? "var(--color-primary)"
            : ent.kind === "npc"
              ? "var(--color-warning)"
              : "var(--color-text-dim)";

        return (
          <g key={ent.id}>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: SVG <circle> cannot be a button; pointer-only entity dot, keyboard nav via entity panel */}
            <circle
              cx={ex}
              cy={ey}
              r={3.5}
              fill={dotColor}
              opacity={0.9}
              filter="url(#glow-sm)"
              className="cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                onSelectEntity(ent.name);
              }}
            />
            <circle
              cx={ex}
              cy={ey}
              r={1.2}
              fill="white"
              opacity={0.8}
              style={{ pointerEvents: "none" }}
            />
          </g>
        );
      })}
    </>
  );
});

// ── Main WorldMap Component ───────────────────────────────────────────
interface WorldMapProps extends PanelFocusProps {
  worldData?: WorldData;
  backContent?: React.ReactNode;
}

export function WorldMap({ worldData, backContent, isFocused, onToggleFocus }: WorldMapProps) {
  const selectedRoom = useWorldState((s) => s.selectedRoom);
  const selectRoom = useWorldState((s) => s.selectRoom);
  const selectEntity = useWorldState((s) => s.selectEntity);
  const wsEntities = useWorldState((s) => s.entities);
  const wsRooms = useWorldState((s) => s.rooms);
  const roomPops = useWorldState((s) => s.roomPopulations);
  const wsStartRoom = useWorldState((s) => s.startRoom);
  const wsWorldName = useWorldState((s) => s.worldName);
  const { data: operationalAlerts = [] } = useOperationalAlerts();
  // NOTE: eventFeed is intentionally NOT subscribed reactively. It changes on
  // every event batch; subscribing here re-rendered this entire ~1150-line SVG
  // map on every event. The two effects that need it read it imperatively
  // (getState / a non-rendering store subscription) so the map only re-renders
  // when entities/rooms actually change.

  const startRoom = wsStartRoom || worldData?.startRoom || "";
  const worldName = wsWorldName || worldData?.worldName || "";

  const [viewBox, setViewBox] = useState(DEFAULT_VIEWBOX);
  const svgRef = useRef<SVGSVGElement>(null);
  const trailsRef = useRef<SVGGElement>(null);
  const rippleRef = useRef<SVGGElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    lines: string[];
  } | null>(null);
  const [highlightedRoom, setHighlightedRoom] = useState<string | null>(null);
  const [layers, setLayers] = useState({ activity: true, alerts: true, entities: true });
  const [activityCounts, setActivityCounts] = useState<Map<string, number>>(new Map());

  // Animation refs
  const hasInitializedRef = useRef(false);
  const entityRoomRef = useRef<Map<string, string>>(new Map());
  const activeTrailsRef = useRef(0);
  const breatheTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const breatheAnimsRef = useRef<Map<string, AnimationPlaybackControlsWithThen>>(new Map());
  const prevSelectedRef = useRef<string | null>(null);

  // ── Compute room positions + edges from live data ─────────────────
  const { allPositions, allEdges, posMap } = useMemo(() => {
    const rooms = wsRooms.length > 0 ? wsRooms : (worldData?.rooms ?? []);
    const { positions, edges } = computeLayout(rooms, startRoom);
    const pm = new Map(positions.map((p) => [p.id, p]));
    return { allPositions: positions, allEdges: edges, posMap: pm };
  }, [wsRooms, worldData, startRoom]);

  // ── District zones ────────────────────────────────────────────────
  const districtZones = useMemo(() => {
    const districts = new Map<string, RoomPosition[]>();
    for (const pos of allPositions) {
      const arr = districts.get(pos.district) || [];
      arr.push(pos);
      districts.set(pos.district, arr);
    }
    return Array.from(districts.entries()).map(([district, rooms]) => {
      const cx = avg(rooms.map((r) => r.x));
      const cy = avg(rooms.map((r) => r.y));
      const maxDist = Math.max(...rooms.map((r) => Math.sqrt((r.x - cx) ** 2 + (r.y - cy) ** 2)));
      return {
        district,
        cx,
        cy,
        radius: maxDist + 70,
        color: getDistrictColor(district),
        label: getDistrictLabel(district),
      };
    });
  }, [allPositions]);

  // ── Resolved adjacent grid edges (for pulse particles) ──────────────
  const gridEdgesResolved = useMemo(() => {
    return allEdges
      .filter((e) => e.gridEdge && e.adjacent)
      .map((edge) => {
        const from = posMap.get(edge.from);
        const to = posMap.get(edge.to);
        if (!from || !to) return null;
        return { edge, from, to, color: getDistrictColor(from.district) };
      })
      .filter((g): g is NonNullable<typeof g> => g != null);
  }, [allEdges, posMap]);

  // ── Cross-district edges with gradient data ───────────────────────
  const crossEdges = useMemo(() => {
    return allEdges
      .filter((e) => e.crossDistrict)
      .map((edge) => {
        const from = posMap.get(edge.from);
        const to = posMap.get(edge.to);
        if (!from || !to) return null;
        const id = `eg-${edge.from.replace(/\//g, "-")}-${edge.to.replace(/\//g, "-")}`;
        return {
          edge,
          from,
          to,
          fromColor: getDistrictColor(from.district),
          toColor: getDistrictColor(to.district),
          id,
        };
      })
      .filter((g): g is NonNullable<typeof g> => g != null);
  }, [allEdges, posMap]);

  // ── Entity grouping by room ───────────────────────────────────────
  const entityPositions = useMemo(() => {
    const byRoom = new Map<string, typeof wsEntities>();
    for (const e of wsEntities) {
      const arr = byRoom.get(e.room) || [];
      arr.push(e);
      byRoom.set(e.room, arr);
    }
    return byRoom;
  }, [wsEntities]);

  const alertRooms = useMemo(() => {
    const grouped = new Map<string, { count: number; critical: number; titles: string[] }>();
    for (const alert of operationalAlerts) {
      if (alert.status === "resolved") continue;
      let roomId = startRoom;
      if (alert.alert_key.startsWith("agent:")) {
        const name = alert.alert_key.split(":")[1];
        roomId = wsEntities.find((entity) => entity.name === name)?.room ?? startRoom;
      }
      if (!roomId || !posMap.has(roomId)) continue;
      const current = grouped.get(roomId) ?? { count: 0, critical: 0, titles: [] };
      current.count++;
      if (alert.severity === "critical") current.critical++;
      current.titles.push(alert.title);
      grouped.set(roomId, current);
    }
    return grouped;
  }, [operationalAlerts, posMap, startRoom, wsEntities]);

  // ── Room short name lookup ────────────────────────────────────────
  const roomShorts = useMemo(() => {
    const m = new Map<string, string>();
    const rooms = wsRooms.length > 0 ? wsRooms : (worldData?.rooms ?? []);
    for (const r of rooms) m.set(r.id, r.short);
    return m;
  }, [wsRooms, worldData]);

  // ── 2.1: Map Materialization on First Load ────────────────────────
  useEffect(() => {
    if (
      hasInitializedRef.current ||
      !svgRef.current ||
      prefersReducedMotion() ||
      allPositions.length === 0
    )
      return;
    hasInitializedRef.current = true;

    const svg = svgRef.current;
    const hubPos = posMap.get(startRoom);

    // Sort rooms by distance from hub
    const sorted = [...allPositions].sort((a, b) => {
      if (!hubPos) return 0;
      const da = Math.sqrt((a.x - hubPos.x) ** 2 + (a.y - hubPos.y) ** 2);
      const db = Math.sqrt((b.x - hubPos.x) ** 2 + (b.y - hubPos.y) ** 2);
      return da - db;
    });

    const roomEls = sorted
      .map((r) => svg.querySelector(`[data-room-id="${r.id}"]`))
      .filter((el): el is Element => el != null);

    const edgeEls = svg.querySelectorAll("line");

    // Hub first, then remaining rooms staggered, then edges. Each call is a
    // separate Motion animation; their durations + delays compose into the
    // same materialization sequence the old timeline produced.
    if (roomEls.length > 0) {
      animate(
        roomEls[0]!,
        { scale: [0, 1], opacity: [0, 1] },
        { duration: 0.6, type: "spring", stiffness: 120, damping: 14 },
      );
    }
    roomEls.slice(1).forEach((el, i) => {
      animate(
        el,
        { scale: [0, 1], opacity: [0, 1] },
        {
          duration: 0.4,
          delay: 0.3 + i * 0.04,
          type: "spring",
          stiffness: 120,
          damping: 14,
        },
      );
    });
    edgeEls.forEach((el, i) => {
      animate(el, { opacity: [0, 0.3] }, { duration: 0.3, delay: 0.4 + i * 0.02 });
    });
  }, [allPositions, posMap, startRoom]);

  // ── 2.2: Entity Movement Trails ───────────────────────────────────
  // Driven by a non-rendering store subscription: the handler fires on event
  // batches and animates SVG circles imperatively, so new events never trigger
  // a React re-render of the map. Re-subscribes only when positions change.
  useEffect(() => {
    if (prefersReducedMotion() || allPositions.length === 0) return;

    const processMovement = (eventFeed: DashboardEvent[]) => {
      if (!trailsRef.current) return;
      const wsEntities = useWorldState.getState().entities;
      for (const ev of eventFeed.slice(0, 20)) {
        if (ev.type === "entity_enter" && ev.entity && ev.room) {
          const prevRoom = entityRoomRef.current.get(ev.entity);
          entityRoomRef.current.set(ev.entity, ev.room);

          if (prevRoom && prevRoom !== ev.room && activeTrailsRef.current < 10) {
            const from = posMap.get(prevRoom);
            const to = posMap.get(ev.room);
            if (!from || !to) continue;

            activeTrailsRef.current++;

            // Determine color by entity kind
            const ent = wsEntities.find((e) => e.id === ev.entity);
            const color =
              ent?.kind === "agent"
                ? getComputedStyle(document.documentElement)
                    .getPropertyValue("--color-primary")
                    .trim()
                : ent?.kind === "npc"
                  ? getComputedStyle(document.documentElement)
                      .getPropertyValue("--color-warning")
                      .trim()
                  : getComputedStyle(document.documentElement)
                      .getPropertyValue("--color-text-dim")
                      .trim();

            // Create temp SVG circle
            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            circle.setAttribute("r", "3");
            circle.setAttribute("fill", color);
            circle.setAttribute("filter", "url(#glow-sm)");
            circle.setAttribute("cx", String(from.x));
            circle.setAttribute("cy", String(from.y));
            trailsRef.current.appendChild(circle);

            animate(
              circle,
              {
                cx: [from.x, to.x],
                cy: [from.y, to.y],
                opacity: [0.8, 0],
                r: [3, 1.5],
              },
              {
                duration: 0.8,
                ease: "easeOut",
                onComplete: () => {
                  circle.remove();
                  activeTrailsRef.current--;
                },
              },
            );
          }
        } else if (ev.type === "entity_leave" && ev.entity && ev.room) {
          entityRoomRef.current.set(ev.entity, ev.room);
        }
      }
    };

    processMovement(useWorldState.getState().eventFeed);
    const unsub = useWorldState.subscribe((state, prev) => {
      if (state.eventFeed !== prev.eventFeed) processMovement(state.eventFeed);
    });
    return unsub;
  }, [posMap, allPositions]);

  // ── 2.3: Room Activity Breathing ──────────────────────────────────
  useEffect(() => {
    if (prefersReducedMotion() || !svgRef.current) return;

    function recomputeBreathing() {
      if (!svgRef.current) return;
      const now = Date.now();
      const thirtySecsAgo = now - 30_000;

      // Read the feed imperatively — this runs on a 5s timer, not per event.
      const eventFeed = useWorldState.getState().eventFeed;
      // Count events per room in last 30s
      const roomActivity = new Map<string, number>();
      for (const ev of eventFeed) {
        if (ev.timestamp < thirtySecsAgo) break;
        if (ev.room) {
          roomActivity.set(ev.room, (roomActivity.get(ev.room) ?? 0) + 1);
        }
      }

      const maxActivity = Math.max(1, ...roomActivity.values());
      setActivityCounts(roomActivity);

      for (const [roomId, count] of roomActivity) {
        const halo = svgRef.current!.querySelector(`[data-room-halo="${roomId}"]`);
        if (!halo) continue;

        // Cancel previous animation
        const prev = breatheAnimsRef.current.get(roomId);
        if (prev) prev.pause();

        const intensity = count / maxActivity;
        const dur = Math.max(800, 2500 - intensity * 1500);

        const anim = animate(
          halo,
          { opacity: [0.15, 0.15 + intensity * 0.4, 0.15] },
          { duration: dur / 1000, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" },
        );
        breatheAnimsRef.current.set(roomId, anim);
      }
    }

    recomputeBreathing();
    breatheTimerRef.current = setInterval(recomputeBreathing, 5000);

    return () => {
      if (breatheTimerRef.current) {
        clearInterval(breatheTimerRef.current);
      }
      for (const anim of breatheAnimsRef.current.values()) {
        anim.pause();
      }
      breatheAnimsRef.current.clear();
    };
    // Runs once on mount: the timer reads the live feed via getState, so this
    // effect no longer tears down + rebuilds (and restarts every room's infinite
    // breathing animation) on every incoming event.
  }, []);

  // ── 2.3b: Reduced-motion SMIL kill switch ─────────────────────────
  // The map has ~10 indefinite SMIL loops (population pulse rings, rotating hub
  // rings, hub glows, cross-edge pulse particles). pauseAnimations() freezes the
  // whole SVG's SMIL timeline in one call — including elements added later, since
  // the timeline itself is paused — so reduce-motion yields a fully static map
  // with zero per-element gating. Reacts live to the OS setting changing.
  useEffect(() => {
    const svg = svgRef.current;
    // pause/unpauseAnimations are SMIL methods absent in jsdom (and very old
    // engines) — guard so tests and unsupported environments don't throw.
    if (!svg || typeof svg.pauseAnimations !== "function" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      // Pausing the SVG's SMIL timeline also freezes elements mounted later,
      // so this runs once on mount; the listener handles live toggles.
      if (mq.matches) svg.pauseAnimations();
      else svg.unpauseAnimations();
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // ── 2.4: Selection Ripple ─────────────────────────────────────────
  useEffect(() => {
    if (
      !selectedRoom ||
      selectedRoom === prevSelectedRef.current ||
      prefersReducedMotion() ||
      !rippleRef.current
    ) {
      prevSelectedRef.current = selectedRoom;
      return;
    }
    prevSelectedRef.current = selectedRoom;

    const pos = posMap.get(selectedRoom);
    if (!pos) return;

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const color = getDistrictColor(pos.district);
    circle.setAttribute("cx", String(pos.x));
    circle.setAttribute("cy", String(pos.y));
    circle.setAttribute("r", "0");
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", color);
    circle.setAttribute("stroke-width", "2");
    circle.setAttribute("opacity", "0.6");
    rippleRef.current.appendChild(circle);

    animate(
      circle,
      { r: [0, 60], opacity: [0.6, 0], strokeWidth: [2, 0.5] },
      {
        duration: 0.6,
        ease: "easeOut",
        onComplete: () => circle.remove(),
      },
    );
  }, [selectedRoom, posMap]);

  // ── Stable callbacks for memoized children ────────────────────────
  const handleRoomSelect = useCallback(
    (roomId: string, isSelected: boolean) => {
      selectRoom(isSelected ? null : roomId);
    },
    [selectRoom],
  );

  const handleRoomHover = useCallback(
    (room: RoomPosition, radius: number, short: string, names: string[]) => {
      const lines = [short];
      if (names.length > 0) lines.push(names.join(", "));
      setTooltip({ x: room.x, y: room.y - radius - 18, lines });
    },
    [],
  );

  const handleRoomLeave = useCallback(() => setTooltip(null), []);

  // ── Pan / zoom ────────────────────────────────────────────────────
  // Plain wheel/trackpad PANS (the predictable, map-standard behavior); zoom is
  // only on ⌘/Ctrl+wheel. Previously every wheel tick zoomed, which on trackpads
  // fired rapidly and felt like the map lurched in and out at random.
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const scale = e.deltaY > 0 ? 1.08 : 0.92;
      setViewBox((vb) => {
        const cx = vb.x + vb.w / 2;
        const cy = vb.y + vb.h / 2;
        const nw = Math.max(200, Math.min(2000, vb.w * scale));
        const nh = Math.max(150, Math.min(1500, vb.h * scale));
        return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
      });
      return;
    }
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    setViewBox((vb) => ({
      ...vb,
      x: vb.x + (e.deltaX / rect.width) * vb.w,
      y: vb.y + (e.deltaY / rect.height) * vb.h,
    }));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) dragRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragRef.current || !svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const dx = ((e.clientX - dragRef.current.x) / rect.width) * viewBox.w;
      const dy = ((e.clientY - dragRef.current.y) / rect.height) * viewBox.h;
      dragRef.current = { x: e.clientX, y: e.clientY };
      setViewBox((vb) => ({ ...vb, x: vb.x - dx, y: vb.y - dy }));
    },
    [viewBox.w, viewBox.h],
  );

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const zoomBy = useCallback((scale: number) => {
    setViewBox((vb) => {
      const cx = vb.x + vb.w / 2;
      const cy = vb.y + vb.h / 2;
      const nw = Math.max(200, Math.min(2000, vb.w * scale));
      const nh = Math.max(150, Math.min(1500, vb.h * scale));
      return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
    });
  }, []);

  const panViewTo = useCallback((px: number, py: number) => {
    setViewBox((vb) => ({
      ...vb,
      x: px - vb.w / 2,
      y: py - vb.h / 2,
    }));
  }, []);

  /** Pan by a fraction of the current view — a discrete, predictable step that
   *  scales with zoom, used by the compass buttons. */
  const panBy = useCallback((fx: number, fy: number) => {
    setViewBox((vb) => ({ ...vb, x: vb.x + vb.w * fx, y: vb.y + vb.h * fy }));
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const PAN = 50;
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          if (e.shiftKey) {
            zoomBy(0.9);
          } else {
            setViewBox((vb) => ({ ...vb, y: vb.y - PAN }));
          }
          break;
        case "ArrowDown":
          e.preventDefault();
          if (e.shiftKey) {
            zoomBy(1.1);
          } else {
            setViewBox((vb) => ({ ...vb, y: vb.y + PAN }));
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          setViewBox((vb) => ({ ...vb, x: vb.x - PAN }));
          break;
        case "ArrowRight":
          e.preventDefault();
          setViewBox((vb) => ({ ...vb, x: vb.x + PAN }));
          break;
        case "+":
        case "=":
          e.preventDefault();
          zoomBy(0.9);
          break;
        case "-":
          e.preventDefault();
          zoomBy(1.1);
          break;
        case "0":
          e.preventDefault();
          setViewBox(DEFAULT_VIEWBOX);
          break;
        case "Tab": {
          e.preventDefault();
          if (allPositions.length === 0) break;
          const dir = e.shiftKey ? -1 : 1;
          const curIdx = highlightedRoom
            ? allPositions.findIndex((p) => p.id === highlightedRoom)
            : -1;
          let next: number;
          if (curIdx === -1) {
            next = dir > 0 ? 0 : allPositions.length - 1;
          } else {
            next =
              (((curIdx + dir) % allPositions.length) + allPositions.length) % allPositions.length;
          }
          const pos = allPositions[next]!;
          setHighlightedRoom(pos.id);
          panViewTo(pos.x, pos.y);
          break;
        }
        case "Enter":
          e.preventDefault();
          if (highlightedRoom) {
            selectRoom(selectedRoom === highlightedRoom ? null : highlightedRoom);
          }
          break;
        case "Escape":
          setHighlightedRoom(null);
          break;
      }
    },
    [zoomBy, panViewTo, allPositions, highlightedRoom, selectRoom, selectedRoom],
  );

  const isHub = (id: string) => id === startRoom;

  return (
    <GlassPanel
      title={worldName ? `World Map — ${worldName}` : "World Map"}
      icon={<MapIcon size={14} />}
      backContent={backContent}
      isFocused={isFocused}
      onToggleFocus={onToggleFocus}
      headerExtra={
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setViewBox(DEFAULT_VIEWBOX);
            setHighlightedRoom(null);
          }}
          className="text-text-dim transition-colors hover:text-primary"
          title="Reset view (0)"
          aria-label="Reset map view"
        >
          <Crosshair size={11} />
        </button>
      }
    >
      <div className="flex h-full w-full flex-col">
        {/* Map area — the activity timeline is anchored below it (combined). */}
        <div className="relative min-h-0 flex-1">
          <svg
            ref={svgRef}
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
            className="h-full w-full cursor-grab outline-none focus:ring-1 focus:ring-primary/40 active:cursor-grabbing"
            role="img"
            aria-label="World map"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onKeyDown={handleKeyDown}
          >
            {/* ── Definitions ─────────────────────────────────── */}
            <defs>
              <filter id="glow-sm" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="2" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <filter id="glow-md" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="4" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>

              {/* District zone radial gradients */}
              {districtZones.map((z) => (
                <radialGradient key={`zg-${z.district}`} id={`zg-${z.district}`}>
                  <stop offset="0%" stopColor={z.color} stopOpacity="0.07" />
                  <stop offset="60%" stopColor={z.color} stopOpacity="0.025" />
                  <stop offset="100%" stopColor={z.color} stopOpacity="0" />
                </radialGradient>
              ))}

              {/* Cross-district edge linear gradients */}
              {crossEdges.map((g) => (
                <linearGradient
                  key={g.id}
                  id={g.id}
                  x1={g.from.x}
                  y1={g.from.y}
                  x2={g.to.x}
                  y2={g.to.y}
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0%" stopColor={g.fromColor} stopOpacity="0.7" />
                  <stop offset="100%" stopColor={g.toColor} stopOpacity="0.7" />
                </linearGradient>
              ))}

              {/* Arrowhead markers for directional edges */}
              <marker
                id="arrow-cyan"
                viewBox="0 0 6 6"
                refX="5"
                refY="3"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L6,3 L0,6 Z" fill="var(--color-primary)" opacity="0.6" />
              </marker>
              <marker
                id="arrow-dim"
                viewBox="0 0 6 6"
                refX="5"
                refY="3"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L6,3 L0,6 Z" fill="var(--color-text-dim)" opacity="0.5" />
              </marker>
            </defs>

            {/* ── Layer 1: District ambient zones ─────────────── */}
            {districtZones.map((z) => (
              <circle
                key={`zone-${z.district}`}
                cx={z.cx}
                cy={z.cy}
                r={z.radius}
                fill={`url(#zg-${z.district})`}
              />
            ))}

            {/* ── Layer 2: District labels (watermark) ────────── */}
            {districtZones.map((z) => (
              <text
                key={`dl-${z.district}`}
                x={z.cx}
                y={z.cy + 5}
                textAnchor="middle"
                dominantBaseline="central"
                fill={z.color}
                opacity={0.09}
                fontSize={22}
                fontFamily="Orbitron, monospace"
                fontWeight={700}
                letterSpacing="0.18em"
              >
                {z.label}
              </text>
            ))}

            {/* Recent activity heat, sampled every five seconds. */}
            {layers.activity &&
              allPositions.map((room) => {
                const count = activityCounts.get(room.id) ?? 0;
                if (!count) return null;
                const max = Math.max(1, ...activityCounts.values());
                const intensity = count / max;
                return (
                  <circle
                    key={`heat-${room.id}`}
                    cx={room.x}
                    cy={room.y}
                    r={26 + intensity * 24}
                    fill={getDistrictColor(room.district)}
                    opacity={0.04 + intensity * 0.1}
                    filter="url(#glow-md)"
                    style={{ pointerEvents: "none" }}
                  />
                );
              })}

            {/* ── Layer 3: Adjacent grid edges (solid, prominent) ── */}
            {allEdges
              .filter((e) => e.gridEdge && e.adjacent)
              .map((edge) => {
                const from = posMap.get(edge.from);
                const to = posMap.get(edge.to);
                if (!from || !to) return null;
                return (
                  <line
                    key={`e-${edge.from}-${edge.to}`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={getDistrictColor(from.district)}
                    strokeWidth={1.2}
                    opacity={0.35}
                  />
                );
              })}

            {/* ── Layer 3a: Non-adjacent grid edges (curved, dashed) ── */}
            {allEdges
              .filter((e) => e.gridEdge && !e.adjacent)
              .map((edge) => {
                const from = posMap.get(edge.from);
                const to = posMap.get(edge.to);
                if (!from || !to) return null;
                const mx = (from.x + to.x) / 2;
                const my = (from.y + to.y) / 2;
                // Curve control point perpendicular to midpoint
                const dx = to.x - from.x;
                const dy = to.y - from.y;
                const len = Math.sqrt(dx * dx + dy * dy) || 1;
                const cx = mx + (-dy / len) * 30;
                const cy = my + (dx / len) * 30;
                return (
                  <path
                    key={`e-${edge.from}-${edge.to}`}
                    d={`M${from.x},${from.y} Q${cx},${cy} ${to.x},${to.y}`}
                    stroke={getDistrictColor(from.district)}
                    strokeWidth={0.8}
                    opacity={0.25}
                    fill="none"
                    strokeDasharray="6 3"
                    markerEnd={!edge.bidirectional ? "url(#arrow-dim)" : undefined}
                  />
                );
              })}

            {/* ── Layer 3b: Non-grid within-district edges (directional) */}
            {allEdges
              .filter((e) => !e.crossDistrict && !e.gridEdge)
              .map((edge) => {
                const from = posMap.get(edge.from);
                const to = posMap.get(edge.to);
                if (!from || !to) return null;
                return (
                  <line
                    key={`e-${edge.from}-${edge.to}`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={getDistrictColor(from.district)}
                    strokeWidth={0.8}
                    opacity={0.15}
                    strokeDasharray="4 4"
                    markerEnd={!edge.bidirectional ? "url(#arrow-dim)" : undefined}
                  />
                );
              })}

            {/* ── Layer 4: Cross-district edges (gradient) ────── */}
            {crossEdges.map((g) => (
              <line
                key={`ce-${g.edge.from}-${g.edge.to}`}
                x1={g.from.x}
                y1={g.from.y}
                x2={g.to.x}
                y2={g.to.y}
                stroke={`url(#${g.id})`}
                strokeWidth={1.5}
                opacity={0.5}
                strokeDasharray="8 4"
                markerEnd={!g.edge.bidirectional ? "url(#arrow-cyan)" : undefined}
              />
            ))}

            {/* ── Layer 5: Pulse particles on cross edges ─────── */}
            {crossEdges.map((g, i) => {
              const dur = 3 + (i % 4);
              const reverse = i % 2 === 1;
              const x1 = reverse ? g.to.x : g.from.x;
              const y1 = reverse ? g.to.y : g.from.y;
              const x2 = reverse ? g.from.x : g.to.x;
              const y2 = reverse ? g.from.y : g.to.y;
              const color = reverse ? g.toColor : g.fromColor;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: pulse animation index is the visual identity
                <circle key={`pulse-${i}`} r={1.8} fill={color} opacity={0} filter="url(#glow-sm)">
                  <animate
                    attributeName="cx"
                    from={x1}
                    to={x2}
                    dur={`${dur}s`}
                    repeatCount="indefinite"
                    begin={`${i * 0.7}s`}
                  />
                  <animate
                    attributeName="cy"
                    from={y1}
                    to={y2}
                    dur={`${dur}s`}
                    repeatCount="indefinite"
                    begin={`${i * 0.7}s`}
                  />
                  <animate
                    attributeName="opacity"
                    values="0;0.8;0.8;0"
                    keyTimes="0;0.1;0.9;1"
                    dur={`${dur}s`}
                    repeatCount="indefinite"
                    begin={`${i * 0.7}s`}
                  />
                </circle>
              );
            })}

            {/* ── Layer 5b: Pulse particles on grid edges ─────── */}
            {gridEdgesResolved.map((g, i) => {
              const dur = 4 + (i % 5);
              const reverse = i % 2 === 1;
              const x1 = reverse ? g.to.x : g.from.x;
              const y1 = reverse ? g.to.y : g.from.y;
              const x2 = reverse ? g.from.x : g.to.x;
              const y2 = reverse ? g.from.y : g.to.y;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: gateway pulse index is the visual identity
                <circle key={`gpulse-${i}`} r={1.2} fill={g.color} opacity={0}>
                  <animate
                    attributeName="cx"
                    from={x1}
                    to={x2}
                    dur={`${dur}s`}
                    repeatCount="indefinite"
                    begin={`${i * 0.5}s`}
                  />
                  <animate
                    attributeName="cy"
                    from={y1}
                    to={y2}
                    dur={`${dur}s`}
                    repeatCount="indefinite"
                    begin={`${i * 0.5}s`}
                  />
                  <animate
                    attributeName="opacity"
                    values="0;0.5;0.5;0"
                    keyTimes="0;0.15;0.85;1"
                    dur={`${dur}s`}
                    repeatCount="indefinite"
                    begin={`${i * 0.5}s`}
                  />
                </circle>
              );
            })}

            {/* ── Layer 6: Room nodes (memoized) ──────────────── */}
            {allPositions.map((room) => {
              const pop = roomPops[room.id] ?? 0;
              const ents = entityPositions.get(room.id);
              const names = ents?.map((ent) => ent.name) || [];
              const short = roomShorts.get(room.id) ?? room.id.split("/")[1] ?? room.id;
              return (
                <RoomNode
                  key={room.id}
                  room={room}
                  pop={pop}
                  isSelected={selectedRoom === room.id}
                  isHighlighted={highlightedRoom === room.id}
                  isHub={isHub(room.id)}
                  shortName={short}
                  entityNames={names}
                  onSelect={handleRoomSelect}
                  onHover={handleRoomHover}
                  onLeave={handleRoomLeave}
                />
              );
            })}

            {/* Spatial operations markers. Agent alerts follow the agent;
                world-level readiness/memory/project alerts anchor at the hub. */}
            {layers.alerts &&
              Array.from(alertRooms.entries()).map(([roomId, alert]) => {
                const pos = posMap.get(roomId);
                if (!pos) return null;
                const color = alert.critical ? "var(--color-danger)" : "var(--color-warning)";
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: SVG group marker mirrors room-node pointer interaction; keyboard room navigation remains available
                  <g
                    key={`alert-${roomId}`}
                    className="cursor-pointer"
                    onClick={(event) => {
                      event.stopPropagation();
                      selectRoom(roomId);
                    }}
                  >
                    <circle
                      cx={pos.x + 18}
                      cy={pos.y - 18}
                      r={9}
                      fill="var(--color-bg-card)"
                      stroke={color}
                      strokeWidth={1.5}
                      filter="url(#glow-sm)"
                    >
                      {alert.critical > 0 && (
                        <animate
                          attributeName="r"
                          values="8;11;8"
                          dur="1.4s"
                          repeatCount="indefinite"
                        />
                      )}
                    </circle>
                    <text
                      x={pos.x + 18}
                      y={pos.y - 15}
                      textAnchor="middle"
                      fill={color}
                      fontSize={8}
                      fontWeight={700}
                    >
                      {alert.count}
                    </text>
                    <title>{alert.titles.join(" · ")}</title>
                  </g>
                );
              })}

            {/* ── Layer 7: Entity orbit dots (memoized) ───────── */}
            {layers.entities &&
              Array.from(entityPositions.entries()).map(([roomId, ents]) => {
                const pos = posMap.get(roomId);
                if (!pos) return null;
                return (
                  <EntityDots
                    key={roomId}
                    roomId={roomId}
                    entities={ents}
                    pos={pos}
                    isHub={isHub(roomId)}
                    onSelectEntity={selectEntity}
                  />
                );
              })}

            {/* ── Layer 8: Entity movement trails ─────────────── */}
            <g ref={trailsRef} />

            {/* ── Layer 9: Selection ripples ──────────────────── */}
            <g ref={rippleRef} />

            {/* ── Tooltip ─────────────────────────────────────── */}
            {tooltip && (
              <g>
                {(() => {
                  const lineH = 10;
                  const pad = 6;
                  const maxLen = Math.max(...tooltip.lines.map((l) => l.length));
                  const w = Math.max(maxLen * 5 + pad * 2, 60);
                  const h = tooltip.lines.length * lineH + pad * 2;
                  return (
                    <>
                      <rect
                        x={tooltip.x - w / 2}
                        y={tooltip.y - h / 2}
                        width={w}
                        height={h}
                        rx={4}
                        fill="var(--color-bg-card)"
                        stroke="var(--color-border)"
                        strokeWidth={0.5}
                        opacity={0.95}
                      />
                      {tooltip.lines.map((line, i) => (
                        <text
                          // biome-ignore lint/suspicious/noArrayIndexKey: tooltip line position is the line identity
                          key={i}
                          x={tooltip.x}
                          y={tooltip.y - h / 2 + pad + 8 + i * lineH}
                          textAnchor="middle"
                          fill={i === 0 ? "var(--color-text)" : "var(--color-text-dim)"}
                          fontSize={i === 0 ? 8 : 6.5}
                          fontFamily="Share Tech Mono, monospace"
                        >
                          {line}
                        </text>
                      ))}
                    </>
                  );
                })()}
              </g>
            )}
          </svg>
          <div className="absolute left-2 top-2 flex items-center gap-1 rounded border border-border bg-bg-surface/85 p-1 text-[9px] backdrop-blur-sm">
            {(
              [
                ["activity", "Heat"],
                ["alerts", "Alerts"],
                ["entities", "Presence"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={layers[key]}
                onClick={(event) => {
                  event.stopPropagation();
                  setLayers((current) => ({ ...current, [key]: !current[key] }));
                }}
                className={`rounded px-1.5 py-0.5 transition-colors ${layers[key] ? "bg-primary/15 text-primary" : "text-text-dim hover:text-text"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-2 rounded border border-border bg-bg-surface/80 px-2 py-1 text-[8px] text-text-dim backdrop-blur-sm">
            <span>
              <i className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-primary" />
              agent
            </span>
            <span>
              <i className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-warning" />
              warning
            </span>
            <span>
              <i className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-danger" />
              critical
            </span>
          </div>
          <CompassControl
            onPan={panBy}
            onZoomIn={() => zoomBy(0.85)}
            onZoomOut={() => zoomBy(1.15)}
            onRecenter={() => {
              setViewBox(DEFAULT_VIEWBOX);
              setHighlightedRoom(null);
            }}
          />
        </div>
        {/* Activity timeline, anchored inside the World Map (last 30m of feed
            events). Independent feed store — no per-event re-render of the map. */}
        <div className="h-24 shrink-0 overflow-hidden border-t border-border">
          <TimelineStrip inline />
        </div>
      </div>
    </GlassPanel>
  );
}

/**
 * Compass navigation overlay — discrete, click-safe map movement. Predictable
 * steps replace the easy-to-overshoot wheel-zoom + drag-pan that left users
 * lost. Each button stops propagation so it never registers as a map/room click.
 */
function CompassControl({
  onPan,
  onZoomIn,
  onZoomOut,
  onRecenter,
}: {
  onPan: (fx: number, fy: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onRecenter: () => void;
}) {
  const STEP = 0.35; // pan a third of the view per click
  const btn =
    "flex h-6 w-6 items-center justify-center rounded bg-bg-surface/80 text-text-dim backdrop-blur-sm transition-colors hover:bg-bg-hover hover:text-primary border border-border";
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div className="absolute bottom-2 right-2 flex flex-col items-center gap-1 select-none">
      {/* Directional pad */}
      <div className="grid grid-cols-3 grid-rows-3 gap-0.5">
        <span />
        <button
          type="button"
          className={btn}
          onClick={stop(() => onPan(0, -STEP))}
          title="Pan up"
          aria-label="Pan up"
        >
          <ChevronUp size={14} />
        </button>
        <span />
        <button
          type="button"
          className={btn}
          onClick={stop(() => onPan(-STEP, 0))}
          title="Pan left"
          aria-label="Pan left"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          type="button"
          className={btn}
          onClick={stop(onRecenter)}
          title="Recenter (0)"
          aria-label="Recenter map"
        >
          <Crosshair size={12} />
        </button>
        <button
          type="button"
          className={btn}
          onClick={stop(() => onPan(STEP, 0))}
          title="Pan right"
          aria-label="Pan right"
        >
          <ChevronRight size={14} />
        </button>
        <span />
        <button
          type="button"
          className={btn}
          onClick={stop(() => onPan(0, STEP))}
          title="Pan down"
          aria-label="Pan down"
        >
          <ChevronDown size={14} />
        </button>
        <span />
      </div>
      {/* Zoom */}
      <div className="flex gap-0.5">
        <button
          type="button"
          className={btn}
          onClick={stop(onZoomIn)}
          title="Zoom in (+)"
          aria-label="Zoom in"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          className={btn}
          onClick={stop(onZoomOut)}
          title="Zoom out (-)"
          aria-label="Zoom out"
        >
          <Minus size={14} />
        </button>
      </div>
    </div>
  );
}
