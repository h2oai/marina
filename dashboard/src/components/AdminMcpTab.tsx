// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Admin panel tab, split out of AdminPanel.tsx without behaviour change. */

import { Wrench } from "lucide-react";
import { useMcpInfo } from "../hooks/use-api";
import { PanelSkeleton } from "./OperatorFeedback";

const CATEGORY_LABELS: Record<string, string> = {
  bootstrap: "Bootstrap",
  cognition: "Cognition",
  world: "World",
  coordination: "Coordination",
  canvas: "Canvas",
  building: "Building",
  escape: "Escape Hatch",
  session: "Session",
};

export function McpTab() {
  const { data: mcp } = useMcpInfo();

  if (!mcp) {
    return <PanelSkeleton />;
  }

  const totalTools = Object.values(mcp.tools).reduce((n, arr) => n + arr.length, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider">
        <Wrench size={10} /> MCP Server
      </div>
      <div className="space-y-1 text-[10px]">
        <div className="flex gap-2">
          <span className="text-text-dim">Endpoint:</span>
          <span className="text-text-bright font-mono text-[9px]">{mcp.url}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-text-dim">Port:</span>
          <span className="text-text">{mcp.port}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-text-dim">Tools:</span>
          <span className="text-text">{totalTools} registered</span>
        </div>
      </div>

      <div className="text-primary text-[10px] uppercase tracking-wider mt-2">Tool Categories</div>
      {Object.entries(mcp.tools).map(([category, tools]) => (
        <div key={category} className="space-y-0.5">
          <div className="text-accent text-[10px] font-medium">
            {CATEGORY_LABELS[category] ?? category}{" "}
            <span className="text-text-dim font-normal">({tools.length})</span>
          </div>
          {tools.map((t) => (
            <div key={t.name} className="flex gap-2 text-[10px] ml-2">
              <span className="text-text-bright">{t.name}</span>
              <span className="text-text-dim">{t.description}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
