// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import {
  type DashboardPanelProps,
  dashboardPanels,
  useDashboardPanels,
} from "../lib/panel-registry";
import { panelInstance } from "../lib/workspace-panel-instances";
import { AdminPanel } from "./AdminPanel";
import { CodingDeskPanel } from "./CodingDeskPanel";
import { ConversationInsights } from "./ConversationInsights";
import { CoordinationCard } from "./CoordinationCard";
import { EntityRoster } from "./EntityRoster";
import { GlassPanel } from "./GlassPanel";
import { NarrativePlayback } from "./NarrativePlayback";
import { ParticipantStreamsPanel } from "./ParticipantStreams";
import { PublishedPanel } from "./PublishedPanel";
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
  dashboardPanels.register({
    id,
    title,
    component,
    modes,
    slot: "grid",
    repeatable: id === "worldmap" ? { fromView: "map", actionLabel: "Open map below" } : undefined,
  }),
);
unregisterBuiltins.push(
  dashboardPanels.register({
    id: "coding-desk",
    title: "Coding desk",
    component: CodingDeskPanel,
    modes: [],
    slot: "grid",
    repeatable: { fromView: "work", actionLabel: "Open coding desk below" },
  }),
  dashboardPanels.register({
    id: "published",
    title: "Published panel",
    component: PublishedPanel,
    modes: [],
    slot: "grid",
    repeatable: { fromView: "canvas", actionLabel: "Open another view" },
  }),
  dashboardPanels.register({
    id: "streams",
    title: "Streams",
    component: ParticipantStreamsPanel,
    modes: [],
    slot: "grid",
    repeatable: { fromView: "streams", actionLabel: "Open streams below" },
  }),
);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    for (const unregister of unregisterBuiltins) unregister();
  });

/** Layout and navigation select manifests without importing panel implementations. */
export function useWorkspacePanels(
  legacy: boolean,
  panelProps: (key: string) => DashboardPanelProps,
  worldData: Parameters<typeof WorldMap>[0]["worldData"],
  instanceIds: readonly string[] = [],
): Array<[string, ReactNode]> {
  const panels = useDashboardPanels();
  const mode = legacy ? "legacy" : "workspace";
  const builtinPanels: Array<[string, ReactNode]> = panels
    .filter((panel) => panel.slot === "grid" && (!panel.modes || panel.modes.includes(mode)))
    .map((panel) => {
      const Panel = panel.component;
      return [panel.id, <Panel key={panel.id} worldData={worldData} {...panelProps(panel.id)} />];
    });
  const extraPanels: Array<[string, ReactNode]> = instanceIds.flatMap((id) => {
    const instance = panelInstance(id);
    const definition = panels.find(
      (panel) => panel.id === instance?.panelId && panel.slot === "grid" && panel.repeatable,
    );
    if (!instance) return [];
    if (!definition)
      return [
        [
          id,
          <GlassPanel key={id} title="Unavailable panel" {...panelProps(id)}>
            <p className="p-3 text-sm text-text-secondary">
              This panel is unavailable or does not support additional views. Close it to reclaim
              the space.
            </p>
          </GlassPanel>,
        ],
      ];
    const Panel = definition.component;
    return [
      [
        id,
        <Panel
          key={id}
          worldData={worldData}
          {...panelProps(id)}
          viewTitle={`${definition.title} ${instance.number}`}
        />,
      ],
    ];
  });
  return [...builtinPanels, ...extraPanels];
}
