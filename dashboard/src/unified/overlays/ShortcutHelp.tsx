// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * ShortcutHelp — the `?` keyboard-shortcut overlay. Extracted mechanically
 * from UnifiedCanvas.tsx; the dialog is now a labelled modal (`role="dialog"`,
 * `aria-modal`, `aria-labelledby`) that takes focus on open and closes on
 * Escape, backdrop click, or the explicit close button.
 */

import { memo, useEffect, useId, useRef } from "react";

export interface ShortcutHelpProps {
  onClose: () => void;
}

const SHORTCUTS: ReadonlyArray<[key: string, what: string]> = [
  ["/", "Toggle command bar"],
  ["Space", "Clear view (hide panels)"],
  ["Escape", "Close overlay / panel"],
  ["Arrows", "Navigate to nearest room"],
  ["?", "This help"],
  ["Tab", "Cycle panels"],
  ["Dbl-click", "Home / view detail"],
];

export const ShortcutHelp = memo(function ShortcutHelp({ onClose }: ShortcutHelpProps) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; the dialog inside is the interactive element and Escape is handled there
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className="focus-ring-custom"
        style={{
          background: "rgba(8,8,14,0.97)",
          border: "2px solid var(--color-border)",
          borderRadius: "6px",
          padding: "24px 32px",
          fontFamily: "'VT323', monospace",
          color: "#ccc",
          fontSize: "18px",
          lineHeight: 2,
          minWidth: "320px",
          outline: "none",
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div
          id={headingId}
          style={{
            fontFamily: "'Press Start 2P'",
            fontSize: "10px",
            color: "var(--color-primary)",
            marginBottom: "16px",
            letterSpacing: "2px",
          }}
        >
          KEYBOARD SHORTCUTS
        </div>
        {SHORTCUTS.map(([key, what]) => (
          <div key={key}>
            <span style={{ color: "var(--color-primary)" }}>{key}</span> — {what}
          </div>
        ))}
        <div style={{ marginTop: "12px", color: "#666", fontSize: "14px" }}>
          Click anywhere to close
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            marginTop: "8px",
            padding: "3px 10px",
            border: "1px solid var(--color-border)",
            background: "none",
            fontFamily: "'Press Start 2P', monospace",
            fontSize: "8px",
            color: "#888",
            cursor: "pointer",
          }}
        >
          CLOSE
        </button>
      </div>
    </div>
  );
});
