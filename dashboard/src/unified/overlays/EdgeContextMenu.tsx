/**
 * EdgeContextMenu -- Popup that appears on right-click of a graph/canvas edge.
 *
 * Shows the current relationship, lets the user switch it to any other typed
 * relationship, or delete the edge entirely. Commands are sent via the chat
 * WS pipeline so they flow through the normal engine.logEvent path — the edge
 * re-renders automatically via WS events.
 *
 * Handles two edge families:
 *   - Canvas edges (kind="canvas"): "canvas disconnect <id>" + optional "canvas connect <src> <tgt> <rel>"
 *   - Note links (kind="note"):     "note unlink <src> <tgt> <oldRel>" + optional "note link <src> <tgt> <newRel>"
 */

import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useRef } from "react";

const RELATIONSHIPS: { rel: string; color: string; label: string }[] = [
  { rel: "supports", color: "#22c55e", label: "supports" },
  { rel: "contradicts", color: "#ef4444", label: "contradicts" },
  { rel: "extends", color: "#3b82f6", label: "extends" },
  { rel: "exemplifies", color: "#d946ef", label: "exemplifies" },
  { rel: "related_to", color: "#6b7280", label: "related_to" },
  { rel: "supersedes", color: "#f59e0b", label: "supersedes" },
  { rel: "part_of", color: "#14b8a6", label: "part_of" },
  { rel: "derived_from", color: "#8b5cf6", label: "derived_from" },
];

export interface EdgeContextMenuTarget {
  kind: "canvas" | "note";
  /** Canvas edge id (uuid) when kind=canvas; unused for kind=note. */
  edgeId?: string;
  sourceId: string;
  targetId: string;
  relationship: string;
  /** Screen position of the right-click. */
  x: number;
  y: number;
}

export interface EdgeContextMenuProps {
  target: EdgeContextMenuTarget | null;
  onClose: () => void;
  sendCommand: (command: string) => void;
}

export const EdgeContextMenu = memo(function EdgeContextMenu({
  target,
  onClose,
  sendCommand,
}: EdgeContextMenuProps) {
  return (
    <AnimatePresence>
      {target && (
        <EdgeContextMenuInner target={target} onClose={onClose} sendCommand={sendCommand} />
      )}
    </AnimatePresence>
  );
});

function EdgeContextMenuInner({
  target,
  onClose,
  sendCommand,
}: EdgeContextMenuProps & { target: EdgeContextMenuTarget }) {
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss on outside click or Escape
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Delay by a frame so the originating contextmenu click doesn't immediately close us
    const id = setTimeout(() => {
      document.addEventListener("mousedown", onDocClick);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const changeRelationship = (newRel: string) => {
    if (newRel === target.relationship) {
      onClose();
      return;
    }
    if (target.kind === "canvas") {
      if (target.edgeId) sendCommand(`canvas disconnect ${target.edgeId}`);
      sendCommand(`canvas connect ${target.sourceId} ${target.targetId} ${newRel}`);
    } else {
      sendCommand(`note unlink ${target.sourceId} ${target.targetId} ${target.relationship}`);
      sendCommand(`note link ${target.sourceId} ${target.targetId} ${newRel}`);
    }
    onClose();
  };

  const deleteEdge = () => {
    if (target.kind === "canvas") {
      if (target.edgeId) sendCommand(`canvas disconnect ${target.edgeId}`);
    } else {
      sendCommand(`note unlink ${target.sourceId} ${target.targetId} ${target.relationship}`);
    }
    onClose();
  };

  // Clamp position to viewport
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const menuW = 220;
  const menuH = 260;
  const left = Math.min(target.x, vw - menuW - 8);
  const top = Math.min(target.y, vh - menuH - 8);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.92, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 2 }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
      style={{
        position: "fixed",
        left,
        top,
        width: menuW,
        transformOrigin: "top left",
        background: "rgba(10, 10, 16, 0.96)",
        border: "1px solid rgba(255,221,0,0.35)",
        borderRadius: 4,
        boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
        padding: "6px 0",
        fontFamily: "'VT323', monospace",
        fontSize: 13,
        color: "#ddd",
        zIndex: 70,
      }}
    >
      <div
        style={{
          padding: "4px 10px 6px 10px",
          borderBottom: "1px solid #222",
          color: "#888",
          fontSize: 11,
          letterSpacing: 0.5,
        }}
      >
        <div>{target.kind === "canvas" ? "CANVAS EDGE" : "NOTE LINK"}</div>
        <div style={{ color: "#666", marginTop: 2 }}>
          {target.sourceId.slice(0, 8)} → {target.targetId.slice(0, 8)}
        </div>
        <div style={{ color: "#FFDD00", marginTop: 2, fontSize: 12 }}>
          current: {target.relationship}
        </div>
      </div>

      <div style={{ padding: "4px 0" }}>
        <div style={{ padding: "2px 10px", color: "#888", fontSize: 11 }}>
          change relationship →
        </div>
        {RELATIONSHIPS.map((r) => {
          const isCurrent = r.rel === target.relationship;
          return (
            <button
              key={r.rel}
              type="button"
              disabled={isCurrent}
              onClick={() => changeRelationship(r.rel)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "3px 10px",
                background: "transparent",
                border: "none",
                color: isCurrent ? "#555" : "#ccc",
                cursor: isCurrent ? "default" : "pointer",
                fontFamily: "inherit",
                fontSize: "inherit",
                textAlign: "left",
              }}
              onMouseOver={(e) => {
                if (!isCurrent)
                  (e.currentTarget as HTMLElement).style.background = "rgba(255,221,0,0.1)";
              }}
              onFocus={(e) => {
                if (!isCurrent)
                  (e.currentTarget as HTMLElement).style.background = "rgba(255,221,0,0.1)";
              }}
              onMouseOut={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
              }}
              onBlur={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: r.color,
                  opacity: isCurrent ? 0.3 : 1,
                }}
              />
              <span>{r.label}</span>
              {isCurrent && <span style={{ marginLeft: "auto", color: "#555" }}>●</span>}
            </button>
          );
        })}
      </div>

      <div style={{ borderTop: "1px solid #222", padding: "4px 0" }}>
        <button
          type="button"
          onClick={deleteEdge}
          style={{
            width: "100%",
            padding: "4px 10px",
            background: "transparent",
            border: "none",
            color: "#ef4444",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: "inherit",
            textAlign: "left",
          }}
          onMouseOver={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.15)";
          }}
          onFocus={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.15)";
          }}
          onMouseOut={(e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
          }}
          onBlur={(e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
          }}
        >
          delete edge
        </button>
      </div>
    </motion.div>
  );
}
