// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
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

/** Internal panel composition; layout and navigation remain independent of panel implementation. */
export function workspacePanels(
  legacy: boolean,
  panelProps: (key: string) => PanelFocusProps,
  worldData: Parameters<typeof WorldMap>[0]["worldData"],
): Array<[string, ReactNode]> {
  return [
    ["webchat", <WebChat key="webchat" {...panelProps("webchat")} />],
    ...(legacy
      ? ([
          ["insights", <ConversationInsights key="insights" {...panelProps("insights")} />],
          [
            "worldmap",
            <WorldMap key="worldmap" worldData={worldData} {...panelProps("worldmap")} />,
          ],
          ["coordination", <CoordinationCard key="coordination" {...panelProps("coordination")} />],
          ["entities", <EntityRoster key="entities" {...panelProps("entities")} />],
          ["playback", <NarrativePlayback key="playback" {...panelProps("playback")} />],
          ["room", <RoomDetail key="room" {...panelProps("room")} />],
          ["admin", <AdminPanel key="admin" {...panelProps("admin")} />],
        ] as Array<[string, ReactNode]>)
      : ([
          ["workspace", <WorkspacePanel key="workspace" {...panelProps("workspace")} />],
          ["context", <ContextPanel key="context" {...panelProps("context")} />],
        ] as Array<[string, ReactNode]>)),
  ];
}
