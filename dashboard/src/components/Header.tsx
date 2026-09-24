// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Bell, Edit3, Save, Search, Trash2 } from "lucide-react";
import { useContradictions, useEntityBrief, useOperationalAlerts } from "../hooks/use-api";
import { useChatState } from "../hooks/use-chat-state";
import type { LayoutPreset } from "../hooks/use-layout-presets";
import { useWorldState } from "../hooks/use-world-state";
import { formatUptime } from "../lib/utils";
import { AnimatedNumber } from "./AnimatedNumber";
import { HealthBadge } from "./ops/HealthBadge";
import { SpendChip } from "./ops/SpendChip";
import { ThemeSwitcher } from "./ThemeSwitcher";

interface HeaderProps {
  connected: boolean;
  uptime: number;
  onOpenSearch?: () => void;
  onOpenShortcuts?: () => void;
  onResetLayout?: () => void;
  layoutPresets?: LayoutPreset[];
  activeLayoutId?: string;
  onSelectLayoutPreset?: (id: string) => void;
  onSaveLayoutPreset?: () => void;
  onRenameLayoutPreset?: (id: string) => void;
  onDeleteLayoutPreset?: (id: string) => void;
  onOpenAttention?: () => void;
  onOpenPulse?: () => void;
  onOpenWork?: () => void;
  onOpenMemory?: () => void;
  onOpenTraces?: () => void;
}

export function Header({
  connected,
  uptime,
  onOpenSearch,
  onOpenShortcuts,
  onResetLayout,
  layoutPresets,
  activeLayoutId,
  onSelectLayoutPreset,
  onSaveLayoutPreset,
  onRenameLayoutPreset,
  onDeleteLayoutPreset,
  onOpenAttention,
  onOpenPulse,
  onOpenWork,
  onOpenMemory,
  onOpenTraces,
}: HeaderProps) {
  const entityName = useChatState((s) => s.entityName);
  const { data: brief } = useEntityBrief(entityName);
  const { data: contradictions = [] } = useContradictions();
  const entities = useWorldState((s) => s.entities);
  const { data: alerts = [] } = useOperationalAlerts();
  const activeAlerts = alerts.filter(
    (alert) =>
      alert.status !== "resolved" && (!alert.snoozed_until || alert.snoozed_until <= Date.now()),
  );
  const criticalAlerts = activeAlerts.filter(
    (alert) => alert.severity === "critical" && alert.status === "open",
  ).length;
  const presetLocked = !!layoutPresets?.find((p) => p.id === activeLayoutId)?.locked;
  return (
    <header className="glass-panel relative z-50 flex shrink-0 flex-wrap items-center gap-2 px-3 py-2 text-xs">
      <h1 className="gradient-text font-display text-lg font-bold tracking-widest">
        {"MARINA".split("").map((letter, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed word, each letter position is its identity
          <span key={`${letter}-${i}`}>{letter}</span>
        ))}
      </h1>
      <span className="hidden text-text-dim xl:inline">Mission Control</span>
      <button
        type="button"
        onClick={onOpenSearch}
        className="ml-auto flex min-w-0 items-center gap-2 rounded border border-border bg-bg/60 px-3 py-2 text-text-dim hover:text-primary"
        aria-label="Search Marina (Ctrl or Command K)"
      >
        <Search size={14} />
        <span>Search Marina…</span>
        <kbd className="hidden sm:inline">⌘ / Ctrl K</kbd>
      </button>
      <button
        type="button"
        onClick={onOpenAttention}
        className={`relative flex items-center gap-1.5 rounded border px-2 py-0.5 transition-colors ${
          criticalAlerts
            ? "border-danger/50 bg-danger/10 text-danger"
            : activeAlerts.length
              ? "border-warning/40 bg-warning/10 text-warning"
              : "border-success/30 bg-success/5 text-success"
        }`}
        title={
          activeAlerts.length
            ? `${activeAlerts.length} actionable alert${activeAlerts.length === 1 ? "" : "s"}`
            : "Operations clear"
        }
      >
        <Bell size={11} className={criticalAlerts ? "animate-pulse" : ""} />
        <AnimatedNumber value={activeAlerts.length} className="tabular-nums" />
        <span className="hidden xl:inline">alerts</span>
        {criticalAlerts > 0 && (
          <>
            <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-danger shadow-[0_0_8px_var(--color-danger)]" />
            <span className="sr-only" aria-live="assertive">
              {criticalAlerts} critical Marina alert{criticalAlerts === 1 ? "" : "s"}
            </span>
          </>
        )}
      </button>

      <button
        type="button"
        onClick={onOpenSearch}
        className="rounded border border-border px-2 py-1 text-primary"
      >
        Commands
      </button>
      <HealthBadge />
      <span className={connected ? "text-success" : "text-danger"}>
        {connected ? "Connected" : "Disconnected"}
      </span>
      {layoutPresets && layoutPresets.length > 0 && (
        <div className="flex items-center gap-1.5 text-text-dim">
          <select
            value={activeLayoutId ?? ""}
            onChange={(e) => onSelectLayoutPreset?.(e.target.value)}
            className="rounded border border-border bg-bg px-2 py-0.5 text-[10px] text-text outline-none focus:border-primary"
            title="Switch workspace layout"
          >
            {layoutPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
                {preset.locked ? " •" : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      <button type="button" onClick={onOpenWork} className="text-primary">
        Work
        {!!brief?.claimedTaskCount && (
          <span
            role="status"
            aria-label={`${brief.claimedTaskCount} claimed tasks`}
            className="ml-1 rounded bg-primary/15 px-1"
          >
            {brief.claimedTaskCount}
          </span>
        )}
      </button>
      <button type="button" onClick={onOpenMemory} className="text-text-dim">
        Memory
        {contradictions.length > 0 && (
          <span
            role="status"
            aria-label={`${contradictions.length} open contradictions`}
            className="ml-1 rounded bg-warning/15 px-1 text-warning"
          >
            {contradictions.length}
          </span>
        )}
      </button>
      <details className="relative">
        <summary
          className="cursor-pointer rounded border border-border px-2 py-1 text-text-dim"
          aria-label="More dashboard options"
        >
          More
        </summary>
        <div className="absolute right-0 top-full z-50 mt-2 flex w-64 flex-col gap-3 rounded-lg border border-border bg-bg-card p-4 shadow-xl">
          <button type="button" className="text-left text-primary" onClick={onOpenPulse}>
            Pulse
          </button>
          <button type="button" className="text-left text-primary" onClick={onOpenTraces}>
            Traces
          </button>
          <a href="/canvas" className="text-primary">
            Canvas · full screen
          </a>
          <button
            type="button"
            className="text-left"
            onClick={onOpenShortcuts}
            aria-label="Keyboard shortcuts"
          >
            Keyboard shortcuts (?)
          </button>
          <div className="flex items-center gap-3">
            <span>Layout</span>
            <button
              type="button"
              onClick={onSaveLayoutPreset}
              className="text-text-dim hover:text-primary transition-colors"
              title="Save current layout as new preset"
              aria-label="Save layout preset"
            >
              <Save size={11} />
            </button>
            <button
              type="button"
              onClick={() => activeLayoutId && onRenameLayoutPreset?.(activeLayoutId)}
              disabled={presetLocked || !activeLayoutId}
              aria-label="Rename layout preset"
              className={`${
                presetLocked ? "text-border cursor-not-allowed" : "text-text-dim hover:text-primary"
              } transition-colors`}
              title={presetLocked ? "Default layout cannot be renamed" : "Rename selected preset"}
            >
              <Edit3 size={11} />
            </button>
            <button
              type="button"
              onClick={() => activeLayoutId && onDeleteLayoutPreset?.(activeLayoutId)}
              disabled={presetLocked || (layoutPresets?.length ?? 0) <= 1 || !activeLayoutId}
              aria-label="Delete layout preset"
              className={`${
                presetLocked || (layoutPresets?.length ?? 0) <= 1
                  ? "text-border cursor-not-allowed"
                  : "text-text-dim hover:text-danger"
              } transition-colors`}
              title={presetLocked ? "Default layout cannot be deleted" : "Delete selected preset"}
            >
              <Trash2 size={11} />
            </button>
          </div>
          <button
            type="button"
            className="text-left"
            onClick={onResetLayout}
            title="Reset layout to default"
          >
            Reset layout
          </button>
          <ThemeSwitcher />
          <SpendChip />
          <p className="text-text-dim">
            {entities.filter((e) => e.kind === "agent").length} agents · Uptime{" "}
            {formatUptime(uptime)}
          </p>
        </div>
      </details>
    </header>
  );
}
