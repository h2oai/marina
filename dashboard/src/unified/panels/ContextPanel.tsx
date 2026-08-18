// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * ContextPanel -- Floating overlay that appears when a node is clicked.
 *
 * Visual port of #context from 06-tiled.html mockup:
 * - position: fixed right:12px top:52px, clamp(300px,22vw,440px) wide
 * - Glass card: rgba(8,8,14,0.96) bg, 2px border, 6px 6px 0 box-shadow
 * - Cascade sections with Press Start 2P 7px headers, collapsible arrows
 * - Entity name in colored Orbitron (gold=agent, white=human, green=npc)
 * - Core Memory: key/value pairs with amber keys
 * - All items are clickable and navigate to other objects
 */

import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MediaJobsList } from "../../components/MediaJobsList";
import {
  useEntityBrief,
  useEntityDetail,
  useMediaJobs,
  useNoteDetail,
  useNoteGraph,
  useRoomDetail,
} from "../../hooks/use-api";
import { useChatState } from "../../hooks/use-chat-state";
import { useInvalidateOnEvent } from "../../hooks/use-realtime";
import { useWorldState } from "../../hooks/use-world-state";
import { authFetch, postApi } from "../../lib/api";
import type {
  AgentStatusInfo,
  AgentSupports,
  DashboardEvent,
  EntityDetail,
  MediaJob,
  RoomDetail,
} from "../../lib/types";
import { getDistrictColor } from "../lib/crown-shapes";

const API_BASE = window.location.origin;

/** Events that meaningfully change an entity's brief aggregate. */
const BRIEF_MUTATION_TYPES = new Set([
  "task_claimed",
  "task_submitted",
  "task_approved",
  "task_rejected",
  "note_created",
  "note_deleted",
  "canvas_intent",
  "pool_note",
  "agent_spawn",
  "agent_stop",
  "rank_change",
]);

const MEDIA_FEED_KINDS = new Set([
  "media_pending",
  "media_rendering",
  "media_complete",
  "media_failed",
  "media_blocked",
]);

/** Events that change the knowledge graph snippet we show per-entity. */
const NOTE_GRAPH_MUTATION_TYPES = new Set([
  "note_created",
  "note_deleted",
  "note_link_created",
  "note_link_deleted",
]);

// ── Types ───────────────────────────────────────────────────────────────────

/** Context target type. */
export type ContextType = "room" | "entity" | "canvas" | "note";

/** Props for the ContextPanel component. */
export interface ContextPanelProps {
  /** Type of the inspected item, or null if closed. */
  type: ContextType | null;
  /** ID of the inspected item (room ID or entity name). */
  id: string | null;
  /** Screen position of the click that opened the panel. */
  anchorPos?: { x: number; y: number } | null;
  /** Called when the panel should close. */
  onClose: () => void;
  /** Called when an entity is clicked inside the panel. */
  onEntityClick?: (name: string) => void;
  /** Called when a room is clicked inside the panel. */
  onRoomClick?: (roomId: string) => void;
  /** Called when a note is clicked inside the panel (graph link navigation). */
  onNoteClick?: (noteId: number) => void;
  /** Called when the "Visit canvas" button is clicked on an entity inspector. */
  onVisitEntityCanvas?: (entityName: string) => void;
  /** Send a command to the server (for stop/remove actions). */
  sendCommand?: (command: string) => void;
}

/** Imperative API for opening/closing the context panel. */
export interface ContextPanelAPI {
  /** Open the context panel for a specific item. */
  openContext: (type: ContextType, id: string) => void;
  /** Close the context panel. */
  closeContext: () => void;
}

// ── Cascade Section ─────────────────────────────────────────────────────────

/** Collapsible cascade section wrapper matching .cas from mockup. */
const CascadeSection = memo(function CascadeSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="uc-cascade-section">
      <button
        type="button"
        className="uc-cascade-header"
        style={{ width: "100%", textAlign: "left", background: "none", border: "none" }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`uc-cascade-arrow${open ? "" : " collapsed"}`}>&#9662;</span>
        {title}
      </button>
      {open && <div className="uc-cascade-body">{children}</div>}
    </div>
  );
});

// ── Source Toggle Section (Fix 3) ───────────────────────────────────────────

/** Room source code section — prominent, editable. Source is fundamental to Marina. */
const SourceSection = memo(function SourceSection({
  source,
  sendCommand,
  roomId,
}: {
  source?: string;
  sendCommand?: (cmd: string) => void;
  roomId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(source ?? "");

  return (
    <CascadeSection title="Source" defaultOpen={!!source}>
      {source ? (
        <>
          {!editing && <pre className="uc-source-code">{source}</pre>}
          {editing && (
            <div>
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                style={{
                  width: "100%",
                  minHeight: "140px",
                  background: "rgba(17,17,24,0.6)",
                  border: "1px solid var(--color-teal)",
                  color: "#ddd",
                  fontFamily: "'VT323', monospace",
                  fontSize: "clamp(14px, 0.95vw, 18px)",
                  padding: "6px 8px",
                  outline: "none",
                  resize: "vertical",
                  lineHeight: 1.5,
                }}
              />
              <div style={{ display: "flex", gap: "4px", padding: "4px 0" }}>
                <button
                  type="button"
                  onClick={() => {
                    if (sendCommand && editValue.trim()) {
                      sendCommand(`room describe ${roomId} ${editValue.trim()}`);
                      setEditing(false);
                    }
                  }}
                  style={{
                    padding: "3px 10px",
                    border: "1px solid #22c55e",
                    background: "none",
                    color: "#22c55e",
                    fontFamily: "'Press Start 2P', monospace",
                    fontSize: "clamp(5px, 0.45vw, 7px)",
                    cursor: "pointer",
                  }}
                >
                  SAVE
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditValue(source ?? "");
                    setEditing(false);
                  }}
                  style={{
                    padding: "3px 10px",
                    border: "1px solid var(--color-border)",
                    background: "none",
                    color: "#888",
                    fontFamily: "'Press Start 2P', monospace",
                    fontSize: "clamp(5px, 0.45vw, 7px)",
                    cursor: "pointer",
                  }}
                >
                  CANCEL
                </button>
              </div>
            </div>
          )}
          {!editing && sendCommand && (
            <button
              type="button"
              onClick={() => {
                setEditValue(source ?? "");
                setEditing(true);
              }}
              style={{
                marginTop: "4px",
                padding: "2px 8px",
                border: "1px solid var(--color-border)",
                background: "none",
                color: "#888",
                fontFamily: "'Press Start 2P', monospace",
                fontSize: "clamp(5px, 0.45vw, 7px)",
                cursor: "pointer",
              }}
            >
              EDIT
            </button>
          )}
        </>
      ) : (
        <div className="uc-context-desc" style={{ color: "#666", padding: "4px 0" }}>
          Source not available from server
        </div>
      )}
    </CascadeSection>
  );
});

// ── Property Row ────────────────────────────────────────────────────────────

/** Key-value row inside a cascade section, matching .ctx-row. */
const PropRow = memo(function PropRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="uc-context-row">
      <span className="uc-context-key">{label}</span>
      <span className="uc-context-value" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </span>
    </div>
  );
});

// ── Clickable Item ──────────────────────────────────────────────────────────

/** Clickable item row (entity name, room name, etc.), matching .ctx-item. */
const ClickableItem = memo(function ClickableItem({
  label,
  sublabel,
  icon,
  labelColor,
  sublabelColor,
  onClick,
}: {
  label: string;
  sublabel?: string;
  icon?: string;
  labelColor?: string;
  sublabelColor?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="uc-context-item"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        width: "100%",
        textAlign: "left",
        background: "none",
        border: "none",
        padding: "clamp(4px, 0.3vw, 6px) 0",
      }}
      onClick={onClick}
    >
      {icon && (
        <span style={{ color: labelColor ?? "var(--color-primary)", flexShrink: 0 }}>{icon}</span>
      )}
      <span style={{ color: labelColor ?? "var(--color-primary)", flex: 1 }}>{label}</span>
      {sublabel && (
        <span
          style={{
            color: sublabelColor ?? "#666",
            marginLeft: "auto",
            fontSize: "clamp(12px, 0.83vw, 16px)",
          }}
        >
          {sublabel}
        </span>
      )}
    </button>
  );
});

// ── Expandable Item (Fix 5) ─────────────────────────────────────────────────

/** Room item that expands to show description on click. */
const ExpandableItem = memo(function ExpandableItem({
  name,
  description,
}: {
  name: string;
  description: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <button
      type="button"
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: "none",
        border: "none",
        padding: "clamp(6px, 0.3vw, 8px) 0",
        cursor: "pointer",
        fontFamily: "'VT323', monospace",
      }}
      onClick={() => setExpanded((v) => !v)}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          color: "var(--color-secondary)",
          fontSize: "clamp(15px, 1.05vw, 22px)",
        }}
      >
        <span
          style={{
            fontSize: "clamp(10px, 0.7vw, 14px)",
            color: "#444",
            transition: "transform 0.15s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          {"\u25B6"}
        </span>
        {name}
      </div>
      {expanded && (
        <div
          style={{
            color: "#555",
            fontSize: "clamp(13px, 0.9vw, 18px)",
            paddingLeft: "18px",
            marginTop: "2px",
          }}
        >
          {description}
        </div>
      )}
    </button>
  );
});

// ── Entity Activity Section (API + event feed fallback) ─────────────────────

const EntityActivitySection = memo(function EntityActivitySection({
  entityName,
  apiActivity,
}: {
  entityName: string;
  apiActivity?: { timestamp: number; type: string; input?: string }[];
}) {
  // Fallback: filter global event feed for this entity
  const eventFeed = useWorldState((s) => s.eventFeed);
  const feedActivity = useMemo(
    () => eventFeed.filter((e) => e.entity === entityName).slice(0, 30),
    [eventFeed, entityName],
  );

  const activity = apiActivity && apiActivity.length > 0 ? apiActivity : feedActivity;

  if (activity.length === 0) {
    return (
      <CascadeSection title="Activity">
        <div style={{ color: "#555", padding: "4px 0", fontFamily: "'VT323', monospace" }}>
          No recent activity
        </div>
      </CascadeSection>
    );
  }

  return (
    <CascadeSection title={`Activity (${activity.length})`}>
      {activity.slice(0, 20).map((act, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: activity log has no stable per-row id; timestamps can collide
          key={`${act.timestamp}-${i}`}
          className="uc-feed-item"
          style={{ padding: "clamp(4px, 0.3vw, 6px) 0" }}
        >
          <span className="uc-feed-time">
            {new Date(act.timestamp).toLocaleTimeString("en", {
              hour12: false,
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
          <span
            style={{
              color:
                act.type === "error" || act.type === "agent_error"
                  ? "var(--color-danger)"
                  : "var(--color-text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {("input" in act ? act.input : null) ?? act.type}
          </span>
        </div>
      ))}
    </CascadeSection>
  );
});

// ── Room Context ────────────────────────────────────────────────────────────

const RoomContext = memo(function RoomContext({
  roomId,
  onEntityClick,
  onRoomClick,
  sendCommand,
}: {
  roomId: string;
  onEntityClick?: (name: string) => void;
  onRoomClick?: (roomId: string) => void;
  sendCommand?: (cmd: string) => void;
}) {
  const { data: room, isLoading, isError } = useRoomDetail(roomId);

  // Fallback: build RoomDetail from WebSocket snapshot data when API is unavailable
  const wsRooms = useWorldState((s) => s.rooms);
  const wsEntities = useWorldState((s) => s.entities);
  const fallbackRoom = useMemo<RoomDetail | null>(() => {
    if (room) return null; // API data available, no fallback needed
    const wsRoom = wsRooms.find((r) => r.id === roomId);
    if (!wsRoom) return null;
    const roomEntities = wsEntities
      .filter((e) => e.room === roomId)
      .map((e) => ({ id: e.id, name: e.name, kind: e.kind }));
    return {
      id: wsRoom.id,
      short: wsRoom.short,
      long: "",
      exits: wsRoom.exits,
      items: {},
      entities: roomEntities,
    };
  }, [room, wsRooms, wsEntities, roomId]);

  const displayRoom = room ?? fallbackRoom;

  if (isLoading && !displayRoom) {
    return (
      <div style={{ padding: "12px 14px", color: "#555", fontFamily: "'VT323', monospace" }}>
        Loading...
      </div>
    );
  }

  if (!displayRoom) {
    return (
      <div style={{ padding: "12px 14px", color: "#555", fontFamily: "'VT323', monospace" }}>
        {isError ? "API unavailable" : "Room not found"}
      </div>
    );
  }

  return (
    <RoomContextInner
      room={displayRoom}
      onEntityClick={onEntityClick}
      onRoomClick={onRoomClick}
      sendCommand={sendCommand}
    />
  );
});

const RoomContextInner = memo(function RoomContextInner({
  room,
  onEntityClick,
  onRoomClick,
  sendCommand,
}: {
  room: RoomDetail;
  sendCommand?: (cmd: string) => void;
  onEntityClick?: (name: string) => void;
  onRoomClick?: (roomId: string) => void;
}) {
  const exitEntries = useMemo(() => Object.entries(room.exits), [room.exits]);
  const itemEntries = useMemo(() => Object.entries(room.items), [room.items]);

  // District color derived from room ID prefix
  const district = room.id.split("/")[0] ?? "";
  const districtColor = getDistrictColor(district);

  return (
    <>
      {/* Room name in district color */}
      <div className="uc-context-name" style={{ color: districtColor }}>
        {room.short || room.id}
      </div>

      {/* Properties */}
      <CascadeSection title="Properties">
        <PropRow label="ID" value={room.id} />
        <PropRow label="District" value={district} valueColor={districtColor} />
      </CascadeSection>

      {/* Description */}
      {room.long && (
        <CascadeSection title="Description" defaultOpen>
          <div
            className="uc-context-desc"
            style={{ color: "#bbb", lineHeight: 1.5, padding: "2px 0 6px" }}
          >
            {room.long}
          </div>
        </CascadeSection>
      )}

      {/* Source — fundamental to Marina, everything is composable */}
      <SourceSection source={room.source} sendCommand={sendCommand} roomId={room.id} />

      {/* Items -- expandable descriptions (Fix 5) */}
      {itemEntries.length > 0 && (
        <CascadeSection title="Items">
          {itemEntries.map(([name, desc]) => (
            <ExpandableItem key={name} name={name} description={desc} />
          ))}
        </CascadeSection>
      )}

      {/* Entities */}
      {room.entities.length > 0 && (
        <CascadeSection title={`Entities (${room.entities.length})`}>
          {room.entities.map((e) => {
            const kindColor =
              e.kind === "agent"
                ? "var(--color-primary)"
                : e.kind === "npc"
                  ? "var(--color-success)"
                  : "#f0f0f0";
            return (
              <ClickableItem
                key={e.id}
                icon="●"
                label={e.name}
                sublabel={e.kind}
                labelColor={kindColor}
                sublabelColor="#666"
                onClick={() => onEntityClick?.(e.name)}
              />
            );
          })}
        </CascadeSection>
      )}

      {/* Exits */}
      {exitEntries.length > 0 && (
        <CascadeSection title="Exits">
          {exitEntries.map(([dir, targetId]) => {
            const targetDistrict = targetId.split("/")[0] ?? "";
            const targetColor = getDistrictColor(targetDistrict);
            return (
              <ClickableItem
                key={dir}
                icon={"\u2192"}
                label={dir}
                sublabel={targetId}
                labelColor={districtColor}
                sublabelColor={targetColor}
                onClick={() => onRoomClick?.(targetId)}
              />
            );
          })}
        </CascadeSection>
      )}
    </>
  );
});

// ── Note Styling Helpers (Fix 6) ────────────────────────────────────────────

/** Importance badge background color. */
function importanceBgColor(importance: number): string {
  if (importance >= 7) return "rgba(239, 68, 68, 0.15)";
  if (importance >= 4) return "rgba(245, 158, 11, 0.15)";
  return "rgba(107, 114, 128, 0.15)";
}

/** Importance badge text color. */
function importanceTextColor(importance: number): string {
  if (importance >= 7) return "#ef4444";
  if (importance >= 4) return "#f59e0b";
  return "#6b7280";
}

/** Border color for note type badge. */
function noteTypeBorderColor(noteType: string): string {
  switch (noteType) {
    case "observation":
      return "#3b82f6";
    case "insight":
      return "#8b5cf6";
    case "reflection":
      return "#06b6d4";
    case "belief":
      return "#f59e0b";
    case "plan":
      return "#22c55e";
    case "contradiction":
      return "#ef4444";
    default:
      return "#555";
  }
}

/** Format note timestamp to readable date/time. */
function formatNoteTimestamp(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ── Entity Context ──────────────────────────────────────────────────────────

/** Color for entity name based on kind. */
function entityNameColor(kind: string): string {
  if (kind === "agent") return "var(--color-primary)";
  if (kind === "npc") return "var(--color-success)";
  return "#f0f0f0"; // human
}

const EntityContext = memo(function EntityContext({
  entityName,
  onEntityClick,
  onRoomClick,
  onVisitCanvas,
  sendCommand,
}: {
  entityName: string;
  onEntityClick?: (name: string) => void;
  onRoomClick?: (roomId: string) => void;
  onVisitCanvas?: (entityName: string) => void;
  sendCommand?: (command: string) => void;
}) {
  const { data: entity, isLoading, isError } = useEntityDetail(entityName);

  // Fallback: build EntityDetail from WebSocket snapshot when API is unavailable
  const wsEntities = useWorldState((s) => s.entities);
  const wsEntity = useMemo(
    () => wsEntities.find((e) => e.name === entityName) ?? null,
    [wsEntities, entityName],
  );
  const fallbackEntity = useMemo<EntityDetail | null>(() => {
    if (entity) return null;
    if (!wsEntity) return null;
    return {
      id: wsEntity.id,
      name: wsEntity.name,
      kind: wsEntity.kind,
      room: wsEntity.room,
      rank: 0,
      properties: {},
      inventory: [],
    };
  }, [entity, wsEntity]);

  const displayEntity = entity ?? fallbackEntity;
  const agentStatus = wsEntity?.agentStatus ?? undefined;

  if (isLoading && !displayEntity) {
    return (
      <div style={{ padding: "12px 14px", color: "#555", fontFamily: "'VT323', monospace" }}>
        Loading...
      </div>
    );
  }

  if (!displayEntity) {
    return (
      <div style={{ padding: "12px 14px", color: "#555", fontFamily: "'VT323', monospace" }}>
        {isError ? "API unavailable" : "Entity not found"}
      </div>
    );
  }

  return (
    <EntityContextInner
      entity={displayEntity}
      agentStatus={agentStatus}
      onEntityClick={onEntityClick}
      onRoomClick={onRoomClick}
      onVisitCanvas={onVisitCanvas}
      sendCommand={sendCommand}
    />
  );
});

/** Format seconds into a human-readable uptime string. */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatSupports(supports: AgentSupports): string {
  const modes: string[] = [];
  if (supports.text !== false) modes.push("text");
  if (supports.image) modes.push("image");
  if (supports.video) modes.push("video");
  return modes.length > 0 ? modes.join(", ") : "none";
}

// ── Compass Section ─────────────────────────────────────────────────────────

const COMPASS_COLORS: Record<string, string> = {
  online: "#06b6d4",
  projects: "var(--color-primary)",
  tasks: "#84cc16",
  claimed: "#d946ef",
  intents: "#facc15",
  pools: "#3b82f6",
  memories: "#22c55e",
};

const CompassSection = memo(function CompassSection({ entityName }: { entityName: string }) {
  const { data: brief } = useEntityBrief(entityName);
  useInvalidateOnEvent(
    ["entityBrief", entityName],
    useCallback(
      (e: DashboardEvent) =>
        BRIEF_MUTATION_TYPES.has(e.type) &&
        (e.entity === entityName || e.name === entityName || e.authorName === entityName),
      [entityName],
    ),
  );
  if (!brief) return null;

  const badges: { label: string; value: number; color: string }[] = [];
  if (brief.onlineCount > 0)
    badges.push({ label: "online", value: brief.onlineCount, color: COMPASS_COLORS.online! });
  if (brief.projectCount > 0)
    badges.push({ label: "projects", value: brief.projectCount, color: COMPASS_COLORS.projects! });
  if (brief.openTaskCount > 0)
    badges.push({ label: "tasks", value: brief.openTaskCount, color: COMPASS_COLORS.tasks! });
  if (brief.claimedTaskCount > 0)
    badges.push({
      label: "claimed",
      value: brief.claimedTaskCount,
      color: COMPASS_COLORS.claimed!,
    });
  if (brief.pendingIntents > 0)
    badges.push({ label: "intents", value: brief.pendingIntents, color: COMPASS_COLORS.intents! });
  if (brief.poolCount > 0)
    badges.push({ label: "pools", value: brief.poolCount, color: COMPASS_COLORS.pools! });
  if (brief.memoryCount > 0)
    badges.push({ label: "memories", value: brief.memoryCount, color: COMPASS_COLORS.memories! });

  if (badges.length === 0 && !brief.goal && !brief.topTask) return null;

  return (
    <CascadeSection title="Compass">
      {badges.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", padding: "2px 0 4px" }}>
          {badges.map((b) => (
            <span
              key={b.label}
              style={{
                fontSize: "clamp(11px, 0.75vw, 15px)",
                padding: "1px 6px",
                border: `1px solid ${b.color}`,
                color: b.color,
                fontFamily: "'VT323', monospace",
                borderRadius: "2px",
              }}
            >
              {b.value} {b.label}
            </span>
          ))}
        </div>
      )}
      {brief.goal && (
        <PropRow label="Goal" value={brief.goal.slice(0, 80)} valueColor="var(--color-primary)" />
      )}
      {brief.focus && (
        <PropRow
          label="Focus"
          value={brief.focus.slice(0, 80)}
          valueColor="var(--color-teal, #2dd4bf)"
        />
      )}
      {brief.topTask && (
        <PropRow
          label="Task"
          value={`#${brief.topTask.id} ${brief.topTask.title}${brief.topTask.progress > 0 ? ` (${brief.topTask.progress}%)` : ""}`}
          valueColor="var(--color-accent)"
        />
      )}
    </CascadeSection>
  );
});

// ── Knowledge Graph Section ─────────────────────────────────────────────────

const LINK_COLORS: Record<string, string> = {
  supports: "#22c55e",
  contradicts: "#ef4444",
  extends: "#3b82f6",
  exemplifies: "#d946ef",
  relates_to: "#6b7280",
  supersedes: "#f59e0b",
};

const KnowledgeGraphSection = memo(function KnowledgeGraphSection({
  entityName,
}: {
  entityName: string;
}) {
  const { data: graph } = useNoteGraph(entityName);
  useInvalidateOnEvent(
    ["noteGraph", entityName],
    useCallback(
      (e: DashboardEvent) =>
        NOTE_GRAPH_MUTATION_TYPES.has(e.type) &&
        (e.entity === entityName || e.authorName === entityName),
      [entityName],
    ),
  );
  if (!graph || graph.length === 0) return null;

  return (
    <CascadeSection title={`Knowledge Graph (${graph.length})`} defaultOpen={false}>
      {graph.map((entry) => (
        <div
          key={entry.noteId}
          style={{
            padding: "clamp(4px, 0.25vw, 6px) 0",
            borderBottom: "1px solid rgba(17,17,24,0.2)",
          }}
        >
          <div
            style={{ fontSize: "clamp(12px, 0.83vw, 16px)", color: "#bbb", marginBottom: "2px" }}
          >
            <span style={{ color: "#666" }}>#{entry.noteId}</span>{" "}
            {entry.content.length > 100 ? `${entry.content.slice(0, 100)}...` : entry.content}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "3px" }}>
            {entry.links.map((link) => (
              <span
                key={`${link.relationship}-${link.targetId}`}
                style={{
                  fontSize: "clamp(10px, 0.68vw, 13px)",
                  padding: "0px 4px",
                  color: LINK_COLORS[link.relationship] ?? "#888",
                  border: `1px solid ${LINK_COLORS[link.relationship] ?? "#444"}`,
                  borderRadius: "2px",
                  fontFamily: "'VT323', monospace",
                }}
              >
                {link.relationship} #{link.targetId}
              </span>
            ))}
          </div>
        </div>
      ))}
    </CascadeSection>
  );
});

const MediaSection = memo(function MediaSection({
  entityName,
  sendCommand,
}: {
  entityName: string;
  sendCommand?: (command: string) => void;
}) {
  const queryClient = useQueryClient();
  const mediaQuery = useMediaJobs(entityName);
  const { data: jobs, isLoading, isError } = mediaQuery;
  useInvalidateOnEvent(
    ["media-jobs", entityName],
    useCallback(
      (event: DashboardEvent) =>
        event.type === "feed_event" && MEDIA_FEED_KINDS.has(event.kind ?? ""),
      [],
    ),
  );

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["media-jobs", entityName] });
  }, [entityName, queryClient]);

  const handleRetry = useCallback(
    async (job: MediaJob) => {
      try {
        const res = await authFetch(`${API_BASE}/api/media-jobs/${job.id}/retry`, {
          method: "POST",
        });
        if (!res.ok) {
          throw new Error(`Retry failed (${res.status})`);
        }
        invalidate();
      } catch (error) {
        console.error("[media] retry failed", error);
      }
    },
    [invalidate],
  );

  const handleDeleteAsset = useCallback(
    async (job: MediaJob) => {
      if (!job.assetId) return;
      try {
        const res = await authFetch(`${API_BASE}/api/assets/${job.assetId}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          throw new Error(`Delete failed (${res.status})`);
        }
        invalidate();
      } catch (error) {
        console.error("[media] delete asset failed", error);
      }
    },
    [invalidate],
  );

  return (
    <CascadeSection title={`Media (${jobs?.length ?? 0})`} defaultOpen={false}>
      {isLoading && <div style={{ fontSize: "11px", color: "#888" }}>Loading media activity…</div>}
      {isError && (
        <div className="flex items-center justify-between gap-2 rounded border border-border bg-bg px-2 py-2 text-[11px] text-danger">
          <span>Failed to load media jobs.</span>
          <button
            type="button"
            className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
            onClick={() => void mediaQuery.refetch()}
          >
            Retry
          </button>
        </div>
      )}
      {!isLoading && !isError && (
        <MediaJobsList
          jobs={jobs ?? []}
          onRetry={handleRetry}
          onDeleteAsset={handleDeleteAsset}
          sendCommand={sendCommand}
          emptyMessage="No media jobs yet."
        />
      )}
    </CascadeSection>
  );
});

const EntityContextInner = memo(function EntityContextInner({
  entity,
  agentStatus,
  onEntityClick: _onEntityClick,
  onRoomClick,
  onVisitCanvas,
  sendCommand,
}: {
  entity: EntityDetail;
  agentStatus?: AgentStatusInfo;
  onEntityClick?: (name: string) => void;
  onRoomClick?: (roomId: string) => void;
  onVisitCanvas?: (entityName: string) => void;
  sendCommand?: (command: string) => void;
}) {
  const isAgent = entity.kind === "agent";
  const isNpc = entity.kind === "npc";
  const isRunning =
    !!agentStatus && agentStatus.state !== "stopped" && agentStatus.state !== "error";
  const loggedIn = useChatState((s) => s.loggedIn);
  const [attention, setAttention] = useState("");
  const [sendingAttention, setSendingAttention] = useState(false);

  return (
    <>
      {/* Name banner with kind-specific color */}
      <div className="uc-context-name" style={{ color: entityNameColor(entity.kind) }}>
        {entity.name}
      </div>

      {/* Navigation: visit this entity's canvas. Available for everyone, any
          kind — any entity has a workspace you can drop in on. */}
      {onVisitCanvas && (
        <div style={{ display: "flex", gap: "6px", padding: "0 14px 6px" }}>
          <button
            type="button"
            onClick={() => onVisitCanvas(entity.name)}
            style={{
              padding: "4px 10px",
              background: "rgba(255,221,0,0.1)",
              border: "1px solid rgba(255,221,0,0.5)",
              color: "#FFDD00",
              fontFamily: "'Press Start 2P', monospace",
              fontSize: 9,
              letterSpacing: 1,
              cursor: "pointer",
              borderRadius: 2,
            }}
            title={`Visit ${entity.name}'s canvas — drop in a note, review their workspace`}
          >
            VISIT CANVAS
          </button>
        </div>
      )}

      {/* Action buttons for agents/NPCs — only when logged in */}
      {sendCommand && loggedIn && (isAgent || isNpc) && (
        <div
          style={{
            display: "flex",
            gap: "6px",
            padding: "0 14px 8px",
          }}
        >
          {isAgent && isRunning && (
            <button
              type="button"
              className="uc-entity-action-btn stop"
              onClick={() => sendCommand(`agent stop ${entity.name}`)}
            >
              Stop Agent
            </button>
          )}
          {isAgent && !isRunning && (
            <button
              type="button"
              className="uc-entity-action-btn stop"
              onClick={() => sendCommand(`agent start ${entity.name}`)}
            >
              Start Agent
            </button>
          )}
          {isNpc && (
            <button
              type="button"
              className="uc-entity-action-btn remove"
              onClick={() => sendCommand(`remove ${entity.name}`)}
            >
              Remove
            </button>
          )}
        </div>
      )}

      {/* Attention input for running agents */}
      {isAgent && isRunning && (
        <div style={{ display: "flex", gap: "4px", padding: "0 14px 8px" }}>
          <input
            type="text"
            placeholder="Send attention..."
            value={attention}
            onChange={(e) => setAttention(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && attention.trim()) {
                setSendingAttention(true);
                try {
                  await postApi(`/api/agents/${encodeURIComponent(entity.name)}/attention`, {
                    message: attention.trim(),
                  });
                  setAttention("");
                } finally {
                  setSendingAttention(false);
                }
              }
            }}
            style={{
              flex: 1,
              background: "rgba(17,17,24,0.6)",
              border: "1px solid var(--color-border)",
              color: "#ddd",
              fontFamily: "'VT323', monospace",
              fontSize: "clamp(14px, 0.95vw, 18px)",
              padding: "3px 8px",
              outline: "none",
            }}
          />
          <button
            type="button"
            disabled={sendingAttention || !attention.trim()}
            onClick={async () => {
              if (!attention.trim()) return;
              setSendingAttention(true);
              try {
                await postApi(`/api/agents/${encodeURIComponent(entity.name)}/attention`, {
                  message: attention.trim(),
                });
                setAttention("");
              } finally {
                setSendingAttention(false);
              }
            }}
            style={{
              background: "none",
              border: "1px solid var(--color-border)",
              color: attention.trim() ? "var(--color-primary)" : "#555",
              cursor: attention.trim() ? "pointer" : "default",
              fontFamily: "'VT323', monospace",
              fontSize: "clamp(14px, 0.95vw, 18px)",
              padding: "3px 8px",
            }}
          >
            Send
          </button>
        </div>
      )}

      {/* Status */}
      <CascadeSection title="Status">
        <PropRow label="Kind" value={entity.kind} />
        <PropRow label="Room" value={entity.room} valueColor="var(--color-secondary)" />
        <button
          type="button"
          className="uc-context-link"
          style={{
            display: "block",
            background: "none",
            border: "none",
            fontFamily: "'VT323', monospace",
            fontSize: "clamp(15px, 1.05vw, 22px)",
            padding: "clamp(6px, 0.3vw, 8px) 0",
          }}
          onClick={() => onRoomClick?.(entity.room)}
        >
          Go to room &rarr;
        </button>
        <PropRow label="Rank" value={String(entity.rank)} valueColor="var(--color-primary)" />
        {agentStatus && (
          <>
            <PropRow
              label="State"
              value={agentStatus.state}
              valueColor={
                agentStatus.state === "autonomous" || agentStatus.state === "connected"
                  ? "var(--color-success)"
                  : agentStatus.state === "error"
                    ? "var(--color-danger)"
                    : agentStatus.state === "starting"
                      ? "var(--color-warning, #f59e0b)"
                      : undefined
              }
            />
            <PropRow
              label="Model"
              value={
                agentStatus.model.startsWith("marina/")
                  ? `${agentStatus.model} (local)`
                  : agentStatus.model
              }
              valueColor={agentStatus.model.startsWith("marina/") ? "#06b6d4" : undefined}
            />
            <PropRow label="Role" value={agentStatus.role} />
            {agentStatus.focus && (
              <PropRow
                label="Focus"
                value={agentStatus.focus}
                valueColor="var(--color-teal, #2dd4bf)"
              />
            )}
            <PropRow label="Modalities" value={formatSupports(agentStatus.supports)} />
            <PropRow label="Uptime" value={formatUptime(agentStatus.uptime)} />
            <PropRow label="Tool calls" value={String(agentStatus.toolCalls)} />
            <PropRow
              label="Errors"
              value={String(agentStatus.errors)}
              valueColor={agentStatus.errors > 0 ? "var(--color-danger)" : undefined}
            />
            {agentStatus.errorReason && (
              <PropRow
                label="Error Reason"
                value={agentStatus.errorReason}
                valueColor="var(--color-danger)"
              />
            )}
          </>
        )}
      </CascadeSection>

      {/* Compass — brief orientation for the entity */}
      <CompassSection entityName={entity.name} />
      <MediaSection entityName={entity.name} sendCommand={sendCommand} />

      {/* Core Memory */}
      {entity.coreMemory && entity.coreMemory.length > 0 && (
        <CascadeSection title="Core Memory">
          {entity.coreMemory.map((mem) => (
            <div key={mem.key} className="uc-context-mem">
              <div className="uc-context-mem-key">{mem.key}</div>
              <div className="uc-context-mem-value">{mem.value}</div>
            </div>
          ))}
        </CascadeSection>
      )}

      {/* Notes -- with importance badges, type badges, timestamps (Fix 6) */}
      {entity.notes && entity.notes.length > 0 && (
        <CascadeSection title="Notes" defaultOpen={false}>
          {entity.notes.slice(0, 20).map((note) => (
            <div
              key={note.id}
              style={{
                padding: "clamp(6px, 0.3vw, 8px) 0",
                borderBottom: "1px solid rgba(17,17,24,0.2)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  flexWrap: "wrap",
                }}
              >
                {/* Type badge */}
                <span
                  style={{
                    fontSize: "clamp(10px, 0.68vw, 13px)",
                    padding: "1px 5px",
                    border: `1px solid ${noteTypeBorderColor(note.note_type)}`,
                    color: noteTypeBorderColor(note.note_type),
                    letterSpacing: "0.5px",
                  }}
                >
                  {note.note_type}
                </span>
                {/* Importance badge */}
                <span
                  style={{
                    fontSize: "clamp(10px, 0.68vw, 13px)",
                    padding: "1px 5px",
                    background: importanceBgColor(note.importance),
                    color: importanceTextColor(note.importance),
                    borderRadius: "2px",
                    fontWeight: "bold",
                  }}
                >
                  {note.importance >= 7 ? "HIGH" : note.importance >= 4 ? "MED" : "LOW"}
                </span>
                {/* Timestamp */}
                <span
                  style={{
                    fontSize: "clamp(10px, 0.68vw, 13px)",
                    color: "#444",
                    marginLeft: "auto",
                  }}
                >
                  {formatNoteTimestamp(note.created_at)}
                </span>
              </div>
              <div
                style={{
                  fontSize: "clamp(14px, 0.98vw, 20px)",
                  color: "var(--color-text)",
                  marginTop: "4px",
                  lineHeight: "1.4",
                }}
              >
                {note.content.length > 200 ? `${note.content.slice(0, 200)}...` : note.content}
              </div>
            </div>
          ))}
        </CascadeSection>
      )}

      {/* Knowledge Graph */}
      <KnowledgeGraphSection entityName={entity.name} />

      {/* Inventory */}
      {entity.inventory.length > 0 && (
        <CascadeSection title="Inventory" defaultOpen={false}>
          {entity.inventory.map((item) => (
            <div
              key={item}
              style={{
                padding: "clamp(6px, 0.3vw, 8px) 0",
                fontSize: "clamp(15px, 1.05vw, 22px)",
                color: "var(--color-text)",
              }}
            >
              {item}
            </div>
          ))}
        </CascadeSection>
      )}

      {/* Activity — from API or fallback from global event feed */}
      <EntityActivitySection entityName={entity.name} apiActivity={entity.recentActivity} />

      {/* Properties (raw) */}
      {Object.keys(entity.properties).length > 0 && (
        <CascadeSection title="Properties" defaultOpen={false}>
          {Object.entries(entity.properties).map(([key, val]) => (
            <PropRow key={key} label={key} value={String(val)} />
          ))}
        </CascadeSection>
      )}
    </>
  );
});

// ── Main Panel ──────────────────────────────────────────────────────────────

/**
 * Floating context panel that shows detail for clicked rooms/entities.
 */
export const ContextPanel = memo(function ContextPanel({
  type,
  id,
  anchorPos,
  onClose,
  onEntityClick,
  onRoomClick,
  onNoteClick,
  onVisitEntityCanvas,
  sendCommand,
}: ContextPanelProps) {
  const handleClose = useCallback(() => onClose(), [onClose]);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ dragging: false, ox: 0, oy: 0 });

  const onDragStart = useCallback((e: React.MouseEvent) => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Lock to absolute positioning
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.right = "auto";
    dragRef.current = { dragging: true, ox: e.clientX - rect.left, oy: e.clientY - rect.top };
    e.preventDefault();
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.dragging || !panelRef.current) return;
      panelRef.current.style.left = `${e.clientX - dragRef.current.ox}px`;
      panelRef.current.style.top = `${e.clientY - dragRef.current.oy}px`;
    };
    const onUp = () => {
      dragRef.current.dragging = false;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  if (!type || !id) return null;

  const title =
    type === "room"
      ? "Room Inspector"
      : type === "entity"
        ? "Entity Inspector"
        : type === "note"
          ? "Note Inspector"
          : "Canvas Node";

  // Position panel within usable viewport, near the click but never cut off
  const panelW = 360;
  const clearance = 180;
  const pad = 12;
  const topbarH = 52;
  const bottomPanelH = 160;
  const posStyle: React.CSSProperties = {};

  if (anchorPos) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const usableTop = topbarH + pad;
    const usableBottom = vh - bottomPanelH - pad;
    const maxPanelH = usableBottom - usableTop;

    // Horizontal: offset from click, pick side with more space
    const spaceRight = vw - anchorPos.x;
    const spaceLeft = anchorPos.x;
    let left: number;
    if (spaceRight > panelW + clearance) {
      left = anchorPos.x + clearance;
    } else if (spaceLeft > panelW + clearance) {
      left = anchorPos.x - clearance - panelW;
    } else {
      left = spaceRight > spaceLeft ? vw - panelW - pad : pad;
    }
    left = Math.max(pad, Math.min(left, vw - panelW - pad));

    // Vertical: start near click, but ensure panel fits entirely in usable area
    let top = anchorPos.y - 40;
    // Don't go above topbar
    top = Math.max(usableTop, top);
    // Don't let bottom edge exceed usable area
    if (top + maxPanelH > usableBottom) {
      top = usableTop; // pin to top of usable area
    }

    posStyle.left = `${left}px`;
    posStyle.top = `${top}px`;
    posStyle.right = "auto";
    posStyle.maxHeight = `${maxPanelH}px`;
  }

  return (
    <div ref={panelRef} className="uc-context-panel" style={posStyle}>
      {/* Header — draggable */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle — onMouseDown initiates pointer drag, not a click action */}
      <div className="uc-panel-header" style={{ cursor: "grab" }} onMouseDown={onDragStart}>
        <div className="uc-blink-dot" />
        <span>{title}</span>
        <span className="uc-spacer" />
        <button type="button" className="uc-panel-btn" onClick={handleClose}>
          x
        </button>
      </div>

      {/* Name banner rendered by child components with correct district/kind color */}

      {/* Scrollable body */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 0,
          scrollbarWidth: "thin",
          scrollbarColor: "#1a1a22 transparent",
        }}
      >
        {type === "room" && (
          <RoomContext
            roomId={id}
            onEntityClick={onEntityClick}
            onRoomClick={onRoomClick}
            sendCommand={sendCommand}
          />
        )}
        {type === "entity" && (
          <EntityContext
            entityName={id}
            onEntityClick={onEntityClick}
            onRoomClick={onRoomClick}
            onVisitCanvas={onVisitEntityCanvas}
            sendCommand={sendCommand}
          />
        )}
        {type === "canvas" && (
          <CascadeSection title="Canvas Node">
            <PropRow label="ID" value={id} />
            <PropRow label="Type" value="canvas" />
          </CascadeSection>
        )}
        {type === "note" && (
          <NoteContext
            noteId={Number(id)}
            onEntityClick={onEntityClick}
            onNoteClick={onNoteClick}
          />
        )}
      </div>
    </div>
  );
});

// ── Note Context ────────────────────────────────────────────────────────────

const NOTE_TYPE_COLORS: Record<string, string> = {
  episode: "#a855f7",
  skill: "#f97316",
  fact: "#3b82f6",
  observation: "#9ca3af",
  inference: "#06b6d4",
  decision: "#22c55e",
  principle: "#eab308",
};

const REL_COLORS: Record<string, string> = {
  supports: "#22c55e",
  contradicts: "#ef4444",
  extends: "#3b82f6",
  exemplifies: "#d946ef",
  related_to: "#6b7280",
  supersedes: "#f59e0b",
  part_of: "#14b8a6",
  derived_from: "#8b5cf6",
};

function fmtAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const NoteContext = memo(function NoteContext({
  noteId,
  onEntityClick,
  onNoteClick,
}: {
  noteId: number;
  onEntityClick?: (name: string) => void;
  onNoteClick?: (id: number) => void;
}) {
  const { data, isLoading } = useNoteDetail(noteId);

  if (isLoading) {
    return <div style={{ padding: 12, color: "#888" }}>Loading note #{noteId}…</div>;
  }
  if (!data) {
    return <div style={{ padding: 12, color: "#ef4444" }}>Note #{noteId} not found.</div>;
  }

  const color = NOTE_TYPE_COLORS[data.noteType] ?? "#9ca3af";
  const accessed = data.lastAccessed ?? data.createdAt;

  return (
    <>
      {/* Banner */}
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid #222",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: 2,
            background: color,
          }}
        />
        <span style={{ color, fontFamily: "'Press Start 2P', monospace", fontSize: 10 }}>
          #{data.id}
        </span>
        <span style={{ color: "#888", fontSize: 12 }}>
          [{data.noteType}] · importance {data.importance}
        </span>
      </div>

      <CascadeSection title="Content">
        <div
          style={{
            padding: "8px 12px",
            fontSize: 13,
            color: "#ddd",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {data.content}
        </div>
      </CascadeSection>

      <CascadeSection title="Meta">
        <div className="uc-context-row">
          <span className="uc-context-key">Author</span>
          <span className="uc-context-value">
            {onEntityClick ? (
              <button
                type="button"
                onClick={() => onEntityClick(data.entityName)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#FFDD00",
                  cursor: "pointer",
                  padding: 0,
                  font: "inherit",
                  textDecoration: "underline",
                }}
              >
                {data.entityName}
              </button>
            ) : (
              data.entityName
            )}
          </span>
        </div>
        <PropRow label="Created" value={fmtAge(Date.now() - data.createdAt)} />
        <PropRow label="Last recalled" value={fmtAge(Date.now() - accessed)} />
        <PropRow
          label="Verification"
          value={`${data.verificationStatus} · confidence ${data.confidence.toFixed(2)}`}
        />
        {data.roomId && <PropRow label="Room" value={data.roomId} />}
        {data.poolId && <PropRow label="Pool" value={data.poolId} />}
        {data.supersedesId !== null && (
          <div className="uc-context-row">
            <span className="uc-context-key">Supersedes</span>
            <span className="uc-context-value">
              {onNoteClick ? (
                <button
                  type="button"
                  onClick={() => onNoteClick(data.supersedesId!)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#f59e0b",
                    cursor: "pointer",
                    padding: 0,
                    font: "inherit",
                    textDecoration: "underline",
                  }}
                >
                  #{data.supersedesId}
                </button>
              ) : (
                `#${data.supersedesId}`
              )}
            </span>
          </div>
        )}
      </CascadeSection>

      <CascadeSection
        title={`Provenance (${data.sources.length})`}
        defaultOpen={data.sources.length > 0}
      >
        {data.sources.length === 0 ? (
          <div style={{ padding: "6px 12px", color: "#666", fontSize: 12 }}>
            No explicit evidence attached.
          </div>
        ) : (
          data.sources.map((source) => (
            <div
              key={source.id}
              style={{ padding: "6px 12px", borderBottom: "1px solid #1a1a22", fontSize: 11 }}
            >
              <div>
                <span style={{ color: "#14b8a6" }}>[{source.source_type}]</span>{" "}
                {source.source_note_id && onNoteClick ? (
                  <button
                    type="button"
                    onClick={() => onNoteClick(source.source_note_id!)}
                    style={{ background: "none", border: 0, color: "#FFDD00", cursor: "pointer" }}
                  >
                    #{source.source_note_id}
                  </button>
                ) : (
                  <span style={{ color: "#bbb", wordBreak: "break-all" }}>{source.url}</span>
                )}
              </div>
              <div style={{ color: "#777" }}>
                credibility {source.credibility.toFixed(2)}
                {source.source_entity ? ` · via ${source.source_entity}` : ""}
              </div>
              {source.excerpt && (
                <div style={{ color: "#999", marginTop: 2 }}>{source.excerpt}</div>
              )}
            </div>
          ))
        )}
      </CascadeSection>

      <CascadeSection
        title={`Verification history (${data.verifications.length})`}
        defaultOpen={data.verifications.length > 0}
      >
        {data.verifications.map((entry) => (
          <div
            key={entry.id}
            style={{ padding: "6px 12px", borderBottom: "1px solid #1a1a22", fontSize: 11 }}
          >
            <div
              style={{
                color:
                  entry.status === "verified"
                    ? "#22c55e"
                    : entry.status === "disputed"
                      ? "#ef4444"
                      : "#999",
              }}
            >
              {entry.status} · {entry.confidence.toFixed(2)} · {entry.verifier}
            </div>
            {entry.rationale && <div style={{ color: "#888" }}>{entry.rationale}</div>}
          </div>
        ))}
      </CascadeSection>

      <CascadeSection title={`Links (${data.links.length})`} defaultOpen={data.links.length > 0}>
        {data.links.length === 0 ? (
          <div style={{ padding: "6px 12px", color: "#666", fontSize: 12 }}>
            No links yet. Use <code>note link #{data.id} &lt;other&gt; &lt;rel&gt;</code> to
            connect.
          </div>
        ) : (
          data.links.map((l) => {
            const relColor = REL_COLORS[l.relationship] ?? "#888";
            const arrow = l.direction === "out" ? "→" : "←";
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => onNoteClick?.(l.otherId)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  borderBottom: "1px solid #1a1a22",
                  color: "#ccc",
                  padding: "6px 12px",
                  cursor: onNoteClick ? "pointer" : "default",
                  font: "inherit",
                }}
              >
                <div style={{ fontSize: 12, marginBottom: 2 }}>
                  <span style={{ color: relColor }}>{l.relationship}</span>{" "}
                  <span style={{ color: "#888" }}>{arrow}</span>{" "}
                  <span style={{ color: "#FFDD00" }}>#{l.otherId}</span>
                  {l.otherType && <span style={{ color: "#666" }}> [{l.otherType}]</span>}
                </div>
                {l.otherPreview && (
                  <div style={{ fontSize: 11, color: "#888", lineHeight: 1.3 }}>
                    {l.otherPreview}
                  </div>
                )}
              </button>
            );
          })
        )}
      </CascadeSection>
    </>
  );
});
