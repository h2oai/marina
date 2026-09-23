// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared building blocks for the CommandBar tab bodies: loading/empty states,
 * status glyph helpers, inline action buttons and the drill-down detail type.
 * Extracted mechanically from CommandBar.tsx (props in, callbacks out).
 */

import { memo, useEffect, useRef, useState } from "react";

/** Detail view for drill-down from coordination tabs. */
export type CoordDetail =
  | { kind: "task"; id: number }
  | { kind: "board"; name: string }
  | { kind: "group"; name: string }
  | { kind: "channel"; name: string }
  | { kind: "project"; id: string }
  | { kind: "connector"; id: string }
  | { kind: "command"; id: string }
  | { kind: "pool"; id: string };

export const CoordLoading = memo(function CoordLoading() {
  return (
    <div
      style={{
        padding: "12px 14px",
        color: "#999",
        fontFamily: "'VT323', monospace",
        fontSize: "clamp(15px, 1.05vw, 22px)",
      }}
    >
      Loading...
    </div>
  );
});

export const CoordEmpty = memo(function CoordEmpty({ label }: { label: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#888",
        fontFamily: "'VT323', monospace",
        fontSize: "clamp(15px, 1.05vw, 22px)",
      }}
    >
      No {label} found
    </div>
  );
});

/** Status dot color for projects/tasks. */
export function statusDotClass(status: string): string {
  if (status === "active" || status === "open") return "active";
  if (status === "claimed" || status === "submitted" || status === "paused") return "pending";
  return "done";
}

/** Task status icon: open, claimed, submitted, done. */
export function taskStatusIcon(status: string): string {
  switch (status) {
    case "open":
      return "\u25CB"; // ○
    case "claimed":
      return "\u25D0"; // ◐
    case "submitted":
      return "\u25D1"; // ◑
    case "completed":
      return "\u25CF"; // ●
    default:
      return "\u25CB";
  }
}

export const InlinePrompt = memo(function InlinePrompt({
  label,
  placeholder,
  color,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  color?: string;
  onSubmit: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) {
    return <ActionBtn label={label} color={color} onClick={() => setOpen(true)} />;
  }

  return (
    <div style={{ display: "flex", gap: "4px", alignItems: "center", flex: 1, minWidth: 0 }}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) {
            onSubmit(value.trim());
            setValue("");
            setOpen(false);
          }
          if (e.key === "Escape") {
            setValue("");
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          background: "rgba(17,17,24,0.6)",
          border: `1px solid ${color ?? "var(--color-border)"}`,
          color: "#ddd",
          fontFamily: "'VT323', monospace",
          fontSize: "clamp(14px, 0.95vw, 18px)",
          padding: "3px 8px",
          outline: "none",
        }}
      />
      <ActionBtn
        label="GO"
        color={color}
        onClick={() => {
          if (value.trim()) {
            onSubmit(value.trim());
            setValue("");
            setOpen(false);
          }
        }}
      />
      <ActionBtn
        label="X"
        onClick={() => {
          setValue("");
          setOpen(false);
        }}
      />
    </div>
  );
});

/** Inline action button for detail views. */
export const ActionBtn = memo(function ActionBtn({
  label,
  onClick,
  color,
}: {
  label: string;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "3px 10px",
        background: "none",
        border: `1px solid ${color ?? "var(--color-border)"}`,
        color: color ?? "#888",
        fontFamily: "'Press Start 2P', monospace",
        fontSize: "clamp(6px, 0.45vw, 8px)",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
});

/** Clickable entity/item link within detail views. */
export const DetailLink = memo(function DetailLink({
  label,
  onClick,
  color,
}: {
  label: string;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "none",
        border: "none",
        color: color ?? "var(--color-teal, #06b6d4)",
        cursor: "pointer",
        fontFamily: "'VT323', monospace",
        fontSize: "inherit",
        padding: 0,
        textDecoration: "underline",
        textDecorationColor: "rgba(6,182,212,0.3)",
      }}
    >
      {label}
    </button>
  );
});

/** Props shared by all detail inline components. */
export interface DetailProps {
  onNavigate: (detail: CoordDetail) => void;
  onEntityClick?: (name: string) => void;
  sendCommand?: (cmd: string) => void;
}
