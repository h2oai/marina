// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  Activity,
  Bell,
  Edit3,
  FolderKanban,
  Frame,
  Plug,
  Radio,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { motion } from "motion/react";
import { useOperationalAlerts, useSystem } from "../hooks/use-api";
import type { LayoutPreset } from "../hooks/use-layout-presets";
import { useWorldState } from "../hooks/use-world-state";
import { formatUptime } from "../lib/utils";
import { AnimatedNumber } from "./AnimatedNumber";
import { ThemeSwitcher } from "./ThemeSwitcher";

interface HeaderProps {
  connected: boolean;
  uptime: number;
  onResetLayout?: () => void;
  layoutPresets?: LayoutPreset[];
  activeLayoutId?: string;
  onSelectLayoutPreset?: (id: string) => void;
  onSaveLayoutPreset?: () => void;
  onRenameLayoutPreset?: (id: string) => void;
  onDeleteLayoutPreset?: (id: string) => void;
  onOpenOperations?: () => void;
}

const TITLE_LETTERS = "MARINA".split("");

// Stagger from the center outward — middle letters appear first.
const center = (TITLE_LETTERS.length - 1) / 2;

export function Header({
  connected,
  uptime,
  onResetLayout,
  layoutPresets,
  activeLayoutId,
  onSelectLayoutPreset,
  onSaveLayoutPreset,
  onRenameLayoutPreset,
  onDeleteLayoutPreset,
  onOpenOperations,
}: HeaderProps) {
  const entities = useWorldState((s) => s.entities);
  const connections = useWorldState((s) => s.connections);
  const { data: systemData } = useSystem();
  const { data: alerts = [] } = useOperationalAlerts();
  const activeAlerts = alerts.filter((alert) => alert.status !== "resolved");
  const criticalAlerts = activeAlerts.filter((alert) => alert.severity === "critical").length;
  const agents = entities.filter((e) => e.kind === "agent");
  const activePreset = layoutPresets?.find((p) => p.id === activeLayoutId);
  const presetLocked = !!activePreset?.locked;

  return (
    <header className="glass-panel relative z-50 flex items-center justify-between px-3 py-1">
      <div className="flex items-center gap-3">
        <h1 className="gradient-text font-display text-lg font-bold tracking-widest">
          {TITLE_LETTERS.map((letter, i) => (
            <motion.span
              // biome-ignore lint/suspicious/noArrayIndexKey: TITLE_LETTERS is a static, never-reordered constant
              key={i}
              style={{ display: "inline-block" }}
              initial={{ opacity: 0, scale: 0.5, filter: "blur(8px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              transition={{
                delay: Math.abs(i - center) * 0.05,
                type: "spring",
                stiffness: 220,
                damping: 14,
              }}
            >
              {letter}
            </motion.span>
          ))}
        </h1>
        <span className="text-text-dim text-[11px]">Mission Control</span>
      </div>

      <div className="flex items-center gap-3 text-[11px]">
        <button
          type="button"
          onClick={onOpenOperations}
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
            <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-danger shadow-[0_0_8px_var(--color-danger)]" />
          )}
        </button>

        <div className="flex items-center gap-1.5">
          <Radio size={12} className={connected ? "text-success" : "text-danger"} />
          <span className={connected ? "text-success" : "text-danger"}>
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-text-dim">
          <Activity size={12} className="text-secondary" />
          <span>
            <AnimatedNumber value={agents.length} className="text-text-bright tabular-nums" />{" "}
            agents
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-text-dim">
          <span>
            <AnimatedNumber value={connections} className="text-text-bright tabular-nums" /> conn
          </span>
        </div>

        {systemData?.projectCount != null && systemData.projectCount > 0 && (
          <div className="flex items-center gap-1.5 text-text-dim">
            <FolderKanban size={12} className="text-warning" />
            <span>
              <AnimatedNumber
                value={systemData.projectCount}
                className="text-text-bright tabular-nums"
              />{" "}
              proj
            </span>
          </div>
        )}

        {systemData?.connectorCount != null && systemData.connectorCount > 0 && (
          <div className="flex items-center gap-1.5 text-text-dim">
            <Plug size={12} className="text-accent" />
            <span>
              <AnimatedNumber
                value={systemData.connectorCount}
                className="text-text-bright tabular-nums"
              />{" "}
              conn
            </span>
          </div>
        )}

        {uptime > 0 && (
          <div className="text-text-dim">
            Uptime: <span className="text-text-bright">{formatUptime(uptime)}</span>
          </div>
        )}

        <a
          href="/canvas"
          className="flex items-center gap-1 text-text-dim transition-colors hover:text-primary"
          title="Open infinite canvas"
        >
          <Frame size={11} />
          <span>Canvas</span>
        </a>

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
            <button
              type="button"
              onClick={onSaveLayoutPreset}
              className="text-text-dim hover:text-primary transition-colors"
              title="Save current layout as new preset"
            >
              <Save size={11} />
            </button>
            <button
              type="button"
              onClick={() => activeLayoutId && onRenameLayoutPreset?.(activeLayoutId)}
              disabled={presetLocked || !activeLayoutId}
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
              disabled={presetLocked || layoutPresets.length <= 1 || !activeLayoutId}
              className={`${
                presetLocked || layoutPresets.length <= 1
                  ? "text-border cursor-not-allowed"
                  : "text-text-dim hover:text-danger"
              } transition-colors`}
              title={presetLocked ? "Default layout cannot be deleted" : "Delete selected preset"}
            >
              <Trash2 size={11} />
            </button>
          </div>
        )}

        <ThemeSwitcher />

        {onResetLayout && (
          <button
            type="button"
            onClick={onResetLayout}
            className="flex items-center gap-1 text-text-dim transition-colors hover:text-primary"
            title="Reset layout to default"
          >
            <RotateCcw size={11} />
            <span>Reset</span>
          </button>
        )}
      </div>
    </header>
  );
}
