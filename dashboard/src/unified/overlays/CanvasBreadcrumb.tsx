// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CanvasBreadcrumb — "viewing <canvas>" pill shown under the layer chips when
 * the user has navigated into a non-default canvas (an entity's workspace, a
 * project canvas…). Distinguishes "viewing global" from "viewing alice's
 * workspace" so users don't lose orientation.
 *
 * Extracted mechanically from UnifiedCanvas.tsx: renders nothing when no
 * canvas is active or the active canvas is `global`.
 */

import { memo } from "react";

export interface CanvasBreadcrumbProps {
  canvasList: ReadonlyArray<{ id: string; name: string }>;
  activeCanvasId: string | null;
  /** Select a canvas by id (`null` = none). Called with the `global` canvas id. */
  onSelectCanvas: (id: string | null) => void;
}

export const CanvasBreadcrumb = memo(function CanvasBreadcrumb({
  canvasList,
  activeCanvasId,
  onSelectCanvas,
}: CanvasBreadcrumbProps) {
  if (!activeCanvasId) return null;
  const active = canvasList.find((c) => c.id === activeCanvasId);
  if (!active) return null;
  if (active.name === "global") return null;
  return (
    <nav
      aria-label="Active canvas"
      style={{
        position: "absolute",
        top: 48,
        left: 12,
        padding: "4px 8px",
        background: "rgba(8, 8, 12, 0.82)",
        border: "1px solid rgba(168,85,247,0.4)",
        borderRadius: 3,
        color: "#ccc",
        fontFamily: "'VT323', monospace",
        fontSize: 12,
        zIndex: 35,
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span style={{ color: "#a855f7", fontSize: 11 }}>viewing</span>
      <span style={{ color: "#FFDD00" }}>{active.name}</span>
      <button
        type="button"
        onClick={() => {
          const global = canvasList.find((c) => c.name === "global");
          onSelectCanvas(global?.id ?? null);
        }}
        style={{
          background: "transparent",
          border: "1px solid #444",
          color: "#888",
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 11,
          padding: "1px 5px",
          borderRadius: 2,
        }}
        title="Return to global canvas"
        aria-label="Return to global canvas"
      >
        <span aria-hidden="true">×</span>
      </button>
    </nav>
  );
});
