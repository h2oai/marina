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
 *
 * The per-type inspectors live in sibling files: RoomContext, EntityContext
 * (+ EntityContextSections), NoteContext, MemoryContext, with shared building
 * blocks in context-panel-sections.
 */

import { memo, useCallback, useEffect, useRef } from "react";
import type { MemoryGraph } from "../lib/memory-map-types";
import { CascadeSection, PropRow } from "./context-panel-sections";
import { EntityContext } from "./EntityContext";
import { MemoryContext } from "./MemoryContext";
import { NoteContext } from "./NoteContext";
import { RoomContext } from "./RoomContext";

// ── Types ───────────────────────────────────────────────────────────────────

/** Context target type. `memory` = a MEMORY-layer node (prefixed id, e.g. `job:12`). */
export type ContextType = "room" | "entity" | "canvas" | "note" | "memory";

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
  /** MEMORY layer graph — the `memory` inspector is a pure view over it. */
  memoryGraph?: MemoryGraph | null;
  /** Called when a memory node is clicked inside the panel (memory graph navigation). */
  onMemoryNodeClick?: (nodeId: string) => void;
}

/** Imperative API for opening/closing the context panel. */
export interface ContextPanelAPI {
  /** Open the context panel for a specific item. */
  openContext: (type: ContextType, id: string) => void;
  /** Close the context panel. */
  closeContext: () => void;
}

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
  memoryGraph,
  onMemoryNodeClick,
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
          : type === "memory"
            ? "Memory Inspector"
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
      <div className="uc-panel-header">
        <button
          type="button"
          aria-label={`Move ${title}; use arrow keys`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            cursor: "grab",
            background: "none",
            color: "inherit",
            border: 0,
          }}
          onMouseDown={onDragStart}
          onKeyDown={(event) => {
            const delta = {
              ArrowLeft: [-20, 0],
              ArrowRight: [20, 0],
              ArrowUp: [0, -20],
              ArrowDown: [0, 20],
            }[event.key];
            const panel = panelRef.current;
            if (!delta || !panel) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = panel.getBoundingClientRect();
            panel.style.left = `${Math.max(0, Math.min(window.innerWidth - rect.width, rect.left + delta[0]!))}px`;
            panel.style.top = `${Math.max(0, Math.min(window.innerHeight - rect.height, rect.top + delta[1]!))}px`;
            panel.style.right = "auto";
          }}
        >
          <div className="uc-blink-dot" aria-hidden="true" />
          <span>{title}</span>
        </button>
        <span className="uc-spacer" />
        <button
          type="button"
          className="uc-panel-btn"
          onClick={handleClose}
          aria-label="Close context panel"
        >
          <span aria-hidden="true">x</span>
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
        {type === "memory" && (
          <MemoryContext
            graph={memoryGraph}
            nodeId={id}
            onEntityClick={onEntityClick}
            onNoteClick={onNoteClick}
            onMemoryNodeClick={onMemoryNodeClick}
          />
        )}
      </div>
    </div>
  );
});
