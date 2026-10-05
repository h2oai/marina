// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getBreakpointFromWidth,
  type Layout,
  type ResponsiveLayouts,
  useContainerWidth,
} from "react-grid-layout";
import { AttentionDrawer } from "./components/AttentionDrawer";
import { PinToCanvasDialog } from "./components/CanvasReference";
import { DiscoveryPalette } from "./components/DiscoveryPalette";
import { EntityPreviewTooltip } from "./components/EntityPreviewTooltip";
import { FirstRunGuide } from "./components/FirstRunGuide";
import { Header } from "./components/Header";
import { DeferredDrawer, MemoryWorkspace, PulseDrawer } from "./components/lazy-tabs";
import {
  ApiFeedback,
  ConnectionBanner,
  RecentActivity,
  ShortcutHelp,
} from "./components/OperatorFeedback";
import { WorkspaceCanvas as CanvasWorkspace } from "./components/workspace-canvas";
import { useWorkspacePanels } from "./components/workspace-panels-registry";
import { useSystem, useWorld } from "./hooks/use-api";
import { useChatState } from "./hooks/use-chat-state";
import { useDashboardNavigation } from "./hooks/use-dashboard-navigation";
import { useLayoutHistory } from "./hooks/use-layout-history";
import { useLayoutPresets } from "./hooks/use-layout-presets";
import { useGlobalRealtimeInvalidations } from "./hooks/use-realtime-invalidations";
import { useDashboardWebSocket } from "./hooks/use-websocket";
import {
  type MemoryDestination,
  useWorkspaceState,
  type WorkspacePane,
} from "./hooks/use-workspace-state";
import { isEditing } from "./lib/command-discovery";
import {
  boundPanel,
  type PanelBinding,
  type PanelBindings,
  parsePanelBinding,
} from "./lib/panel-bindings";
import { dashboardPanels } from "./lib/panel-registry";
import { balanceWorkspaceRows, nudgeWorkspacePanel } from "./lib/workspace-canvas-layout";
import { BUILTIN_PRESETS, WORKSPACE_LAYOUTS } from "./lib/workspace-layouts";
import {
  closePanelInstance,
  MAX_EXTRA_PANELS,
  openPanelBelow,
  panelInstance,
  panelInstanceIds,
} from "./lib/workspace-panel-instances";

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
  const [memoryDestination, setMemoryDestination] = useState<MemoryDestination>({});
  const preset = useLayoutPresets(WORKSPACE_LAYOUTS, BUILTIN_PRESETS);
  const layoutHistory = useLayoutHistory(
    () => preset.presets.find((p) => p.id === preset.activeId)?.layouts ?? WORKSPACE_LAYOUTS,
  );
  const { layouts, reset: setLayouts } = layoutHistory;
  useEffect(() => {
    preset.updateActiveLayouts(layouts);
  }, [layouts, preset.updateActiveLayouts]);
  const resident = useChatState((s) => (s.loggedIn ? s.entityName : null));
  const [bindings, setBindings] = useState<PanelBindings>(
    () => preset.presets.find((p) => p.id === preset.activeId)?.bindings ?? {},
  );
  const [panelNotice, setPanelNotice] = useState("");
  const [focused, setFocused] = useState<string | null>(null);
  const [height, setHeight] = useState(650);
  const pane = useWorkspaceState((s) => s.pane);
  const fullscreen = useWorkspaceState((s) => s.fullscreen);
  const view = useWorkspaceState((s) => s.view);
  const legacy = !(layouts.lg ?? layouts.md ?? []).some((item) => item.i === "workspace");
  const instanceIds = panelInstanceIds(layouts).slice(0, MAX_EXTRA_PANELS);
  const columns = legacy ? { lg: 12, md: 10 } : { lg: 20, md: 20 };
  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pendingPanelFocus = useRef<string | null>(null);
  const assignPanelRef = useCallback((id: string, element: HTMLDivElement | null) => {
    panelRefs.current[id] = element;
    if (!element || pendingPanelFocus.current !== id) return;
    pendingPanelFocus.current = null;
    requestAnimationFrame(() => {
      if (!element.isConnected) return;
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      element
        .querySelector<HTMLElement>("button, input, [tabindex='0']")
        ?.focus({ preventScroll: true });
    });
  }, []);
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
    if (PANES.includes(key as WorkspacePane) || panelInstance(key))
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
    [legacy, preset.applyPreset, setLayouts],
  );

  useDashboardNavigation(openView, setDrawer, setMemoryDestination);

  useEffect(() => {
    const keys = legacy
      ? (layouts.lg ?? []).map((l) => l.i)
      : [...PANES, ...panelInstanceIds(layouts).slice(0, MAX_EXTRA_PANELS)];
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
    setBindings(selected?.bindings ?? {});
    useWorkspaceState.setState({ fullscreen: false });
    useWorkspaceState.getState().setView(selected?.view ?? "work");
    const url = new URL(window.location.href);
    url.pathname = "/dashboard";
    url.searchParams.set("view", selected?.view ?? "work");
    window.history.replaceState(null, "", url);
  };
  const handleLayoutChange = (_current: Layout, all: ResponsiveLayouts<Bp>) => {
    if (focused || width < 800 || fullscreen) return;
    layoutHistory.commit(all);
  };
  const openViewBelow = (sourceId: string, panelId: string, target?: PanelBinding | null) => {
    const next = openPanelBelow(layouts, sourceId, panelId, columns);
    if (!next) {
      setPanelNotice("Close an extra view before opening another panel.");
      return;
    }
    setPanelNotice("");
    const copiedTarget = target ?? boundPanel(bindings, sourceId, resident);
    const nextBindings = { ...bindings };
    if (copiedTarget) nextBindings[next.id] = { resident, target: copiedTarget };
    setBindings(nextBindings);
    pendingPanelFocus.current = next.id;
    setLayouts(next.layouts);
    preset.updateActiveLayouts(next.layouts, nextBindings);
    setFocused(null);
    useWorkspaceState.setState({ pane: next.id, fullscreen: false });
  };
  const closeView = (id: string) => {
    const next = closePanelInstance(layouts, id, columns);
    const destination = legacy ? "worldmap" : "workspace";
    pendingPanelFocus.current = destination;
    const nextBindings = { ...bindings };
    delete nextBindings[id];
    setBindings(nextBindings);
    setLayouts(next);
    preset.updateActiveLayouts(next, nextBindings);
    if (focused === id) setFocused(null);
    useWorkspaceState.setState({ pane: destination as WorkspacePane });
  };
  const openBoundRef = useRef(openViewBelow);
  openBoundRef.current = openViewBelow;
  useEffect(() => {
    const open = (event: Event) => {
      const target = parsePanelBinding((event as CustomEvent).detail);
      if (target)
        openBoundRef.current(
          legacy ? "worldmap" : "workspace",
          target.kind === "canvas-node"
            ? "published"
            : target.kind === "coding"
              ? "coding-desk"
              : "streams",
          target,
        );
    };
    window.addEventListener("marina:open-panel", open);
    return () => window.removeEventListener("marina:open-panel", open);
  }, [legacy]);
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
  const rows =
    instanceIds.length && !focused
      ? 12
      : Math.max(
          12,
          ...(effectiveLayouts[width >= 1200 ? "lg" : "md"] ?? []).map((l) => l.y + l.h),
        );
  const panelProps = (key: string) => {
    const repeatable = dashboardPanels
      .getSnapshot()
      .find(
        (definition) =>
          definition.slot === "grid" &&
          definition.repeatable &&
          (key === "workspace"
            ? !["published", "coding-desk"].includes(definition.id) &&
              definition.repeatable.fromView === view
            : definition.id === (panelInstance(key)?.panelId ?? key)),
      );
    return {
      binding: boundPanel(bindings, key, resident),
      onBindingChange: (target: PanelBinding | null) => {
        const next = { ...bindings };
        if (target) next[key] = { resident, target };
        else delete next[key];
        setBindings(next);
        preset.updateActiveLayouts(layouts, next);
      },
      isFocused: focused === key,
      onToggleFocus: () => focus(key),
      active: fullscreen ? key === "workspace" : width >= 800 || pane === key,
      openBelow: repeatable
        ? {
            label: repeatable.repeatable!.actionLabel,
            run: () => openViewBelow(key, repeatable.id),
            disabled: instanceIds.length >= MAX_EXTRA_PANELS,
          }
        : undefined,
      onCloseView: panelInstance(key) ? () => closeView(key) : undefined,
    };
  };
  const panels = useWorkspacePanels(legacy, panelProps, worldData, instanceIds);
  const breakpoint = getBreakpointFromWidth<Bp>({ lg: 1200, md: 0 }, width);
  const rowHeight = Math.max(20, (height - (rows + 1) * 4) / rows);

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
        onUndoLayout={layoutHistory.canUndo ? layoutHistory.undo : undefined}
        onRedoLayout={layoutHistory.canRedo ? layoutHistory.redo : undefined}
        onBalanceLayout={
          !focused && !fullscreen && width >= 800
            ? () => {
                const bp = width >= 1200 ? "lg" : "md";
                layoutHistory.commit({
                  ...layouts,
                  [bp]: balanceWorkspaceRows(layouts[bp] ?? [], columns[bp]),
                });
              }
            : undefined
        }
        onMovePanel={
          !focused && !fullscreen && width >= 800
            ? (dx, dy) => {
                const bp = width >= 1200 ? "lg" : "md";
                layoutHistory.commit({
                  ...layouts,
                  [bp]: nudgeWorkspacePanel(layouts[bp] ?? [], pane, dx, dy, columns[bp]),
                });
              }
            : undefined
        }
        selectedPanel={pane}
        movablePanels={panels.map(([id]) => ({
          id,
          label:
            id === "webchat"
              ? "Chat"
              : id === "workspace"
                ? "Workspace"
                : id === "context"
                  ? "Context"
                  : id,
        }))}
        onSelectPanel={(id) => useWorkspaceState.setState({ pane: id as WorkspacePane })}
        layoutPresets={preset.presets}
        activeLayoutId={preset.activeId}
        onSelectLayoutPreset={selectPreset}
        onSaveLayoutPreset={() => {
          const name = window.prompt("Name this workspace layout", "New workspace");
          if (name?.trim()) preset.savePreset(name, layouts, view, bindings);
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
        onOpenMemory={() => {
          setMemoryDestination({});
          setDrawer(drawer === "memory" ? null : "memory");
        }}
        onOpenWork={() => {
          setDrawer(null);
          openView("work");
        }}
        onOpenTraces={() => window.dispatchEvent(new CustomEvent("marina:open-traces"))}
      />
      <ConnectionBanner connected={connected} />
      <ApiFeedback />
      {panelNotice && (
        <p role="status" className="text-sm">
          {panelNotice}
        </p>
      )}
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
        <MemoryWorkspace
          open={drawer === "memory"}
          onClose={() => setDrawer(null)}
          destination={memoryDestination}
        />
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
        <nav
          aria-label="Dashboard panes"
          className="mobile-pane-tabs shrink-0 overflow-x-auto gap-1"
        >
          {[...PANES, ...instanceIds].map((key, i) => (
            <button
              type="button"
              key={key}
              aria-pressed={pane === key}
              onClick={() => useWorkspaceState.setState({ pane: key })}
              className={`shrink-0 grow whitespace-nowrap rounded px-3 py-2 text-sm ${pane === key ? "bg-primary/15 text-primary" : "text-text-dim"}`}
            >
              {["Chat", "Workspace", "Context"][i] ??
                `${dashboardPanels.getSnapshot().find((definition) => definition.id === panelInstance(key)?.panelId)?.title ?? "View"} ${panelInstance(key)?.number}`}
            </button>
          ))}
        </nav>
      )}
      <div
        ref={containerRef}
        className={`dashboard-grid min-h-0 min-w-0 flex-1 overflow-auto ${legacy ? "legacy-grid" : "workspace-grid"}`}
      >
        {mounted && (
          <CanvasWorkspace
            panels={panels}
            layout={effectiveLayouts[breakpoint] ?? effectiveLayouts.lg ?? []}
            width={width}
            height={height}
            cols={columns[breakpoint]}
            rowHeight={rowHeight}
            focused={focused}
            visiblePane={
              legacy ? undefined : fullscreen ? "workspace" : width < 800 ? pane : undefined
            }
            editable={width >= 800 && !fullscreen && !focused}
            panelRef={assignPanelRef}
            onLayoutChange={(layout) =>
              handleLayoutChange(layout, { ...layouts, [breakpoint]: layout })
            }
          />
        )}
      </div>
    </div>
  );
}
