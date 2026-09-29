// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * UnifiedCanvas top bar: instance status, world stats, canvas notices and
 * the theme / reset / clear-view / command-bar / shortcut controls.
 */

import { memo } from "react";
import type { useSetupStatus, useSystem } from "../../hooks/use-api";
import { cycleTheme } from "../lib/theme-switcher";
import { formatUptimeShort } from "../unified-canvas-config";
import { TopbarNotices, type TopbarNoticesProps } from "./TopbarNotices";

export interface UnifiedTopbarProps {
  connected: boolean;
  setupStatus: ReturnType<typeof useSetupStatus>["data"];
  systemData: ReturnType<typeof useSystem>["data"];
  /** Instance, world or fallback name shown beside the status dot. */
  displayName: string;
  roomCount: number;
  entityCount: number;
  agentCount: number;
  connectionCount: number;
  canvasWsStatus: TopbarNoticesProps["canvasWsStatus"];
  canvasLoading: TopbarNoticesProps["canvasLoading"];
  canvasError: TopbarNoticesProps["canvasError"];
  onRetryCanvas: TopbarNoticesProps["onRetryCanvas"];
  themeName: string;
  onReset(): void;
  clearView: boolean;
  onToggleClearView(): void;
  showCommandBar: boolean;
  onToggleCommandBar(): void;
  onShowHelp(): void;
}

export const UnifiedTopbar = memo(function UnifiedTopbar({
  connected,
  setupStatus,
  systemData,
  displayName,
  roomCount,
  entityCount,
  agentCount,
  connectionCount,
  canvasWsStatus,
  canvasLoading,
  canvasError,
  onRetryCanvas,
  themeName,
  onReset,
  clearView,
  onToggleClearView,
  showCommandBar,
  onToggleCommandBar,
  onShowHelp,
}: UnifiedTopbarProps) {
  return (
    <div className="uc-topbar" style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
      <span className="uc-logo">MARINA</span>

      {/* Instance status indicator */}
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "clamp(10px, 0.7vw, 13px)",
          marginLeft: "clamp(6px, 0.6vw, 12px)",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: setupStatus?.hasLlmKey ? "#22c55e" : "#f59e0b",
            flexShrink: 0,
          }}
        />
        <span className="visually-hidden">
          {setupStatus?.hasLlmKey ? "LLM configured" : "no LLM key"}
        </span>
        <span style={{ color: "var(--uc-text-muted)", fontFamily: "'VT323', monospace" }}>
          {displayName}
        </span>
        {setupStatus && !setupStatus.hasLlmKey && (
          <span
            style={{
              color: "var(--color-warning)",
              fontSize: "clamp(8px, 0.6vw, 11px)",
              fontFamily: "'VT323', monospace",
            }}
          >
            (no LLM — add key in Admin)
          </span>
        )}
      </span>

      {/* Compass items area */}
      <div style={{ display: "flex", alignItems: "center", gap: "clamp(8px, 0.9vw, 16px)" }}>
        <div className="uc-divider" />
        <span className="uc-stat-value">{roomCount}</span>
        <span className="uc-stat-label">rooms</span>
        <div className="uc-divider" />
        <span className="uc-stat-value">{entityCount}</span>
        <span className="uc-stat-label">entities</span>
        <div className="uc-divider" />
        <span className="uc-stat-value">{agentCount}</span>
        <span className="uc-stat-label">agents</span>
        <div className="uc-divider" />
        <span className="uc-stat-value">{connectionCount}</span>
        <span className="uc-stat-label">conn</span>
        {systemData?.projectCount != null && systemData.projectCount > 0 && (
          <>
            <div className="uc-divider" />
            <span className="uc-stat-value">{systemData.projectCount}</span>
            <span className="uc-stat-label">proj</span>
          </>
        )}
        {systemData?.uptime != null && systemData.uptime > 0 && (
          <>
            <div className="uc-divider" />
            <span className="uc-stat-value">{formatUptimeShort(systemData.uptime)}</span>
            <span className="uc-stat-label">uptime</span>
          </>
        )}
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      <TopbarNotices
        canvasWsStatus={canvasWsStatus}
        canvasLoading={canvasLoading}
        canvasError={canvasError}
        onRetryCanvas={onRetryCanvas}
      />

      {/* Panel toggle buttons */}
      <div
        style={{
          display: "flex",
          gap: "2px",
          alignItems: "center",
          flexShrink: 0,
          marginRight: "12px",
        }}
      />

      {/* Theme switcher */}
      <button
        type="button"
        onClick={cycleTheme}
        style={{
          padding: "3px 10px",
          border: "1px solid var(--color-border)",
          background: "none",
          fontFamily: "'Press Start 2P', monospace",
          fontSize: "clamp(6px, 0.52vw, 8px)",
          color: "var(--color-primary)",
          cursor: "pointer",
        }}
        title="Cycle theme"
        aria-label={`Cycle theme (current: ${themeName})`}
      >
        {themeName}
      </button>

      {/* Reset layout button */}
      <button
        type="button"
        onClick={onReset}
        style={{
          padding: "3px 10px",
          border: "1px solid var(--color-border)",
          background: "none",
          fontFamily: "'Press Start 2P', monospace",
          fontSize: "clamp(6px, 0.52vw, 8px)",
          color: "var(--uc-text-muted)",
          cursor: "pointer",
        }}
        title="Reset all panels to defaults"
      >
        Reset
      </button>

      {/* Clear view */}
      <button
        type="button"
        onClick={onToggleClearView}
        style={{
          padding: "3px 10px",
          border: "1px solid var(--color-border)",
          background: "none",
          fontFamily: "'Press Start 2P', monospace",
          fontSize: "clamp(6px, 0.52vw, 8px)",
          color: clearView ? "var(--color-primary)" : "var(--uc-text-muted)",
          cursor: "pointer",
        }}
        title="Clear view (Space)"
        aria-pressed={clearView}
      >
        Clear
      </button>

      {/* Command bar toggle */}
      <button
        type="button"
        onClick={onToggleCommandBar}
        style={{
          padding: "3px 10px",
          border: "1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)",
          background: "color-mix(in srgb, var(--color-primary) 3%, transparent)",
          fontFamily: "'VT323', monospace",
          fontSize: "clamp(12px, 0.83vw, 16px)",
          color: "var(--color-primary)",
          cursor: "pointer",
        }}
        title="Command bar ( / )"
        aria-label="Toggle command bar (key /)"
        aria-pressed={showCommandBar}
      >
        /
      </button>

      <button
        type="button"
        aria-label="Keyboard shortcuts"
        onClick={onShowHelp}
        className="uc-panel-btn"
      >
        ?
      </button>

      {/* LIVE indicator */}
      <div className="uc-live">{connected ? "LIVE" : "OFFLINE"}</div>
    </div>
  );
});
