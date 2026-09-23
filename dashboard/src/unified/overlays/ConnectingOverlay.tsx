// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * ConnectingOverlay — full-surface "Connecting to world..." screen shown
 * before the first world snapshot arrives. Extracted mechanically from
 * UnifiedCanvas.tsx; announced as a live status region.
 */

import { memo } from "react";

export const ConnectingOverlay = memo(function ConnectingOverlay() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 150,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--color-bg)",
        gap: "16px",
      }}
    >
      <div
        style={{
          fontFamily: "'Orbitron', sans-serif",
          fontSize: "clamp(20px, 2vw, 36px)",
          fontWeight: 700,
          color: "var(--color-primary)",
          letterSpacing: "4px",
        }}
      >
        MARINA
      </div>
      <div
        style={{
          fontFamily: "'VT323', monospace",
          fontSize: "clamp(16px, 1.2vw, 24px)",
          color: "#888",
        }}
      >
        Connecting to world...
      </div>
      <div
        aria-hidden="true"
        style={{
          width: "60px",
          height: "60px",
          border: "3px solid #222",
          borderTop: "3px solid var(--color-primary)",
          borderRadius: "50%",
          animation: "uc-spin 1s linear infinite",
        }}
      />
    </div>
  );
});
