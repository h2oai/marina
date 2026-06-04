/**
 * WorldNav — Combined minimap + world controls + legend panel (bottom-right).
 *
 * Two tabs flip the panel content:
 *   - WORLD: minimap, district filters, canvas selector, stats, zoom controls
 *   - LEGEND: color key for note types, relationship edges, feed event kinds
 *
 * Collapsed: WORLD tab only, minimap visible. Clicking LEGEND expands the
 * panel into legend mode. Clicking the active tab collapses.
 */

import { motion } from "motion/react";
import { memo, useMemo, useState } from "react";
import { DISTRICT_COLORS, getDistrictColor } from "../lib/crown-shapes";
import { LegendContent } from "../overlays/Legend";

interface RoomInfo {
  id: string;
  short: string;
  district: string;
}

type NavTab = "world" | "legend";

export interface WorldNavProps {
  visible: boolean;
  districts: string[];
  hiddenDistricts: Set<string>;
  toggleDistrict: (d: string) => void;
  hideEmptyRooms: boolean;
  setHideEmptyRooms: (v: boolean) => void;
  canvasList: { id: string; name: string }[];
  activeCanvasId: string | null;
  setSelectedCanvasId: (id: string | null) => void;
  roomCount: number;
  entityCount: number;
  connectionCount: number;
  rooms: RoomInfo[];
  roomPositions: Record<string, { x: number; y: number }>;
  onHome: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onExpandChange?: (expanded: boolean) => void;
  onReplayTour?: () => void;
}

/** Simple SVG minimap rendering room positions as colored dots. */
const MiniMapSVG = memo(function MiniMapSVG({
  rooms,
  roomPositions,
  width,
  height,
}: {
  rooms: RoomInfo[];
  roomPositions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
}) {
  const { dots, vb } = useMemo(() => {
    const entries = rooms.map((r) => ({ ...r, pos: roomPositions[r.id] })).filter((r) => r.pos);

    if (entries.length === 0) return { dots: [], vb: "0 0 100 100" };

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const e of entries) {
      minX = Math.min(minX, e.pos!.x);
      maxX = Math.max(maxX, e.pos!.x);
      minY = Math.min(minY, e.pos!.y);
      maxY = Math.max(maxY, e.pos!.y);
    }

    const pad = 60;
    const vbX = minX - pad;
    const vbY = minY - pad;
    const vbW = Math.max(maxX - minX + pad * 2, 100);
    const vbH = Math.max(maxY - minY + pad * 2, 100);

    return {
      dots: entries.map((e) => ({
        id: e.id,
        x: e.pos!.x,
        y: e.pos!.y,
        color: getDistrictColor(e.district),
      })),
      vb: `${vbX} ${vbY} ${vbW} ${vbH}`,
    };
  }, [rooms, roomPositions]);

  return (
    <svg
      width={width}
      height={height}
      viewBox={vb}
      style={{ display: "block" }}
      role="presentation"
    >
      <rect
        x={vb.split(" ")[0]}
        y={vb.split(" ")[1]}
        width={vb.split(" ")[2]}
        height={vb.split(" ")[3]}
        fill="rgba(8,8,14,0.5)"
      />
      {dots.map((d) => (
        <rect
          key={d.id}
          x={d.x - 12}
          y={d.y - 12}
          width={24}
          height={24}
          rx={3}
          fill={d.color}
          opacity={0.8}
        />
      ))}
    </svg>
  );
});

function TabButton({
  label,
  active,
  accent,
  onClick,
}: {
  label: string;
  active: boolean;
  accent: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: "relative",
        padding: "2px 6px",
        background: active ? `${accent}20` : "transparent",
        border: "none",
        // The accent underline is rendered as a layoutId motion.div below so
        // it slides between tabs when the active one changes.
        borderBottom: "1px solid transparent",
        color: active ? accent : "#666",
        fontFamily: "'Press Start 2P', monospace",
        fontSize: "clamp(6px, 0.48vw, 8px)",
        letterSpacing: "1px",
        cursor: "pointer",
      }}
    >
      {label}
      {active && (
        <motion.div
          layoutId="worldnav-tab-underline"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: -1,
            height: 1,
            background: accent,
          }}
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
        />
      )}
    </button>
  );
}

export const WorldNav = memo(function WorldNav({
  visible,
  districts,
  hiddenDistricts,
  toggleDistrict,
  hideEmptyRooms,
  setHideEmptyRooms,
  canvasList,
  activeCanvasId,
  setSelectedCanvasId,
  roomCount,
  entityCount,
  connectionCount,
  rooms,
  roomPositions,
  onHome,
  onZoomIn,
  onZoomOut,
  onExpandChange,
  onReplayTour,
}: WorldNavProps) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<NavTab>("world");

  if (!visible) return null;

  const setExpandedSync = (v: boolean) => {
    setExpanded(v);
    onExpandChange?.(v);
  };

  const handleTabClick = (t: NavTab) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!expanded) {
      setExpandedSync(true);
      setTab(t);
    } else if (tab === t) {
      setExpandedSync(false);
      setTab("world");
    } else {
      setTab(t);
    }
  };

  const showMinimap = tab === "world";

  return (
    // biome-ignore lint/a11y/useSemanticElements: contains nested interactive tab buttons — cannot use <button>
    <div
      className={`uc-worldnav${expanded ? " expanded" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => {
        if (expanded) return;
        setExpandedSync(true);
      }}
      onKeyDown={(e) => {
        if (expanded || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setExpandedSync(true);
        }
      }}
    >
      {/* Header with WORLD | LEGEND tabs */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "4px 6px",
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
          gap: 2,
        }}
      >
        <TabButton
          label="WORLD"
          active={tab === "world"}
          accent="var(--color-primary)"
          onClick={handleTabClick("world")}
        />
        <TabButton
          label="LEGEND"
          active={tab === "legend"}
          accent="#FFDD00"
          onClick={handleTabClick("legend")}
        />

        {tab === "world" && (
          <>
            <span
              style={{
                marginLeft: "4px",
                color: "#999",
                fontFamily: "'VT323', monospace",
                fontSize: "clamp(14px, 0.95vw, 18px)",
              }}
            >
              {roomCount}r {entityCount}e
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onZoomOut();
              }}
              style={{
                background: "none",
                border: "none",
                color: "#999",
                cursor: "pointer",
                fontSize: "14px",
                padding: "0 3px",
              }}
              title="Zoom out"
            >
              -
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onHome();
              }}
              style={{
                background: "none",
                border: "none",
                color: "var(--color-primary)",
                cursor: "pointer",
                fontSize: "14px",
                padding: "0 3px",
              }}
              title="Home"
            >
              &#8962;
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onZoomIn();
              }}
              style={{
                background: "none",
                border: "none",
                color: "#999",
                cursor: "pointer",
                fontSize: "14px",
                padding: "0 3px",
              }}
              title="Zoom in"
            >
              +
            </button>
          </>
        )}
        {tab === "legend" && <span style={{ flex: 1 }} />}
      </div>

      {/* Minimap — only when world tab is active */}
      {showMinimap && (
        <div
          style={{
            flexShrink: 0,
            borderBottom: expanded ? "1px solid var(--color-border)" : "none",
          }}
        >
          <MiniMapSVG
            rooms={rooms}
            roomPositions={roomPositions}
            width={200}
            height={expanded ? 160 : 100}
          />
        </div>
      )}

      {/* Expanded content */}
      {expanded && tab === "world" && (
        <div style={{ flex: 1, overflow: "auto", padding: "8px" }}>
          {/* District filters */}
          <div style={{ marginBottom: "8px" }}>
            <div
              style={{
                fontFamily: "'Press Start 2P', monospace",
                fontSize: "clamp(5px, 0.4vw, 7px)",
                color: "#888",
                marginBottom: "4px",
                letterSpacing: "0.5px",
              }}
            >
              DISTRICTS
            </div>
            <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
              {districts.map((d) => {
                const color = DISTRICT_COLORS[d] ?? "#FFDD00";
                const hidden = hiddenDistricts.has(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleDistrict(d);
                    }}
                    style={{
                      padding: "2px 8px",
                      border: `1px solid ${hidden ? "#333" : color}`,
                      background: hidden ? "none" : `${color}18`,
                      fontFamily: "'VT323', monospace",
                      fontSize: "clamp(13px, 0.9vw, 17px)",
                      cursor: "pointer",
                      color: hidden ? "#555" : color,
                      textDecoration: hidden ? "line-through" : "none",
                      opacity: hidden ? 0.5 : 1,
                    }}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Empty rooms toggle */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setHideEmptyRooms(!hideEmptyRooms);
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "4px 8px",
              marginBottom: "8px",
              border: `1px solid ${hideEmptyRooms ? "#555" : "var(--color-border)"}`,
              background: hideEmptyRooms ? "rgba(255,255,255,0.03)" : "none",
              fontFamily: "'VT323', monospace",
              fontSize: "clamp(13px, 0.9vw, 17px)",
              cursor: "pointer",
              color: hideEmptyRooms ? "#aaa" : "#888",
              textAlign: "left",
            }}
          >
            {hideEmptyRooms ? "Show empty rooms" : "Hide empty rooms"}
          </button>

          {/* Canvas selector */}
          {canvasList.length > 0 && (
            <div style={{ marginBottom: "8px" }}>
              <div
                style={{
                  fontFamily: "'Press Start 2P', monospace",
                  fontSize: "clamp(5px, 0.4vw, 7px)",
                  color: "#888",
                  marginBottom: "4px",
                  letterSpacing: "0.5px",
                }}
              >
                CANVAS
              </div>
              <select
                value={activeCanvasId ?? ""}
                onChange={(e) => {
                  e.stopPropagation();
                  setSelectedCanvasId(e.target.value || null);
                }}
                style={{
                  width: "100%",
                  padding: "4px 8px",
                  background: "rgba(17,17,24,0.6)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-teal)",
                  fontFamily: "'VT323', monospace",
                  fontSize: "clamp(13px, 0.9vw, 17px)",
                  outline: "none",
                }}
              >
                {canvasList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Stats */}
          <div
            style={{
              display: "flex",
              gap: "12px",
              fontSize: "clamp(13px, 0.9vw, 17px)",
              color: "#999",
            }}
          >
            <span>
              <span
                style={{ color: "var(--color-primary)", fontFamily: "Orbitron", fontWeight: 700 }}
              >
                {roomCount}
              </span>{" "}
              rooms
            </span>
            <span>
              <span
                style={{ color: "var(--color-primary)", fontFamily: "Orbitron", fontWeight: 700 }}
              >
                {entityCount}
              </span>{" "}
              ent
            </span>
            <span>
              <span style={{ color: "#888", fontFamily: "Orbitron", fontWeight: 700 }}>
                {connectionCount}
              </span>{" "}
              conn
            </span>
          </div>
        </div>
      )}

      {expanded && tab === "legend" && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation guard so the panel doesn't collapse on inner clicks; no key behavior needed
        // biome-ignore lint/a11y/noStaticElementInteractions: onClick is only a stopPropagation guard, not an action; keyboard handled by inner LegendContent controls
        <div
          style={{ flex: 1, overflow: "auto", padding: "8px" }}
          onClick={(e) => e.stopPropagation()}
        >
          <LegendContent onReplayTour={onReplayTour} />
        </div>
      )}
    </div>
  );
});
