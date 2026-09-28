// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Native modal focus containment, Escape handling and focus restoration. */

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
  ["Tab", "Move between controls"],
  ["Dbl-click", "Home / view detail"],
];

export const ShortcutHelp = memo(function ShortcutHelp({ onClose }: ShortcutHelpProps) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      // React may remove the modal before the browser's close restoration runs.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="shortcut-dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      style={{ padding: 0, border: 0, background: "transparent", maxWidth: "calc(100vw - 24px)" }}
    >
      <div
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
        <div style={{ marginTop: "12px", color: "#aaa", fontSize: "14px" }}>
          Press Escape or Close to return
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
            color: "#aaa",
            cursor: "pointer",
          }}
        >
          CLOSE
        </button>
      </div>
    </dialog>
  );
});
