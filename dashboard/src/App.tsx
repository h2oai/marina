import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Layout,
  type LayoutItem,
  ResponsiveGridLayout,
  type ResponsiveLayouts,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { AdminPanel } from "./components/AdminPanel";
import { AgentLaunchContent } from "./components/back-faces/AgentLaunchContent";
import { RoomNeighborhood } from "./components/back-faces/RoomNeighborhood";
import { SystemMetricsContent } from "./components/back-faces/SystemMetricsContent";
import { TaskPipeline } from "./components/back-faces/TaskPipeline";
import { ConversationInsights } from "./components/ConversationInsights";
import { CoordinationCard } from "./components/CoordinationCard";
import { EntityRoster } from "./components/EntityRoster";
import { Header } from "./components/Header";
import { NarrativePlayback } from "./components/NarrativePlayback";
import { RoomDetail } from "./components/RoomDetail";
import { WebChat } from "./components/WebChat";
import { WorldMap } from "./components/WorldMap";
import { useSystem, useWorld } from "./hooks/use-api";
import { useLayoutPresets } from "./hooks/use-layout-presets";
import { useGlobalRealtimeInvalidations } from "./hooks/use-realtime-invalidations";
import { useDashboardWebSocket } from "./hooks/use-websocket";

// Bump the version suffix whenever DEFAULT_LAYOUTS changes shape so existing
// users pick up the new default instead of a stale auto-persisted copy of the
// old one. (The Header's "Reset layout" button also restores the default.)
const LAYOUT_KEY = "marina-dashboard-layouts-v3";

type Bp = "lg" | "md";

// Webchat is the tall leftmost column; the other panels stack to its right in
// two sub-columns across three rows, matching webchat's height.
// WebChat (left) and Entities (right) are the two prominent, full-height
// columns — the primary way to observe and control Marina. The World Map (now
// with the activity timeline anchored inside it), Room, Coordination, and Admin
// stack in the middle. The Activity panel was retired (entities give richer,
// per-agent signal).
const DEFAULT_LAYOUTS: ResponsiveLayouts<Bp> = {
  lg: [
    { i: "webchat", x: 0, y: 0, w: 4, h: 10, minW: 3, minH: 4 },
    { i: "insights", x: 4, y: 0, w: 4, h: 3, minW: 3, minH: 2 },
    { i: "worldmap", x: 4, y: 3, w: 4, h: 3, minW: 2, minH: 2 },
    { i: "coordination", x: 4, y: 6, w: 4, h: 2, minW: 2, minH: 2 },
    { i: "admin", x: 4, y: 8, w: 4, h: 2, minW: 3, minH: 2 },
    { i: "entities", x: 8, y: 0, w: 4, h: 6, minW: 2, minH: 3 },
    { i: "playback", x: 8, y: 6, w: 4, h: 2, minW: 3, minH: 2 },
    { i: "room", x: 8, y: 8, w: 4, h: 2, minW: 2, minH: 2 },
  ],
  md: [
    { i: "webchat", x: 0, y: 0, w: 4, h: 10, minW: 3, minH: 4 },
    { i: "insights", x: 4, y: 0, w: 2, h: 3, minW: 2, minH: 2 },
    { i: "worldmap", x: 4, y: 3, w: 2, h: 3, minW: 2, minH: 2 },
    { i: "coordination", x: 4, y: 6, w: 2, h: 2, minW: 2, minH: 2 },
    { i: "admin", x: 4, y: 8, w: 2, h: 2, minW: 2, minH: 2 },
    { i: "entities", x: 6, y: 0, w: 4, h: 6, minW: 2, minH: 3 },
    { i: "playback", x: 6, y: 6, w: 4, h: 2, minW: 3, minH: 2 },
    { i: "room", x: 6, y: 8, w: 4, h: 2, minW: 2, minH: 2 },
  ],
};

/* ── Focused-layout BSP templates ─────────────────────────── */

interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FOCUS_SLOTS_LG: { focused: Slot; rest: Slot[] } = {
  focused: { x: 0, y: 0, w: 7, h: 6 },
  rest: [
    { x: 7, y: 0, w: 5, h: 3 },
    { x: 7, y: 3, w: 5, h: 3 },
    { x: 0, y: 6, w: 3, h: 3 },
    { x: 3, y: 6, w: 3, h: 3 },
    { x: 6, y: 6, w: 3, h: 3 },
    { x: 9, y: 6, w: 3, h: 3 },
  ],
};

const FOCUS_SLOTS_MD: { focused: Slot; rest: Slot[] } = {
  focused: { x: 0, y: 0, w: 10, h: 5 },
  rest: [
    { x: 0, y: 5, w: 5, h: 3 },
    { x: 5, y: 5, w: 5, h: 3 },
    { x: 0, y: 8, w: 5, h: 3 },
    { x: 5, y: 8, w: 5, h: 3 },
    { x: 0, y: 11, w: 5, h: 3 },
    { x: 5, y: 11, w: 5, h: 3 },
  ],
};

function computeFocusedLayout(
  focusedKey: string,
  currentLayouts: ResponsiveLayouts<Bp>,
): ResponsiveLayouts<Bp> {
  const result: ResponsiveLayouts<Bp> = { lg: [], md: [] };

  for (const bp of ["lg", "md"] as const) {
    const slots = bp === "lg" ? FOCUS_SLOTS_LG : FOCUS_SLOTS_MD;
    const current = currentLayouts[bp] ?? [];

    // Sort remaining panels by position (y, x) for stable slot assignment
    const remaining = current
      .filter((l) => l.i !== focusedKey)
      .sort((a, b) => a.y - b.y || a.x - b.x);

    const focusedItem = current.find((l) => l.i === focusedKey);
    const minW = focusedItem?.minW ?? 2;
    const minH = focusedItem?.minH ?? 2;

    const items: LayoutItem[] = [
      {
        i: focusedKey,
        ...slots.focused,
        minW,
        minH,
      },
    ];

    for (let idx = 0; idx < remaining.length; idx++) {
      const item = remaining[idx]!;
      const slot = slots.rest[idx]!;
      items.push({
        i: item.i,
        ...slot,
        minW: item.minW ?? 2,
        minH: item.minH ?? 2,
      });
    }

    result[bp] = items;
  }

  return result;
}

/* ── localStorage helpers ─────────────────────────────────── */

function loadLayouts(): ResponsiveLayouts<Bp> | undefined {
  try {
    const stored = localStorage.getItem(LAYOUT_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    // ignore corrupt data
  }
  return undefined;
}

/* ── App ──────────────────────────────────────────────────── */

export default function App() {
  const { connected } = useDashboardWebSocket();
  // Realtime core tenet: bootstrap queries invalidate on matching WS events.
  useGlobalRealtimeInvalidations();
  const { data: worldData } = useWorld();
  const { data: systemData } = useSystem();
  const { width, containerRef, mounted } = useContainerWidth();

  const uptime = systemData?.uptime ?? 0;

  const [layouts, setLayouts] = useState<ResponsiveLayouts<Bp>>(
    () => loadLayouts() ?? DEFAULT_LAYOUTS,
  );
  const {
    presets: layoutPresets,
    activeId: activePresetId,
    applyPreset,
    savePreset,
    renamePreset,
    deletePreset,
    updateActiveLayouts,
  } = useLayoutPresets(DEFAULT_LAYOUTS);
  const presetInitializedRef = useRef(false);

  const [focusedPanel, setFocusedPanel] = useState<string | null>(null);

  const savedLayoutsRef = useRef<ResponsiveLayouts<Bp> | null>(null);
  const focusedPanelRef = useRef<string | null>(null);

  useEffect(() => {
    if (presetInitializedRef.current) return;
    presetInitializedRef.current = true;
    const stored = loadLayouts();
    if (!stored) {
      const activePreset = layoutPresets.find((p) => p.id === activePresetId);
      if (activePreset) {
        setLayouts(activePreset.layouts);
      }
    }
  }, [layoutPresets, activePresetId]);

  const handlePanelFocus = useCallback(
    (key: string) => {
      if (focusedPanelRef.current === key) {
        // Unfocus — restore saved layouts
        if (savedLayoutsRef.current) {
          setLayouts(savedLayoutsRef.current);
        }
        savedLayoutsRef.current = null;
        focusedPanelRef.current = null;
        setFocusedPanel(null);
      } else {
        // Focus new panel — save current layouts (only on first focus)
        if (!focusedPanelRef.current) {
          savedLayoutsRef.current = layouts;
        }
        focusedPanelRef.current = key;
        setFocusedPanel(key);
        setLayouts(computeFocusedLayout(key, savedLayoutsRef.current ?? layouts));
      }
    },
    [layouts],
  );

  const handleUnfocus = useCallback(() => {
    if (focusedPanelRef.current) {
      if (savedLayoutsRef.current) {
        setLayouts(savedLayoutsRef.current);
      }
      savedLayoutsRef.current = null;
      focusedPanelRef.current = null;
      setFocusedPanel(null);
    }
  }, []);

  // Panel refs for keyboard focus
  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const PANEL_KEYS = useMemo(
    () => [
      "webchat",
      "insights",
      "worldmap",
      "coordination",
      "entities",
      "playback",
      "room",
      "admin",
    ],
    [],
  );
  const [_activePanelIdx, setActivePanelIdx] = useState<number | null>(null);

  const focusPanelByIndex = useCallback(
    (idx: number) => {
      const key = PANEL_KEYS[idx];
      if (!key) return;
      setActivePanelIdx(idx);
      // Focus the first focusable element within the panel
      const el = panelRefs.current[key];
      if (el) {
        const focusable = el.querySelector<HTMLElement>("[tabindex='0'], svg[tabindex]");
        if (focusable) focusable.focus();
        else el.focus();
      }
    },
    [PANEL_KEYS],
  );

  // Global key listener: number keys 1-7 + backtick
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't capture when typing in input/textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "Escape") {
        handleUnfocus();
        return;
      }

      // Number keys 1-7 for panel focus
      const num = Number.parseInt(e.key, 10);
      if (num >= 1 && num <= 7) {
        e.preventDefault();
        focusPanelByIndex(num - 1);
        return;
      }

      // Backtick to cycle panels
      if (e.key === "`") {
        e.preventDefault();
        setActivePanelIdx((prev) => {
          const next = prev === null ? 0 : (prev + 1) % PANEL_KEYS.length;
          // Schedule focus in next tick so state updates first
          requestAnimationFrame(() => focusPanelByIndex(next));
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleUnfocus, focusPanelByIndex, PANEL_KEYS]);

  const handleLayoutChange = useCallback(
    (_current: Layout, allLayouts: ResponsiveLayouts<Bp>) => {
      setLayouts(allLayouts);
      // Don't persist to localStorage while a panel is focused
      if (!focusedPanelRef.current) {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(allLayouts));
      }
      updateActiveLayouts(allLayouts);
    },
    [updateActiveLayouts],
  );

  const handleResetLayout = useCallback(() => {
    localStorage.removeItem(LAYOUT_KEY);
    savedLayoutsRef.current = null;
    focusedPanelRef.current = null;
    setFocusedPanel(null);
    const restored = applyPreset("default");
    setLayouts(restored ?? DEFAULT_LAYOUTS);
    if (restored) {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(restored));
    }
  }, [applyPreset]);

  const handleSelectPreset = useCallback(
    (id: string) => {
      const presetLayouts = applyPreset(id);
      if (presetLayouts) {
        savedLayoutsRef.current = null;
        focusedPanelRef.current = null;
        setFocusedPanel(null);
        setLayouts(presetLayouts);
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(presetLayouts));
      }
    },
    [applyPreset],
  );

  const handleSavePreset = useCallback(() => {
    const name = window.prompt("Name this workspace layout", "New workspace");
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const newId = savePreset(trimmed, layouts);
    const presetLayouts = applyPreset(newId);
    if (presetLayouts) {
      setLayouts(presetLayouts);
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(presetLayouts));
    }
  }, [savePreset, layouts, applyPreset]);

  const handleRenamePreset = useCallback(
    (id: string) => {
      const preset = layoutPresets.find((p) => p.id === id);
      if (!preset || preset.locked) return;
      const next = window.prompt("Rename workspace", preset.name);
      if (next === null) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === preset.name) return;
      renamePreset(id, trimmed);
    },
    [layoutPresets, renamePreset],
  );

  const handleDeletePreset = useCallback(
    (id: string) => {
      const preset = layoutPresets.find((p) => p.id === id);
      if (!preset || preset.locked) return;
      if (!window.confirm(`Delete workspace "${preset.name}"?`)) return;
      deletePreset(id);
    },
    [layoutPresets, deletePreset],
  );

  const onHeaderDblClick = useCallback(
    (key: string) => (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest(".drag-handle")) {
        handlePanelFocus(key);
      }
    },
    [handlePanelFocus],
  );

  const panelClass = (key: string) => (focusedPanel === key ? "panel-focused" : undefined);

  return (
    <div className="scanlines flex h-screen flex-col gap-1 p-1">
      <Header
        connected={connected}
        uptime={uptime}
        onResetLayout={handleResetLayout}
        layoutPresets={layoutPresets}
        activeLayoutId={activePresetId}
        onSelectLayoutPreset={handleSelectPreset}
        onSaveLayoutPreset={handleSavePreset}
        onRenameLayoutPreset={handleRenamePreset}
        onDeleteLayoutPreset={handleDeletePreset}
      />

      <div ref={containerRef} className="min-h-0 flex-1">
        {mounted && (
          <ResponsiveGridLayout
            width={width}
            layouts={layouts}
            breakpoints={{ lg: 1200, md: 0 }}
            cols={{ lg: 12, md: 10 }}
            rowHeight={80}
            margin={[4, 4]}
            dragConfig={{ enabled: true, handle: ".drag-handle" }}
            resizeConfig={{ enabled: true, handles: ["se"] }}
            compactor={verticalCompactor}
            onLayoutChange={handleLayoutChange}
          >
            {/* biome-ignore lint/a11y/noStaticElementInteractions: react-grid-layout panel container; double-click toggles focus, wraps nested interactive content */}
            <div
              key="webchat"
              ref={(el) => {
                panelRefs.current.webchat = el;
              }}
              onDoubleClick={onHeaderDblClick("webchat")}
              className={panelClass("webchat")}
            >
              <WebChat />
            </div>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: react-grid-layout panel container; double-click toggles focus, wraps nested interactive content */}
            <div
              key="insights"
              ref={(el) => {
                panelRefs.current.insights = el;
              }}
              onDoubleClick={onHeaderDblClick("insights")}
              className={panelClass("insights")}
            >
              <ConversationInsights />
            </div>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: react-grid-layout panel container; double-click toggles focus, wraps nested interactive content */}
            <div
              key="worldmap"
              ref={(el) => {
                panelRefs.current.worldmap = el;
              }}
              onDoubleClick={onHeaderDblClick("worldmap")}
              className={panelClass("worldmap")}
            >
              {/* The Unified Canvas no longer nests here — it didn't work well
                  embedded. It's now a standalone alternate interface, off by
                  default, enabled via MARINA_UNIFIED_CANVAS (see main.tsx). */}
              <WorldMap worldData={worldData} />
            </div>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: react-grid-layout panel container; double-click toggles focus, wraps nested interactive content */}
            <div
              key="coordination"
              ref={(el) => {
                panelRefs.current.coordination = el;
              }}
              onDoubleClick={onHeaderDblClick("coordination")}
              className={panelClass("coordination")}
            >
              <CoordinationCard backContent={<TaskPipeline />} />
            </div>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: react-grid-layout panel container; double-click toggles focus, wraps nested interactive content */}
            <div
              key="entities"
              ref={(el) => {
                panelRefs.current.entities = el;
              }}
              onDoubleClick={onHeaderDblClick("entities")}
              className={panelClass("entities")}
            >
              <EntityRoster backContent={<AgentLaunchContent />} />
            </div>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: react-grid-layout panel container; double-click toggles focus, wraps nested interactive content */}
            <div
              key="playback"
              ref={(el) => {
                panelRefs.current.playback = el;
              }}
              onDoubleClick={onHeaderDblClick("playback")}
              className={panelClass("playback")}
            >
              <NarrativePlayback />
            </div>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: react-grid-layout panel container; double-click toggles focus, wraps nested interactive content */}
            <div
              key="room"
              ref={(el) => {
                panelRefs.current.room = el;
              }}
              onDoubleClick={onHeaderDblClick("room")}
              className={panelClass("room")}
            >
              <RoomDetail backContent={<RoomNeighborhood />} />
            </div>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: react-grid-layout panel container; double-click toggles focus, wraps nested interactive content */}
            <div
              key="admin"
              ref={(el) => {
                panelRefs.current.admin = el;
              }}
              onDoubleClick={onHeaderDblClick("admin")}
              className={panelClass("admin")}
            >
              <AdminPanel backContent={<SystemMetricsContent uptime={uptime} />} />
            </div>
          </ResponsiveGridLayout>
        )}
      </div>
    </div>
  );
}
