// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, useState } from "react";
import { useWorld } from "../hooks/use-api";
import { openCanvas, useWorkspaceState, type WorkspaceView } from "../hooks/use-workspace-state";
import { useWorldState } from "../hooks/use-world-state";
import { AdminPanel } from "./AdminPanel";
import { WorldMapHeatmap } from "./back-faces/WorldMapHeatmap";
import { PinToCanvas, ReferenceContent } from "./CanvasReference";
import { ConversationInsights } from "./ConversationInsights";
import { CoordinationCard, DetailPanel } from "./CoordinationCard";
import { EntityInspector } from "./EntityInspector";
import { EntityRoster } from "./EntityRoster";
import { GlassPanel, type PanelFocusProps } from "./GlassPanel";
import { MyInventory } from "./MyInventory";
import { NarrativePlayback } from "./NarrativePlayback";
import { RoomDetail } from "./RoomDetail";
import { WorkOverview } from "./WorkDrawer";
import { WorldMap } from "./WorldMap";

const Canvas = lazy(() => import("../canvas/CanvasPage").then((m) => ({ default: m.CanvasPage })));
const VIEWS: Array<[WorkspaceView, string]> = [
  ["work", "Work"],
  ["canvas", "Canvas"],
  ["map", "Map"],
  ["observe", "Observe"],
  ["admin", "Admin"],
];
export function WorkspacePanel(props: PanelFocusProps) {
  const view = useWorkspaceState((s) => s.view);
  const fullscreen = useWorkspaceState((s) => s.fullscreen);
  const [visited, setVisited] = useState<Set<WorkspaceView>>(() => new Set([view, "admin"]));
  if (!visited.has(view)) setVisited(new Set([...visited, view]));
  const { data: worldData } = useWorld();
  return (
    <GlassPanel
      title="Workspace"
      {...props}
      bodyScroll={false}
      headerExtra={
        view === "canvas" && (
          <button
            type="button"
            className="text-xs text-primary"
            onClick={() => openCanvas(undefined, undefined, !fullscreen)}
          >
            {fullscreen ? "Exit full screen" : "Full screen"}
          </button>
        )
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div
          role="tablist"
          aria-label="Workspace views"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-1"
        >
          {VIEWS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              aria-controls={`view-${id}`}
              id={`tab-${id}`}
              className={`rounded px-3 py-2 text-sm ${view === id ? "bg-primary/15 text-primary" : "text-text-dim hover:text-text"}`}
              onClick={() => {
                useWorkspaceState.getState().setView(id);
                if (id === "canvas") openCanvas();
                else {
                  const url = new URL(window.location.href);
                  url.pathname = "/dashboard";
                  url.searchParams.set("view", id);
                  window.history.pushState(null, "", url);
                  useWorkspaceState.setState({ fullscreen: false });
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {VIEWS.filter(([id]) => visited.has(id)).map(([id]) => (
          <div
            key={id}
            id={`view-${id}`}
            role="tabpanel"
            aria-labelledby={`tab-${id}`}
            hidden={view !== id}
            className="workspace-view min-h-0 flex-1 overflow-hidden"
          >
            {id === "work" && (
              <div className="flex h-full flex-col">
                <div className="min-h-0 flex-1">
                  <WorkOverview embedded />
                </div>
                <details className="max-h-[50%] shrink-0 overflow-auto border-t border-border p-2 text-sm">
                  <summary className="cursor-pointer text-primary">
                    Boards, channels and coordination
                  </summary>
                  <div className="h-72">
                    <CoordinationCard onInspect={useWorkspaceState.getState().inspect} />
                  </div>
                </details>
              </div>
            )}
            {id === "canvas" && (
              <Suspense
                fallback={
                  <p role="status" className="p-4">
                    Loading Canvas…
                  </p>
                }
              >
                <Canvas embedded active={view === "canvas"} />
              </Suspense>
            )}
            {id === "map" && (
              <WorldMap
                worldData={worldData}
                showTimeline={false}
                backContent={<WorldMapHeatmap worldData={worldData} />}
              />
            )}
            {id === "observe" && (
              <div className="grid h-full min-h-0 grid-rows-2 gap-2">
                <NarrativePlayback />
                <ConversationInsights />
              </div>
            )}
            {id === "admin" && <AdminPanel />}
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}

export function ContextPanel(props: PanelFocusProps) {
  const selection = useWorkspaceState((s) => s.selection);
  const entities = useWorldState((s) => s.entities);
  const entity =
    selection?.type === "entity" ? entities.find((e) => e.name === selection.name) : undefined;
  return (
    <GlassPanel title="Context" {...props} bodyScroll={false}>
      <div className="flex h-full min-h-0 flex-col">
        <MyInventory />
        <div className={selection ? "h-[30%] min-h-24 shrink-0" : "min-h-0 flex-1"}>
          <EntityRoster compact />
        </div>
        <section
          className="min-h-0 flex-1 overflow-auto border-t border-border text-sm"
          aria-label="Shared inspector"
        >
          {selection && selection.type !== "node" && (
            <div className="flex items-center justify-between border-b border-border p-2">
              <span className="capitalize">
                {selection.type === "reference" ? selection.reference.kind : selection.type}
              </span>
              <button
                type="button"
                aria-label="Close inspector"
                onClick={() => useWorkspaceState.getState().inspect(null)}
              >
                ×
              </button>
            </div>
          )}
          <div id="canvas-inspector" hidden={selection?.type !== "node"} className="h-full" />
          {entity && <EntityInspector name={entity.name} />}
          {selection?.type === "room" && <RoomDetail />}
          {selection?.type === "reference" && (
            <div className="p-3">
              <ReferenceContent reference={selection.reference} />
            </div>
          )}
          {selection && !["entity", "room", "node", "reference"].includes(selection.type) && (
            <div className="p-2">
              {selection.type === "task" && (
                <PinToCanvas reference={{ kind: "task", id: String(selection.id) }} />
              )}
              <DetailPanel
                detail={selection as Parameters<typeof DetailPanel>[0]["detail"]}
                onBack={() => useWorkspaceState.getState().inspect(null)}
                onNavigate={(next) => useWorkspaceState.getState().inspect(next)}
              />
            </div>
          )}
          {!selection && (
            <p className="p-4 text-text-dim">
              Select an agent, task, room, or canvas node to inspect it here.
            </p>
          )}
        </section>
      </div>
    </GlassPanel>
  );
}
