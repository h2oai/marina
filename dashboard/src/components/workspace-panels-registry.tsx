// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { dashboardPanels, useDashboardPanels } from "../lib/panel-registry";
import { AdminPanel } from "./AdminPanel";
import { ConversationInsights } from "./ConversationInsights";
import { CoordinationCard } from "./CoordinationCard";
import { EntityRoster } from "./EntityRoster";
import type { PanelFocusProps } from "./GlassPanel";
import { NarrativePlayback } from "./NarrativePlayback";
import { RoomDetail } from "./RoomDetail";
import { WebChat } from "./WebChat";
import { ContextPanel, WorkspacePanel } from "./WorkspacePanels";
import { WorldMap } from "./WorldMap";

// Builtins use the same component manifest as locally bundled panels.
const unregisterBuiltins = (
  [
    ["webchat", "Chat", WebChat, ["workspace", "legacy"]],
    ["insights", "Insights", ConversationInsights, ["legacy"]],
    ["worldmap", "World", WorldMap, ["legacy"]],
    ["coordination", "Coordination", CoordinationCard, ["legacy"]],
    ["entities", "Entities", EntityRoster, ["legacy"]],
    ["playback", "Playback", NarrativePlayback, ["legacy"]],
    ["room", "Room", RoomDetail, ["legacy"]],
    ["admin", "Admin", AdminPanel, ["legacy"]],
    ["workspace", "Workspace", WorkspacePanel, ["workspace"]],
    ["context", "Context", ContextPanel, ["workspace"]],
  ] as const
).map(([id, title, component, modes]) =>
  dashboardPanels.register({ id, title, component, modes, slot: "grid" }),
);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    for (const unregister of unregisterBuiltins) unregister();
  });

/** Layout and navigation select manifests without importing panel implementations. */
export function useWorkspacePanels(
  legacy: boolean,
  panelProps: (key: string) => PanelFocusProps,
  worldData: Parameters<typeof WorldMap>[0]["worldData"],
): Array<[string, ReactNode]> {
  const panels = useDashboardPanels();
  const mode = legacy ? "legacy" : "workspace";
  return panels
    .filter((panel) => panel.slot === "grid" && (!panel.modes || panel.modes.includes(mode)))
    .map((panel) => {
      const Panel = panel.component;
      return [panel.id, <Panel key={panel.id} worldData={worldData} {...panelProps(panel.id)} />];
    });
}
