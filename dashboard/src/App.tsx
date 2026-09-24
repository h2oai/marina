// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  type Layout,
  ResponsiveGridLayout,
  type ResponsiveLayouts,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { AdminPanel } from "./components/AdminPanel";
import { AttentionDrawer } from "./components/AttentionDrawer";
import { PinToCanvasDialog } from "./components/CanvasReference";
import { ConversationInsights } from "./components/ConversationInsights";
import { CoordinationCard } from "./components/CoordinationCard";
import { DiscoveryPalette } from "./components/DiscoveryPalette";
import { EntityPreviewTooltip } from "./components/EntityPreviewTooltip";
import { EntityRoster } from "./components/EntityRoster";
import { FirstRunGuide } from "./components/FirstRunGuide";
import { Header } from "./components/Header";
import { DeferredDrawer, MemoryWorkspace, PulseDrawer } from "./components/lazy-tabs";
import { NarrativePlayback } from "./components/NarrativePlayback";
import {
  ApiFeedback,
  ConnectionBanner,
  RecentActivity,
  ShortcutHelp,
} from "./components/OperatorFeedback";
import { RoomDetail } from "./components/RoomDetail";
import { WebChat } from "./components/WebChat";
import { ContextPanel, WorkspacePanel } from "./components/WorkspacePanels";
import { WorldMap } from "./components/WorldMap";
import { useSystem, useWorld } from "./hooks/use-api";
import { useChatState } from "./hooks/use-chat-state";
import { useLayoutPresets } from "./hooks/use-layout-presets";
import { useGlobalRealtimeInvalidations } from "./hooks/use-realtime-invalidations";
import { useDashboardWebSocket } from "./hooks/use-websocket";
import { useWorkspaceState, type WorkspacePane } from "./hooks/use-workspace-state";
import { useWorldState } from "./hooks/use-world-state";
import { isEditing } from "./lib/command-discovery";
import { dashboardInspectionFromSearch } from "./lib/marina-reference";
import { traceIdFromSearch } from "./lib/trace-links";
import { BUILTIN_PRESETS, WORKSPACE_LAYOUTS } from "./lib/workspace-layouts";

type Bp = "lg" | "md";
const PANES: WorkspacePane[] = ["webchat", "workspace", "context"];

export default function App() {
  const { connected } = useDashboardWebSocket();
  useGlobalRealtimeInvalidations();
  const { data: worldData } = useWorld();
  const { data: systemData } = useSystem();
  const { width, containerRef, mounted } = useContainerWidth();
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [drawer, setDrawer] = useState<"attention" | "pulse" | "memory" | null>(null);
  const preset = useLayoutPresets(WORKSPACE_LAYOUTS, BUILTIN_PRESETS);
  const [layouts, setLayouts] = useState<ResponsiveLayouts<Bp>>(
    () => preset.presets.find((p) => p.id === preset.activeId)?.layouts ?? WORKSPACE_LAYOUTS,
  );
  const [focused, setFocused] = useState<string | null>(null);
  const [height, setHeight] = useState(650);
  const pane = useWorkspaceState((s) => s.pane);
  const fullscreen = useWorkspaceState((s) => s.fullscreen);
  const view = useWorkspaceState((s) => s.view);
  const legacy = !(layouts.lg ?? layouts.md ?? []).some((item) => item.i === "workspace");
  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const initialPreset = useRef(preset.presets.find((p) => p.id === preset.activeId));
  useEffect(() => {
    if (
      !window.location.pathname.startsWith("/canvas") &&
      !new URLSearchParams(window.location.search).has("view")
    )
      useWorkspaceState.getState().setView(initialPreset.current?.view ?? "work");
  }, []);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.height > 0) setHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  const focus = useCallback((key: string) => {
    setFocused((current) => (current === key ? null : key));
    if (PANES.includes(key as WorkspacePane))
      useWorkspaceState.setState({ pane: key as WorkspacePane });
  }, []);
  const openView = useCallback(
    (next: "work" | "admin" | "canvas") => {
      if (legacy) {
        setLayouts(WORKSPACE_LAYOUTS);
        preset.applyPreset("default");
      }
      useWorkspaceState.getState().setView(next);
    },
    [legacy, preset.applyPreset],
  );

  // Preserve ordinary anchors for new tabs, but navigate within this mounted shell.
  useEffect(() => {
    const restore = () => {
      const url = new URL(window.location.href);
      const inspection = dashboardInspectionFromSearch(url.search);
      if (inspection) useWorkspaceState.getState().inspect(inspection);
      const canvas =
        url.pathname.startsWith("/canvas") || url.searchParams.get("view") === "canvas";
      useWorkspaceState.setState({ fullscreen: url.pathname.startsWith("/canvas") });
      if (canvas) openView("canvas");
      else if (["work", "map", "observe", "admin"].includes(url.searchParams.get("view") ?? ""))
        useWorkspaceState
          .getState()
          .setView(url.searchParams.get("view") as "work" | "map" | "observe" | "admin");
    };
    const navigate = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (
        url.origin !== window.location.origin ||
        !["/dashboard", "/canvas"].includes(url.pathname)
      )
        return;
      if (
        !url.pathname.startsWith("/canvas") &&
        !dashboardInspectionFromSearch(url.search) &&
        !url.searchParams.has("view")
      )
        return;
      event.preventDefault();
      window.history.pushState(null, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    restore();
    document.addEventListener("click", navigate);
    window.addEventListener("popstate", restore);
    return () => {
      document.removeEventListener("click", navigate);
      window.removeEventListener("popstate", restore);
    };
  }, [openView]);

  useEffect(
    () =>
      useWorldState.subscribe((state, prev) => {
        if (state.selectedEntity && state.selectedEntity !== prev.selectedEntity)
          useWorkspaceState.getState().inspect({ type: "entity", name: state.selectedEntity });
        if (state.selectedRoom && state.selectedRoom !== prev.selectedRoom)
          useWorkspaceState.getState().inspect({ type: "room", id: state.selectedRoom });
      }),
    [],
  );
  useEffect(() => {
    const admin = () => openView("admin");
    const chat = () => {
      useWorkspaceState.setState({ pane: "webchat", fullscreen: false });
    };
    window.addEventListener("marina:open-traces", admin);
    window.addEventListener("marina:open-admin", admin);
    window.addEventListener("marina:open-operations", admin);
    window.addEventListener("marina:open-keys", admin);
    window.addEventListener("marina:open-coding", chat);
    window.addEventListener("marina:draft-command", chat);
    return () => {
      window.removeEventListener("marina:open-traces", admin);
      window.removeEventListener("marina:open-admin", admin);
      window.removeEventListener("marina:open-operations", admin);
      window.removeEventListener("marina:open-keys", admin);
      window.removeEventListener("marina:open-coding", chat);
      window.removeEventListener("marina:draft-command", chat);
    };
  }, [openView]);
  useEffect(() => {
    const traceId = traceIdFromSearch(window.location.search);
    if (!traceId) return;
    const timer = window.setTimeout(
      () => window.dispatchEvent(new CustomEvent("marina:open-traces", { detail: { traceId } })),
      0,
    );
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const keys = legacy ? (layouts.lg ?? []).map((l) => l.i) : PANES;
    const selectPane = (key: string) => {
      useWorkspaceState.setState({ pane: key as WorkspacePane });
      requestAnimationFrame(() =>
        panelRefs.current[key]
          ?.querySelector<HTMLElement>("input, button, [tabindex='0']")
          ?.focus(),
      );
    };
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
        return;
      }
      if (isEditing(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
      }
      if (event.key === "Escape") {
        setFocused(null);
        if (useWorkspaceState.getState().fullscreen) {
          const url = new URL(window.location.href);
          url.pathname = "/dashboard";
          window.history.pushState(null, "", url);
          useWorkspaceState.setState({ fullscreen: false });
        }
      }
      const index = Number(event.key) - 1;
      if (index >= 0 && index < keys.length) {
        event.preventDefault();
        selectPane(keys[index]!);
      }
      if (event.key === "`") {
        event.preventDefault();
        selectPane(keys[(keys.indexOf(useWorkspaceState.getState().pane) + 1) % keys.length]!);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [legacy, layouts]);

  const selectPreset = (id: string) => {
    const next = preset.applyPreset(id);
    if (!next) return;
    setLayouts(next);
    setFocused(null);
    const selected = preset.presets.find((p) => p.id === id);
    useWorkspaceState.setState({ fullscreen: false });
    useWorkspaceState.getState().setView(selected?.view ?? "work");
    const url = new URL(window.location.href);
    url.pathname = "/dashboard";
    url.searchParams.set("view", selected?.view ?? "work");
    window.history.replaceState(null, "", url);
  };
  const handleLayoutChange = (_current: Layout, all: ResponsiveLayouts<Bp>) => {
    if (focused || width < 800 || fullscreen) return;
    setLayouts(all);
    preset.updateActiveLayouts(all);
  };
  const columns = legacy ? { lg: 12, md: 10 } : { lg: 20, md: 20 };
  const effectiveLayouts = focused
    ? Object.fromEntries(
        (["lg", "md"] as const).map((bp) => {
          const items = layouts[bp] ?? [];
          const rest = items.filter((l) => l.i !== focused);
          const cols = columns[bp];
          return [
            bp,
            [
              { i: focused, x: 0, y: 0, w: Math.floor(cols * 0.7), h: 12 },
              ...rest.map((l, i) => ({
                ...l,
                x: Math.floor(cols * 0.7),
                y: i * Math.max(2, Math.floor(12 / rest.length)),
                w: cols - Math.floor(cols * 0.7),
                minW: 1,
                h: Math.max(2, Math.floor(12 / rest.length)),
              })),
            ],
          ];
        }),
      )
    : layouts;
  const rows = Math.max(
    12,
    ...(effectiveLayouts[width >= 1200 ? "lg" : "md"] ?? []).map((l) => l.y + l.h),
  );
  const panelProps = (key: string) => ({
    isFocused: focused === key,
    onToggleFocus: () => focus(key),
  });
  const panels: Array<[string, ReactNode]> = [
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

  return (
    <div
      className={`workspace-shell scanlines flex h-dvh flex-col gap-1 p-1 ${fullscreen ? "canvas-fullscreen" : ""}`}
      data-pane={pane}
    >
      <Header
        connected={connected}
        uptime={systemData?.uptime ?? 0}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onResetLayout={() => selectPreset("default")}
        layoutPresets={preset.presets}
        activeLayoutId={preset.activeId}
        onSelectLayoutPreset={selectPreset}
        onSaveLayoutPreset={() => {
          const name = window.prompt("Name this workspace layout", "New workspace");
          if (name?.trim()) preset.savePreset(name, layouts, view);
        }}
        onRenameLayoutPreset={(id) => {
          const name = window.prompt(
            "Rename workspace",
            preset.presets.find((p) => p.id === id)?.name,
          );
          if (name?.trim()) preset.renamePreset(id, name);
        }}
        onDeleteLayoutPreset={(id) => {
          preset.deletePreset(id);
          selectPreset("default");
        }}
        onOpenAttention={() => setDrawer(drawer === "attention" ? null : "attention")}
        onOpenPulse={() => setDrawer(drawer === "pulse" ? null : "pulse")}
        onOpenMemory={() => setDrawer(drawer === "memory" ? null : "memory")}
        onOpenWork={() => {
          setDrawer(null);
          openView("work");
        }}
        onOpenTraces={() => window.dispatchEvent(new CustomEvent("marina:open-traces"))}
      />
      <ConnectionBanner connected={connected} />
      <ApiFeedback />
      <EntityPreviewTooltip />
      <RecentActivity onOpen={() => setDrawer("pulse")} />
      {searchOpen && <DiscoveryPalette onClose={() => setSearchOpen(false)} />}
      {shortcutsOpen && <ShortcutHelp onClose={() => setShortcutsOpen(false)} />}
      <PinToCanvasDialog />
      <AttentionDrawer open={drawer === "attention"} onClose={() => setDrawer(null)} />
      <DeferredDrawer open={drawer === "pulse"}>
        <PulseDrawer open={drawer === "pulse"} onClose={() => setDrawer(null)} />
      </DeferredDrawer>
      <DeferredDrawer open={drawer === "memory"}>
        <MemoryWorkspace open={drawer === "memory"} onClose={() => setDrawer(null)} />
      </DeferredDrawer>
      <FirstRunGuide
        onFocusChat={() => {
          useWorkspaceState.setState({ pane: "webchat", fullscreen: false });
          setTimeout(
            () =>
              document
                .querySelector<HTMLInputElement>(
                  useChatState.getState().loggedIn ? "#marina-command-input" : "#marina-name-input",
                )
                ?.focus(),
            50,
          );
        }}
        onOpenKeys={() => window.dispatchEvent(new CustomEvent("marina:open-keys"))}
      />
      {!legacy && (
        <nav aria-label="Dashboard panes" className="mobile-pane-tabs gap-1">
          {PANES.map((key, i) => (
            <button
              type="button"
              key={key}
              aria-pressed={pane === key}
              onClick={() => useWorkspaceState.setState({ pane: key })}
              className={`flex-1 rounded px-3 py-2 text-sm ${pane === key ? "bg-primary/15 text-primary" : "text-text-dim"}`}
            >
              {["Chat", "Workspace", "Context"][i]}
            </button>
          ))}
        </nav>
      )}
      <div
        ref={containerRef}
        className={`dashboard-grid min-h-0 min-w-0 flex-1 overflow-auto ${legacy ? "legacy-grid" : "workspace-grid"}`}
      >
        {mounted && (
          <ResponsiveGridLayout
            width={width}
            layouts={effectiveLayouts}
            breakpoints={{ lg: 1200, md: 0 }}
            cols={columns}
            rowHeight={Math.max(20, (height - (rows + 1) * 4) / rows)}
            margin={[4, 4]}
            autoSize={false}
            dragConfig={{
              enabled: width >= 800 && !fullscreen,
              handle: ".drag-handle",
              cancel: "button, input, select, textarea, a",
            }}
            resizeConfig={{ enabled: width >= 800 && !fullscreen, handles: ["se"] }}
            compactor={verticalCompactor}
            onLayoutChange={handleLayoutChange}
          >
            {panels.map(([key, content]) => (
              <div
                key={key}
                data-pane-key={key}
                ref={(el) => {
                  panelRefs.current[key] = el;
                }}
                className={focused === key ? "panel-focused" : undefined}
              >
                {content}
              </div>
            ))}
          </ResponsiveGridLayout>
        )}
      </div>
    </div>
  );
}
