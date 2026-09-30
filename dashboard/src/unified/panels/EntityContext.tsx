// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Entity inspector for the ContextPanel: API entity detail with a
 * WebSocket-snapshot fallback, agent status, memory and inventory.
 * Split out of ContextPanel.tsx without behaviour change.
 */

import { memo, useMemo, useState } from "react";
import { useEntityDetail } from "../../hooks/use-api";
import { useChatState } from "../../hooks/use-chat-state";
import { useWorldState } from "../../hooks/use-world-state";
import { postApi } from "../../lib/api";
import type { AgentStatusInfo, AgentSupports, EntityDetail } from "../../lib/types";
import { CascadeSection, PropRow } from "./context-panel-sections";
import {
  CompassSection,
  EntityActivitySection,
  KnowledgeGraphSection,
  MediaSection,
} from "./EntityContextSections";

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

export const EntityContext = memo(function EntityContext({
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
