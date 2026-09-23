// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Topbar notices for the unified canvas — canvas WebSocket reconnecting badge,
 * snapshot-loading hint, and the "canvas unavailable · retry" button.
 *
 * Extracted mechanically from UnifiedCanvas.tsx. Every notice carries its
 * state as text (not only colour) and is announced via `role="status"` /
 * `role="alert"`.
 */

import { memo } from "react";

export interface TopbarNoticesProps {
  canvasWsStatus: string;
  canvasLoading: boolean;
  canvasError: string | null | undefined;
  onRetryCanvas: () => void;
}

export const TopbarNotices = memo(function TopbarNotices({
  canvasWsStatus,
  canvasLoading,
  canvasError,
  onRetryCanvas,
}: TopbarNoticesProps) {
  return (
    <>
      {/* Canvas WS connection badge — only visible when reconnecting, so the
          user notices when the realtime feed went silent. */}
      {canvasWsStatus === "reconnecting" && (
        <span
          role="status"
          title="The canvas WebSocket dropped; new nodes won't appear until it reconnects."
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "3px 8px",
            marginRight: "12px",
            fontFamily: "'Press Start 2P', monospace",
            fontSize: "clamp(6px, 0.52vw, 8px)",
            color: "#fbbf24",
            border: "1px solid rgba(251, 191, 36, 0.5)",
            background: "rgba(251, 191, 36, 0.08)",
            borderRadius: "2px",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "#fbbf24",
              animation: "pulse 1.4s ease-in-out infinite",
            }}
          />
          RECONNECTING
        </span>
      )}
      {canvasLoading && (
        <span
          role="status"
          title="Loading the selected canvas snapshot"
          style={{ color: "#8b5cf6", fontSize: 10, marginRight: 12 }}
        >
          CANVAS LOADING…
        </span>
      )}
      {canvasError && (
        <button
          type="button"
          onClick={onRetryCanvas}
          title={`${canvasError}. Click to retry.`}
          aria-label={`Canvas unavailable: ${canvasError}. Retry`}
          style={{
            color: "#f87171",
            border: "1px solid rgba(248,113,113,0.5)",
            background: "rgba(248,113,113,0.08)",
            fontFamily: "'Press Start 2P', monospace",
            fontSize: "clamp(6px, 0.52vw, 8px)",
            padding: "4px 8px",
            marginRight: 12,
            cursor: "pointer",
          }}
        >
          CANVAS UNAVAILABLE · RETRY
        </button>
      )}
    </>
  );
});
