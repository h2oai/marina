// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Admin panel tab, split out of AdminPanel.tsx without behaviour change. */

import { Plug } from "lucide-react";
import { useState } from "react";
import { useAdapters } from "../hooks/use-api";
import { deleteApi, patchApi, postApi } from "../lib/api";
import { PanelSkeleton } from "./OperatorFeedback";

const SUPPORTED_ADAPTERS = ["telegram", "discord"];

export function AdaptersTab() {
  const { data: adapters, isLoading, refetch } = useAdapters();
  const [adding, setAdding] = useState(false);
  const [platform, setPlatform] = useState("");

  const handleAdd = async () => {
    if (!platform) return;
    await postApi("/api/adapters", { platform });
    setPlatform("");
    setAdding(false);
    refetch();
  };

  const handleToggle = async (plat: string, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "disabled" : "active";
    await patchApi(`/api/adapters/${encodeURIComponent(plat)}`, { status: newStatus });
    refetch();
  };

  const handleDelete = async (plat: string) => {
    await deleteApi(`/api/adapters/${encodeURIComponent(plat)}`);
    refetch();
  };

  if (isLoading) return <PanelSkeleton />;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider">
          <Plug size={10} /> Platform Adapters
        </div>
        <button
          type="button"
          onClick={() => setAdding(!adding)}
          className="text-[9px] text-text-dim hover:text-primary transition-colors"
        >
          {adding ? "Cancel" : "+ Add"}
        </button>
      </div>

      {adding && (
        <div className="space-y-1 bg-bg-surface/50 rounded p-1.5 border border-border">
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] text-text-bright outline-none"
          >
            <option value="">Select platform...</option>
            {SUPPORTED_ADAPTERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleAdd}
            className="w-full bg-primary/20 hover:bg-primary/30 text-primary text-[10px] rounded px-2 py-0.5"
          >
            Enable Adapter
          </button>
        </div>
      )}

      {!adapters || adapters.length === 0 ? (
        <div className="text-text-dim text-[10px]">
          No adapters configured. Add one above or set TELEGRAM_TOKEN / DISCORD_TOKEN env vars.
        </div>
      ) : (
        adapters.map((a) => (
          <div
            key={a.platform}
            className="flex items-center gap-2 text-[10px] bg-bg-surface/30 rounded px-1.5 py-1"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${a.running ? "bg-green-400" : "bg-text-dim"}`}
            />
            <span className="text-text-bright font-medium">{a.platform}</span>
            <span className={a.running ? "text-green-400" : "text-text-dim"}>
              {a.running ? "running" : "stopped"}
            </span>
            <span className="text-text-dim text-[9px]">
              {a.source === "env" ? `(${a.envVar})` : `by ${a.set_by}`}
            </span>
            <span className="flex-1" />
            {a.source === "db" && (
              <>
                <button
                  type="button"
                  onClick={() => handleToggle(a.platform, a.running ? "active" : "disabled")}
                  className="text-[9px] text-text-dim hover:text-primary transition-colors"
                >
                  {a.running ? "Stop" : "Start"}
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(a.platform)}
                  className="text-[9px] text-text-dim hover:text-red-400 transition-colors"
                >
                  Remove
                </button>
              </>
            )}
            {a.source === "env" && (
              <button
                type="button"
                onClick={() => handleToggle(a.platform, a.running ? "active" : "disabled")}
                className="text-[9px] text-text-dim hover:text-primary transition-colors"
              >
                {a.running ? "Stop" : "Start"}
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
