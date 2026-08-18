// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useSystem, useWorld } from "../../hooks/use-api";
import { useWorldState } from "../../hooks/use-world-state";
import { formatBytes, formatUptime } from "../../lib/utils";

/** System metrics content — used as back-face inside AdminPanel. */
export function SystemMetricsContent({ uptime }: { uptime: number }) {
  const memory = useWorldState((s) => s.memory);
  const connections = useWorldState((s) => s.connections);
  const entities = useWorldState((s) => s.entities);
  const eventFeed = useWorldState((s) => s.eventFeed);
  const { data: worldData } = useWorld();
  const { data: systemData } = useSystem();

  const cmdsPerMin = useMemo(() => {
    const oneMinAgo = Date.now() - 60_000;
    return eventFeed.filter((e) => e.type === "command" && e.timestamp > oneMinAgo).length;
  }, [eventFeed]);

  const agentCount = entities.filter((e) => e.kind === "agent").length;
  const npcCount = entities.filter((e) => e.kind === "npc").length;

  const rows: { label: string; value: string | number }[] = [
    { label: "Uptime", value: uptime > 0 ? formatUptime(uptime) : "-" },
    { label: "Heap", value: formatBytes(memory.heapUsed) },
    { label: "RSS", value: formatBytes(memory.rss) },
    { label: "Rooms", value: worldData?.rooms.length ?? "-" },
    { label: "Entities", value: `${entities.length} (${agentCount}A / ${npcCount}N)` },
    { label: "Connections", value: connections },
    { label: "Cmds/min", value: cmdsPerMin },
    { label: "Feed size", value: eventFeed.length },
  ];

  if (systemData?.tasks) {
    const t = systemData.tasks;
    rows.push({
      label: "Tasks",
      value: `${t.open}o / ${t.claimed}c / ${t.submitted}s / ${t.completed}d`,
    });
  }
  if (systemData?.projectCount) {
    rows.push({ label: "Projects", value: systemData.projectCount });
  }
  if (systemData?.connectorCount) {
    rows.push({ label: "Connectors", value: systemData.connectorCount });
  }
  if (systemData?.commandCount) {
    rows.push({ label: "Dyn. Commands", value: systemData.commandCount });
  }

  return (
    <div className="flex flex-col gap-0.5 p-1.5 text-[11px]">
      {rows.map((r) => (
        <div key={r.label} className="flex justify-between">
          <span className="text-text-dim">{r.label}</span>
          <span className="text-text-bright">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
