// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared ContextPanel building blocks: collapsible sections, property rows and
 * clickable / expandable list items.
 * Split out of ContextPanel.tsx without behaviour change.
 */

import { memo, useState } from "react";

// ── Cascade Section ─────────────────────────────────────────────────────────

/** Collapsible cascade section wrapper matching .cas from mockup. */
export const CascadeSection = memo(function CascadeSection({
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
export const SourceSection = memo(function SourceSection({
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
export const PropRow = memo(function PropRow({
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
export const ClickableItem = memo(function ClickableItem({
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
export const ExpandableItem = memo(function ExpandableItem({
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
