// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Room inspector for the ContextPanel: API room detail with a WebSocket-snapshot
 * fallback.
 * Split out of ContextPanel.tsx without behaviour change.
 */

import { memo, useMemo } from "react";
import { useRoomDetail } from "../../hooks/use-api";
import { useWorldState } from "../../hooks/use-world-state";
import type { RoomDetail } from "../../lib/types";
import { getDistrictColor } from "../lib/crown-shapes";
import {
  CascadeSection,
  ClickableItem,
  ExpandableItem,
  PropRow,
  SourceSection,
} from "./context-panel-sections";

// ── Room Context ────────────────────────────────────────────────────────────

export const RoomContext = memo(function RoomContext({
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
