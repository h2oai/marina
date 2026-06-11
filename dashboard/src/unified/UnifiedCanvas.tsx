/**
 * UnifiedCanvas -- Main component for the unified canvas-map view.
 *
 * Visual port of 06-tiled.html mockup page structure:
 * - body: VT323 font, dark bg (#030306), scanlines, pixel grid
 * - topbar: fixed top, logo (Orbitron gradient) + stat values (Orbitron) + buttons (Press Start 2P) + LIVE pulse
 * - main: flex fills remaining space, contains ReactFlow viewport
 * - command bar: fixed bottom, full width with left:4vw right:4vw
 * - floating panels: absolute positioned, draggable/resizable
 * - context panel: absolute right side, on click
 * - viewer overlay: full screen, on double-click
 *
 * Feature-flagged: only accessible via ?unified=true query parameter.
 */

import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./unified-canvas.css";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nodeTypes as canvasContentNodeTypes } from "../canvas/nodes";
import { useSetupStatus, useSystem } from "../hooks/use-api";
import { ensureChatWs, getChatWs, useChatState } from "../hooks/use-chat-state";
import { parseMessage, useEntityActivity } from "../hooks/use-entity-activity";
import { useGraphState } from "../hooks/use-graph-state";
import { useDashboardWebSocket } from "../hooks/use-websocket";
import { useWorldState } from "../hooks/use-world-state";
import { clearToken, setToken } from "../lib/api";
import { FlowEdge } from "./edges/FlowEdge";
import { GraphLinkEdge } from "./edges/GraphLinkEdge";
import { InteractionArc } from "./edges/InteractionArc";
import { RecallPath } from "./edges/RecallPath";
import { useActivity } from "./hooks/use-activity";
import {
  claimIntent,
  completeIntent,
  type DroppedFileResult,
  failIntent,
  useCanvasIntegration,
} from "./hooks/use-canvas-integration";
import { useInteractions } from "./hooks/use-interactions";
import { useZoom } from "./hooks/use-zoom";
import { getDistrictColor } from "./lib/crown-shapes";
import { computeNoteLayout, forceDirectedLayout } from "./lib/layout-utils";
import { buildRecallPathEdges, hasLiveRecallTrace } from "./lib/recall-paths";
import {
  hasLiveRoomMessage,
  latestRoomMessages,
  ROOM_MESSAGE_LIFETIME_MS,
} from "./lib/room-messages";
import { type SearchableWorldState, searchWorld } from "./lib/search";
import { cycleTheme, useTheme } from "./lib/theme-switcher";
import { GraphNoteNode, type GraphNoteNodeData } from "./nodes/GraphNoteNode";
import { RoomNode, type RoomNodeData } from "./nodes/RoomNode";
import { DropDialog } from "./overlays/DropDialog";
import { EdgeContextMenu, type EdgeContextMenuTarget } from "./overlays/EdgeContextMenu";
import { TimelineStrip } from "./overlays/TimelineStrip";
import { Viewer, type ViewerContentType } from "./overlays/Viewer";
import { clearSeenTour, WelcomeTour } from "./overlays/WelcomeTour";
import { WorldRing } from "./overlays/WorldRing";
import { CommandBar, type CommandBarHandle } from "./panels/CommandBar";
import { ContextPanel, type ContextType } from "./panels/ContextPanel";
import { EntityPanel } from "./panels/EntityPanel";
import { WorldNav } from "./panels/WorldNav";

/**
 * Canvas content node types — every per-type renderer the standalone canvas
 * registers (text / image / video / pdf / audio / document / frame / a2ui /
 * embed) is also rendered in the unified surface, so node content is the same
 * across both views. The unified surface adds its own `room` and `graphNote`
 * overlays for the world-map and knowledge-graph layers.
 */
const CANVAS_CONTENT_TYPES: ReadonlySet<string> = new Set(Object.keys(canvasContentNodeTypes));

/** True when this ReactFlow node hosts canvas content (vs. a room/graphNote overlay). */
function isCanvasContentNode(type: string | undefined): boolean {
  return type !== undefined && CANVAS_CONTENT_TYPES.has(type);
}

/** Shape of `data` on canvas content nodes after useCanvasIntegration has populated it. */
interface CanvasNodeMeta {
  title?: string;
  intent?: {
    status: "pending" | "active" | "done" | "failed";
    prompt?: string;
    claimedBy?: string;
    result?: string;
    failReason?: string;
  };
  canvasId?: string;
  url?: string;
  [k: string]: unknown;
}

/** Custom node types registered with ReactFlow. */
const nodeTypes: NodeTypes = {
  ...canvasContentNodeTypes,
  room: RoomNode,
  graphNote: GraphNoteNode,
};

/** Custom edge types registered with ReactFlow. */
const edgeTypes: EdgeTypes = {
  flow: FlowEdge,
  interaction: InteractionArc,
  graphLink: GraphLinkEdge,
  recallPath: RecallPath,
};

/**
 * Load a boolean layer-visibility preference from localStorage.
 * If the key has never been set (first visit), returns `firstVisitDefault`.
 */
function loadLayerPref(key: string, firstVisitDefault: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return firstVisitDefault;
    return raw === "true";
  } catch {
    return firstVisitDefault;
  }
}

function saveLayerPref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore — private mode, etc.
  }
}

/** Format seconds into short uptime display. */
function formatUptimeShort(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

/** Inner component that uses ReactFlow hooks (must be inside ReactFlowProvider). */
interface UnifiedCanvasProps {
  /**
   * When true, size to the parent container (100%) instead of the viewport
   * (100vw/100vh). Use this when mounting inside a dashboard panel; omit
   * for the fullscreen /?unified route.
   */
  embedded?: boolean;
}

function UnifiedCanvasInner({ embedded }: UnifiedCanvasProps) {
  const { connected } = useDashboardWebSocket();
  const { fitView, screenToFlowPosition, zoomIn, zoomOut, setViewport } = useReactFlow();

  // World state from Zustand store (fed by WebSocket)
  const rooms = useWorldState((s) => s.rooms);
  const entities = useWorldState((s) => s.entities);
  const thinkingAgents = useWorldState((s) => s.thinkingAgents);
  const activityStreaming = useEntityActivity((s) => s.streaming);
  const instanceName = useWorldState((s) => s.instanceName);
  const worldName = useWorldState((s) => s.worldName);
  const eventFeed = useWorldState((s) => s.eventFeed);
  const wsConnections = useWorldState((s) => s.connections);
  const gridPositions = useWorldState((s) => s.gridPositions);

  // System data (uptime, etc.) + setup status (pre-auth)
  const { data: systemData } = useSystem();
  const { data: setupStatus } = useSetupStatus();
  const agentCount = useMemo(() => entities.filter((e) => e.kind === "agent").length, [entities]);

  // Activity tracking
  const logActivity = useActivity((s) => s.logActivity);
  const trimActivity = useActivity((s) => s.trimActivity);

  // Interaction arcs
  const addInteraction = useInteractions((s) => s.addInteraction);
  const getActiveInteractions = useInteractions((s) => s.getActiveInteractions);
  const trimExpired = useInteractions((s) => s.trimExpired);

  // Viewport zoom -> Zustand store for LOD in custom nodes
  const { zoom: vpZoom } = useViewport();
  const setZoom = useZoom((s) => s.setZoom);
  useEffect(() => {
    setZoom(vpZoom);
  }, [vpZoom, setZoom]);

  // Theme state
  const themeName = useTheme((s) => {
    const t = s.themeId;
    return t.charAt(0).toUpperCase() + t.slice(1);
  });

  // Drag-drop state
  const [dropping, setDropping] = useState(false);
  // Queue of files awaiting an intent prompt; opens DropDialog when non-empty.
  // Each successful drop appends to this; the dialog walks them one at a time
  // and closes itself when the queue is exhausted.
  const [dropQueue, setDropQueue] = useState<DroppedFileResult[]>([]);

  // ── Canvas selector state ───────────────────────────────────────────────
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);

  // ── Panel visibility state ──────────────────────────────────────────────
  const [showEntities, setShowEntities] = useState(true);
  const [entitiesExpanded, setEntitiesExpanded] = useState(false);
  const [worldNavExpanded, setWorldNavExpanded] = useState(false);
  // Feed merged into CommandBar "Events" tab — no separate panel
  const [_showAdmin, setShowAdmin] = useState(false);
  const [showCommandBar, setShowCommandBar] = useState(true);
  const [clearView, setClearView] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // ── District filters — toggle visibility of room groups ────────────────
  const [hiddenDistricts, setHiddenDistricts] = useState<Set<string>>(new Set());
  // Default: all layers visible — an Marina can be a restart, an import, or
  // a cloned world, so a first-time visitor should see the world humming, not
  // a quiet world that happens to have rich state hidden behind toggles.
  const [hideCanvasNodes, setHideCanvasNodes] = useState<boolean>(() =>
    loadLayerPref("uc:hide-canvas", false),
  );
  const [hideEmptyRooms, setHideEmptyRooms] = useState(false);
  useEffect(() => saveLayerPref("uc:hide-canvas", hideCanvasNodes), [hideCanvasNodes]);
  // ── Layer visibility (World · Canvas · Graph · Feed) ───────────────────
  // Persisted in localStorage. Default every layer to visible — Marina
  // instances can be restarts, imports, or clones with rich state already
  // present; a first-time visitor should see the world humming rather than
  // a quiet shell hiding it behind opt-in toggles.
  const [hideWorld, setHideWorld] = useState<boolean>(() => loadLayerPref("uc:hide-world", false));
  const [hideGraph, setHideGraph] = useState<boolean>(() => loadLayerPref("uc:hide-graph", false));
  const [hideFeed, setHideFeed] = useState<boolean>(() => loadLayerPref("uc:hide-feed", false));
  useEffect(() => saveLayerPref("uc:hide-world", hideWorld), [hideWorld]);
  useEffect(() => saveLayerPref("uc:hide-graph", hideGraph), [hideGraph]);
  useEffect(() => saveLayerPref("uc:hide-feed", hideFeed), [hideFeed]);

  // ── Edge context menu (right-click on an edge) ──────────────────────────
  const [edgeMenu, setEdgeMenu] = useState<EdgeContextMenuTarget | null>(null);

  // ── Tour replay: incrementing a key remounts the WelcomeTour so dismissed
  //    users can re-trigger it from the LEGEND tab of WorldNav. ───────────────────
  const [tourKey, setTourKey] = useState(0);

  const toggleDistrict = useCallback((d: string) => {
    setHiddenDistricts((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  }, []);
  const commandBarRef = useRef<CommandBarHandle>(null);
  const displayNodesRef = useRef<Node[]>([]);
  const fitWorldRef = useRef<(duration?: number) => void>(() => {});

  // Context panel state
  const [contextType, setContextType] = useState<ContextType | null>(null);
  const [contextId, setContextId] = useState<string | null>(null);
  const [contextAnchor, setContextAnchor] = useState<{ x: number; y: number } | null>(null);

  // Viewer state
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerTitle, setViewerTitle] = useState("");
  const [viewerContentType, setViewerContentType] = useState<ViewerContentType>("unknown");
  const [viewerContent, setViewerContent] = useState<string | undefined>();

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
    nodeType: string;
  } | null>(null);
  const [noteInput, setNoteInput] = useState<{ nodeId: string; nodeType: string } | null>(null);
  const [noteText, setNoteText] = useState("");
  const noteInputRef = useRef<HTMLInputElement>(null);
  // Intent action input state — reuses noteText for the input value
  const [intentActionInput, setIntentActionInput] = useState<{
    nodeId: string;
    action: "complete" | "fail";
  } | null>(null);
  const intentInputRef = useRef<HTMLInputElement>(null);

  // Current user identity for intent claiming
  const currentEntityName = useChatState((s) => s.entityName);

  // ── Panel handlers ──────────────────────────────────────────────────────
  const openContext = useCallback(
    (type: ContextType, id: string) => {
      // Always open for the clicked object — no toggle (use Escape/X to close)
      setContextType(type);
      setContextId(id);
      if (type === "room") {
        const room = rooms.find((r) => r.id === id);
        const neighborIds = room ? Object.values(room.exits) : [];
        const targetNodes = [{ id }, ...neighborIds.map((nid) => ({ id: nid }))];
        fitView({ nodes: targetNodes, padding: 0.4, duration: 400, maxZoom: 1.2 });
      } else if (type === "entity") {
        const ent = entities.find((e) => e.name === id);
        if (ent) {
          const room = rooms.find((r) => r.id === ent.room);
          const neighborIds = room ? Object.values(room.exits) : [];
          const targetNodes = [{ id: ent.room }, ...neighborIds.map((nid) => ({ id: nid }))];
          fitView({ nodes: targetNodes, padding: 0.4, duration: 400, maxZoom: 1.2 });
        }
      }
    },
    [fitView, rooms, entities],
  );

  const closeContext = useCallback(() => {
    setContextType(null);
    setContextId(null);
    setContextAnchor(null);
    fitWorldRef.current(400);
  }, []);

  const handleEntityClick = useCallback(
    (name: string, screenX?: number, screenY?: number) => {
      if (screenX != null && screenY != null) {
        setContextAnchor({ x: screenX, y: screenY });
      }
      openContext("entity", name);
    },
    [openContext],
  );

  const handleNoteClick = useCallback((noteId: number, screenX?: number, screenY?: number) => {
    if (screenX != null && screenY != null) {
      setContextAnchor({ x: screenX, y: screenY });
    }
    setContextType("note");
    setContextId(String(noteId));
  }, []);

  const handleRoomClick = useCallback(
    (roomId: string) => {
      openContext("room", roomId);
    },
    [openContext],
  );

  const handleRoomAction = useCallback(
    (roomId: string, screenX: number, screenY: number) => {
      setContextAnchor({ x: screenX, y: screenY });
      openContext("room", roomId);
    },
    [openContext],
  );

  const toggleClearView = useCallback(() => {
    setClearView((v) => !v);
  }, []);

  const toggleCommandBar = useCallback(() => {
    setShowCommandBar((prev) => {
      if (!prev) {
        setTimeout(() => {
          commandBarRef.current?.expand();
          commandBarRef.current?.focus();
        }, 50);
      } else {
        commandBarRef.current?.collapse();
      }
      return !prev;
    });
  }, []);

  // ── Node click -> open context panel ────────────────────────────────────
  const onNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      setContextAnchor({ x: event.clientX, y: event.clientY });
      if (node.type === "room") {
        openContext("room", node.id);
      } else if (isCanvasContentNode(node.type)) {
        openContext("canvas", node.id);
      }
    },
    [openContext],
  );

  // ── Double-click node -> open Viewer overlay or detail ──────────────────
  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (isCanvasContentNode(node.type)) {
        const data = node.data as CanvasNodeMeta;
        const nodeType = node.type as string;
        setViewerTitle(data.title ?? nodeType);
        const intentMode = !!data.intent;
        // Intent overlays use a dedicated viewer; everything else routes by node type.
        const contentType = (
          intentMode
            ? "intent"
            : ["image", "video", "audio", "pdf", "document", "a2ui"].includes(nodeType)
              ? nodeType
              : "unknown"
        ) as ViewerContentType;
        setViewerContentType(contentType);
        if (intentMode && data.intent) {
          const rawNodeId = node.id.replace("canvas-", "");
          setViewerContent(
            JSON.stringify({
              ...data.intent,
              canvasId: data.canvasId,
              nodeId: rawNodeId,
            }),
          );
        } else {
          setViewerContent(data.url ?? undefined);
        }
        setViewerOpen(true);
      } else if (node.type === "room") {
        // Double-click room opens detail context (source, items, exits)
        openContext("room", node.id);
      }
    },
    [openContext],
  );

  const onPaneClick = useCallback(() => {
    // Click empty space closes context panel
    if (contextType) closeContext();
  }, [contextType, closeContext]);

  const onPaneDoubleClick = useCallback(() => {
    fitWorldRef.current(400);
  }, []);

  // ── Right-click context menu on nodes ──────────────────────────────────
  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      nodeId: node.id,
      nodeType: node.type ?? "room",
    });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setNoteInput(null);
    setNoteText("");
    setIntentActionInput(null);
  }, []);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      // Don't close if clicking inside the context menu itself
      const menuEl = document.querySelector(".uc-node-context-menu");
      if (menuEl?.contains(e.target as HTMLElement)) return;
      setContextMenu(null);
      setNoteInput(null);
      setNoteText("");
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [contextMenu]);

  // ── Panel layout reset ──────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    setShowEntities(true);
    setShowAdmin(false);
    setShowCommandBar(true);
    setClearView(false);
    closeContext();
    setViewerOpen(false);
    setContextMenu(null);
    fitWorldRef.current(400);
  }, [closeContext]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: handler captures the latest state via closures over refs/setters; deps cover only the gating flags
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName ?? "";
      const inInput = tag === "INPUT" || tag === "TEXTAREA";
      // Check if focus is inside a panel (command bar, entity panel, context panel)
      const inPanel = !!el?.closest(
        ".uc-command-bar, .uc-entity-sidebar, .uc-context-panel, .uc-node-context-menu",
      );

      // Escape always works — cascades through layers, ultimately returns home
      if (e.key === "Escape") {
        // 1. Close context menu
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        // 2. Close viewer
        if (viewerOpen) {
          setViewerOpen(false);
          return;
        }
        // 3. Close help
        if (showHelp) {
          setShowHelp(false);
          return;
        }
        // 4. Blur input (defers to global shortcuts)
        if (inInput) {
          (el as HTMLElement)?.blur();
          return;
        }
        // 5. Close context panel
        if (contextType) {
          closeContext();
          return;
        }
        // 6. Clear view off
        if (clearView) {
          setClearView(false);
          return;
        }
        // 7. Return to home view
        fitWorldRef.current(400);
        return;
      }

      // When focused inside a panel or input, all other keys belong to that panel
      if (inInput || inPanel) {
        // Only "/" toggles command bar from anywhere (unless typing in an input)
        if (e.key === "/" && !inInput) {
          e.preventDefault();
          setShowCommandBar((prev) => {
            if (!prev) {
              setTimeout(() => {
                commandBarRef.current?.expand();
                commandBarRef.current?.focus();
              }, 50);
            } else {
              commandBarRef.current?.collapse();
            }
            return !prev;
          });
        }
        return;
      }

      // ── Global shortcuts (only when no panel has focus) ──

      // Number keys 1-4 toggle layer visibility (shift → solo)
      if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        const idx = Number(e.key);
        // idx 1=World, 2=Canvas, 3=Graph, 4=Feed
        if (e.shiftKey) {
          setHideWorld(idx !== 1);
          setHideCanvasNodes(idx !== 2);
          setHideGraph(idx !== 3);
          setHideFeed(idx !== 4);
        } else {
          if (idx === 1) setHideWorld((v) => !v);
          else if (idx === 2) setHideCanvasNodes((v) => !v);
          else if (idx === 3) setHideGraph((v) => !v);
          else if (idx === 4) setHideFeed((v) => !v);
        }
        return;
      }

      if (e.key === "/") {
        e.preventDefault();
        setShowCommandBar((prev) => {
          if (!prev) {
            setTimeout(() => commandBarRef.current?.focus(), 50);
          }
          return !prev;
        });
        return;
      }

      if (e.key === "?") {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }

      if (e.key === " ") {
        e.preventDefault();
        toggleClearView();
        return;
      }

      // Arrow keys: navigate to nearest node in that direction
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const nodes = displayNodesRef.current;
        if (nodes.length === 0) return;

        // Find current node (context target) or pick the center-most node
        const currentId = contextId;
        const currentNode = currentId ? nodes.find((n) => n.id === currentId) : null;
        const cx = currentNode?.position.x ?? 0;
        const cy = currentNode?.position.y ?? 0;

        // Direction vector
        const dirX = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        const dirY = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;

        // Find the nearest node in the pressed direction
        let bestId: string | null = null;
        let bestScore = Number.POSITIVE_INFINITY;

        for (const node of nodes) {
          if (node.id === currentId) continue;
          const dx = node.position.x - cx;
          const dy = node.position.y - cy;
          // Dot product with direction — must be positive (in the right direction)
          const dot = dx * dirX + dy * dirY;
          if (dot <= 10) continue; // must be meaningfully in that direction

          // Score: distance, penalized by angular deviation from the direction
          const dist = Math.sqrt(dx * dx + dy * dy);
          const alignment = dot / dist; // 1.0 = perfectly aligned, 0 = perpendicular
          const score = dist / (alignment * alignment + 0.01);

          if (score < bestScore) {
            bestScore = score;
            bestId = node.id;
          }
        }

        if (bestId) {
          const targetNode = nodes.find((n) => n.id === bestId);
          if (targetNode) {
            const type = isCanvasContentNode(targetNode.type) ? "canvas" : "room";
            openContext(type as ContextType, bestId);
          }
        }
        return;
      }

      // Tab to cycle between panels
      if (e.key === "Tab" && !inInput) {
        e.preventDefault();
        // Cycle: entities -> feed -> command bar -> entities
        if (showEntities && !showCommandBar) {
          setShowCommandBar(true);
          setTimeout(() => commandBarRef.current?.focus(), 50);
        } else {
          setShowEntities((v) => !v);
        }
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    toggleClearView,
    closeContext,
    openContext,
    contextType,
    contextId,
    viewerOpen,
    contextMenu,
    showHelp,
    clearView,
    showEntities,
    showCommandBar,
    fitView,
  ]);

  // Feed events into activity store and detect interaction arcs
  const lastProcessedRef = useRef(0);
  useEffect(() => {
    if (eventFeed.length === 0) return;
    const newEvents = eventFeed.filter((e) => e.timestamp > lastProcessedRef.current);
    for (const event of newEvents) {
      if (event.entity && event.room) {
        logActivity(event.entity, event.room, event.type);
      }

      // Dashboard events drive visual activity (arcs, metrics) but NOT the
      // command shell — the shell only shows the user's own commands and
      // server responses via the game WebSocket perception handler.

      // ── Create visual interaction arcs for all event types ────────
      if (event.entity && event.room) {
        if (event.type === "say") {
          // Say reaches everyone in the same room. The arc carries the
          // actual utterance so the map shows what was said, not just
          // that something was said.
          const { body } = parseMessage("say", event.input);
          const roomEntities = entities.filter(
            (e) => e.room === event.room && e.name !== event.entity,
          );
          for (const target of roomEntities.slice(0, 3)) {
            addInteraction(event.entity, target.name, "say", undefined, undefined, { body });
          }
        } else if (event.type === "tell" && event.input) {
          const { body, recipient } = parseMessage("tell", event.input);
          if (recipient) {
            addInteraction(event.entity, recipient, "tell", undefined, undefined, {
              body,
              recipient,
            });
          }
        } else if (event.type === "shout") {
          const { body } = parseMessage("shout", event.input);
          const nearbyEntities = entities.filter(
            (e) => e.name !== event.entity && e.room !== event.room,
          );
          for (const target of nearbyEntities.slice(0, 4)) {
            addInteraction(event.entity, target.name, "shout", undefined, undefined, { body });
          }
        } else if (event.type === "emote") {
          const { body } = parseMessage("emote", event.input);
          const roomEntities = entities.filter(
            (e) => e.room === event.room && e.name !== event.entity,
          );
          for (const target of roomEntities.slice(0, 2)) {
            addInteraction(event.entity, target.name, "emote", undefined, undefined, { body });
          }
        } else if (event.type === "broadcast") {
          const { body } = parseMessage("broadcast", event.input);
          const others = entities.filter((e) => e.name !== event.entity);
          for (const target of others.slice(0, 5)) {
            addInteraction(event.entity, target.name, "broadcast", undefined, undefined, { body });
          }
        } else if (event.type === "connect" && event.entity) {
          // Connect: show arc from entity to their room. Transport-level
          // connects carry no entity (and are dropped server-side); only
          // render an interaction when one is actually present.
          addInteraction(event.entity, event.entity, "connect", undefined, event.room);
        } else if (event.type === "disconnect" && event.entity) {
          addInteraction(event.entity, event.entity, "disconnect", event.room, undefined);
        } else if (
          event.type === "command" &&
          event.input &&
          !event.input.startsWith("look") &&
          !event.input.startsWith("brief")
        ) {
          // Non-trivial commands — show the entity doing something
          const roomEntities = entities.filter(
            (e) => e.room === event.room && e.name !== event.entity,
          );
          if (roomEntities.length > 0) {
            addInteraction(event.entity, roomEntities[0]!.name, "command");
          }
        }
      }
    }
    if (newEvents.length > 0) {
      lastProcessedRef.current = newEvents[0]!.timestamp;
    }
  }, [eventFeed, logActivity, addInteraction, entities]);

  // Periodic activity and interaction trimming
  useEffect(() => {
    const interval = setInterval(() => {
      trimActivity();
      trimExpired();
    }, 5000);
    return () => clearInterval(interval);
  }, [trimActivity, trimExpired]);

  // Ambient heartbeat
  const lastHeartbeat = useActivity((s) => s.lastHeartbeat);
  const setLastHeartbeat = useActivity((s) => s.setLastHeartbeat);
  const mostActiveRoomFn = useActivity((s) => s.mostActiveRoom);
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      if (now - lastHeartbeat < 7000) return;
      const target = mostActiveRoomFn();
      if (target) {
        logActivity("_heartbeat", target, "heartbeat");
      }
      setLastHeartbeat(now);
    }, 7000);
    return () => clearInterval(interval);
  }, [lastHeartbeat, setLastHeartbeat, mostActiveRoomFn, logActivity]);

  // Build entity lookup by room.
  //
  // State is derived live: if the agent has an open turn (thinkingAgents)
  // we classify as "speaking" when text is streaming, "thinking" otherwise.
  // Fall back to the snapshot's agentStatus.state only when there's no
  // live signal. This is the fix for the stale-rings bug (previously the
  // orbiting sprites inside RoomNode read the polled field and lied about
  // what the agent was actually doing).
  const entitiesByRoom = useMemo(() => {
    const map: Record<string, { name: string; kind: string; state: string }[]> = {};
    for (const entity of entities) {
      const roomId = entity.room;
      if (!map[roomId]) map[roomId] = [];
      const isThinking = entity.name in thinkingAgents;
      const streaming = activityStreaming[entity.name];
      const liveState = isThinking
        ? streaming && streaming.text.length > 0
          ? "speaking"
          : "thinking"
        : (entity.agentStatus?.state ?? "online");
      map[roomId].push({
        name: entity.name,
        kind: entity.kind,
        state: liveState,
      });
    }
    return map;
  }, [entities, thinkingAgents, activityStreaming]);

  const entityRooms = useMemo(() => {
    const map: Record<string, string> = {};
    for (const entity of entities) {
      map[entity.name] = entity.room;
    }
    return map;
  }, [entities]);

  // Track entity movement — detect when entities change rooms and create movement arcs
  const prevEntityRoomsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const prev = prevEntityRoomsRef.current;
    for (const [name, newRoom] of Object.entries(entityRooms)) {
      const oldRoom = prev[name];
      if (oldRoom && oldRoom !== newRoom) {
        // Entity moved — create a movement arc from old room to new room
        addInteraction(name, name, "move", oldRoom, newRoom);
      }
    }
    prevEntityRoomsRef.current = { ...entityRooms };
  }, [entityRooms, addInteraction]);

  const roomIds = useMemo(() => rooms.map((r) => r.id), [rooms]);

  // Active districts — unique district prefixes from current rooms
  const activeDistricts = useMemo(() => {
    const set = new Set<string>();
    for (const room of rooms) {
      set.add(room.district);
    }
    // Sort so the primary "world" district comes first
    return [...set].sort((a, b) => {
      if (a === "world") return -1;
      if (b === "world") return 1;
      return a.localeCompare(b);
    });
  }, [rooms]);

  // Grid-aware layout based on room coordinates and exits (spatially correct)
  const roomPositions = useMemo(() => {
    const layoutRooms = rooms.map((r) => ({
      id: r.id,
      exits: r.exits,
      throughput: (entitiesByRoom[r.id]?.length ?? 0) * 10,
    }));
    return forceDirectedLayout(layoutRooms, 80, "world", gridPositions);
  }, [rooms, entitiesByRoom, gridPositions]);

  // Canvas integration
  const {
    canvasNodes,
    canvasEdges,
    canvasList,
    activeCanvasId,
    wsStatus: canvasWsStatus,
    onDrop: canvasDrop,
    removeNode: removeCanvasNode,
  } = useCanvasIntegration(roomPositions, roomIds, entityRooms, selectedCanvasId);

  // ── Per-room latest in-room message (say / emote) ─────────────────────
  // Content-over-motion on the map: the pedestal gets a small glass pill
  // above it showing what was just said inside the room, not just that
  // something happened. Freshness ticks so bubbles fade naturally.
  const [roomMsgTick, setRoomMsgTick] = useState(0);
  const resolveEntityName = useCallback(
    (id: string) => entities.find((e) => e.id === id)?.name ?? id,
    [entities],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: roomMsgTick drives fade
  const latestRoomMsgs = useMemo(
    () => latestRoomMessages(eventFeed, resolveEntityName, Date.now()),
    [eventFeed, resolveEntityName, roomMsgTick],
  );
  const anyLiveRoomMsg = useMemo(
    () => hasLiveRoomMessage(latestRoomMsgs, Date.now()),
    [latestRoomMsgs],
  );
  useEffect(() => {
    if (!anyLiveRoomMsg) return;
    const interval = setInterval(() => setRoomMsgTick((n) => n + 1), 300);
    return () => clearInterval(interval);
  }, [anyLiveRoomMsg]);

  // Convert world rooms to ReactFlow nodes
  const roomNodes = useMemo(() => {
    return rooms.map((room) => {
      const pos = roomPositions[room.id] ?? { x: 0, y: 0 };
      const roomEntities = entitiesByRoom[room.id] ?? [];
      // Minimum throughput 20 so even empty rooms are visible and colorful
      const throughput = Math.max(20, roomEntities.length * 15);

      const msg = latestRoomMsgs[room.id];
      const msgFresh = msg && Date.now() - msg.timestamp < ROOM_MESSAGE_LIFETIME_MS;

      const nodeData: RoomNodeData = {
        id: room.id,
        short: room.short,
        district: room.district,
        exits: room.exits,
        throughput,
        entities: roomEntities,
        onEntityClick: handleEntityClick,
        onRoomAction: handleRoomAction,
        latestMessage: msgFresh ? msg : undefined,
      };

      return {
        id: room.id,
        type: "room",
        position: pos,
        data: nodeData,
        draggable: true,
      };
    });
  }, [rooms, roomPositions, entitiesByRoom, handleEntityClick, handleRoomAction, latestRoomMsgs]);

  // ── Knowledge graph layer ──────────────────────────────────────────────
  const graphNotes = useGraphState((s) => s.notes);
  const graphLinks = useGraphState((s) => s.links);
  const recentTraces = useGraphState((s) => s.recentTraces);

  // Stable layout: reuse prior positions, compute new ones via force-lite
  const notePositionsRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const noteLayout = useMemo(() => {
    if (graphNotes.size === 0) return new Map<number, { x: number; y: number }>();
    const notesArr = [...graphNotes.values()];
    const linksArr = [...graphLinks.values()];
    // Center the graph cloud below the world map grid
    const layout = computeNoteLayout(notesArr, linksArr, {
      center: { x: 0, y: 3200 },
      baseRadius: 400,
      existing: notePositionsRef.current,
    });
    notePositionsRef.current = layout;
    return layout;
  }, [graphNotes, graphLinks]);

  // Most recent trace's activated ids — used to flash nodes/edges
  const activatedIds = useMemo(() => {
    const latest = recentTraces[0];
    if (!latest || Date.now() - latest.timestamp > 2000) return new Set<number>();
    return new Set(latest.activatedNoteIds);
  }, [recentTraces]);

  const graphNoteNodes = useMemo<Node[]>(() => {
    if (hideGraph) return [];
    const result: Node[] = [];
    for (const note of graphNotes.values()) {
      const pos = noteLayout.get(note.id);
      if (!pos) continue;
      const data: GraphNoteNodeData = {
        id: note.id,
        entityName: note.entityName,
        content: note.content,
        importance: note.importance,
        noteType: note.noteType,
        createdAt: note.createdAt,
        lastAccessed: note.lastAccessed,
        activated: activatedIds.has(note.id),
        onClick: handleNoteClick,
      };
      result.push({
        id: `note-${note.id}`,
        type: "graphNote",
        position: pos,
        data: data as unknown as Record<string, unknown>,
        draggable: true,
      });
    }
    return result;
  }, [graphNotes, noteLayout, activatedIds, hideGraph, handleNoteClick]);

  const graphLinkEdges = useMemo<Edge[]>(() => {
    if (hideGraph) return [];
    const result: Edge[] = [];
    for (const link of graphLinks.values()) {
      // Skip self-loops — they render as messy arcs with bezier
      if (link.sourceId === link.targetId) continue;
      // Only render if both endpoints have positions
      if (!noteLayout.has(link.sourceId) || !noteLayout.has(link.targetId)) continue;
      const activated = activatedIds.has(link.sourceId) && activatedIds.has(link.targetId);
      result.push({
        id: `notelink-${link.sourceId}-${link.targetId}-${link.relationship}`,
        source: `note-${link.sourceId}`,
        target: `note-${link.targetId}`,
        type: "graphLink",
        data: { relationship: link.relationship, activated },
      });
    }
    return result;
  }, [graphLinks, noteLayout, activatedIds, hideGraph]);

  // Computed source nodes (for search, world ring, etc.)
  const allNodes = useMemo<Node[]>(
    () => [...roomNodes, ...canvasNodes, ...graphNoteNodes],
    [roomNodes, canvasNodes, graphNoteNodes],
  );

  // Display nodes: stateful copy that tracks drag position changes
  const [displayNodes, setDisplayNodes] = useState<Node[]>([]);
  // Keep ref in sync for keyboard handler (which can't depend on state directly)
  useEffect(() => {
    displayNodesRef.current = displayNodes;
  }, [displayNodes]);

  // Update display nodes — apply filters and preserve drag positions
  useEffect(() => {
    // Layer toggle: hide all rooms if the World layer is off
    let filtered: Node[] = hideWorld ? [] : [...roomNodes];
    // Filter by district
    if (hiddenDistricts.size > 0) {
      filtered = filtered.filter((n) => {
        const d = (n.data as Record<string, unknown>)?.district as string | undefined;
        return !d || !hiddenDistricts.has(d);
      });
    }
    // Filter empty rooms
    if (hideEmptyRooms) {
      filtered = filtered.filter((n) => {
        const ents = (n.data as Record<string, unknown>)?.entities as unknown[] | undefined;
        return ents && ents.length > 0;
      });
    }
    // Add canvas nodes (unless hidden) + knowledge-graph note nodes
    const withCanvas = hideCanvasNodes ? filtered : [...filtered, ...canvasNodes];
    const merged = [...withCanvas, ...graphNoteNodes];
    setDisplayNodes((prev) => {
      // Preserve positions of nodes that were manually dragged
      const prevPositions = new Map(prev.map((n) => [n.id, n.position]));
      return merged.map((n) => {
        const draggedPos = prevPositions.get(n.id);
        // Keep dragged position if it differs from layout position
        if (draggedPos && (draggedPos.x !== n.position.x || draggedPos.y !== n.position.y)) {
          return { ...n, position: draggedPos };
        }
        return n;
      });
    });
  }, [
    roomNodes,
    canvasNodes,
    graphNoteNodes,
    hiddenDistricts,
    hideCanvasNodes,
    hideEmptyRooms,
    hideWorld,
  ]);

  // Handle node drag — ReactFlow calls this with position changes
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setDisplayNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  // Convert room exits to ReactFlow edges with cardinal-aware handle routing
  const flowEdges = useMemo<Edge[]>(() => {
    // Map cardinal directions to ReactFlow handles
    const dirToHandle: Record<string, string> = {
      north: "top",
      south: "bottom",
      east: "right",
      west: "left",
    };
    // Reverse direction: if I go north to reach you, you're connected from the south
    const reverseDir: Record<string, string> = {
      north: "bottom",
      south: "top",
      east: "left",
      west: "right",
    };

    const edgeList: Edge[] = [];
    const seen = new Set<string>();

    for (const room of rooms) {
      for (const [direction, targetId] of Object.entries(room.exits)) {
        const edgeKey = [room.id, targetId].sort().join("--");
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);

        const targetRoom = rooms.find((r) => r.id === targetId);
        if (!targetRoom) continue;

        const sourceEntities = entitiesByRoom[room.id] ?? [];
        const targetEntities = entitiesByRoom[targetId] ?? [];
        const throughput = Math.max(
          15,
          Math.min(sourceEntities.length * 15, targetEntities.length * 15) || 15,
        );

        // Determine cross-district (enter/leave exits connect different districts)
        const srcDistrict = room.id.split("/")[0] ?? "";
        const tgtDistrict = targetId.split("/")[0] ?? "";
        const crossDistrict = srcDistrict !== tgtDistrict;

        // Cardinal handle routing: use direction-aware handles for grid rooms
        const sourceHandle = dirToHandle[direction]; // e.g. north → top
        const targetHandle = reverseDir[direction]; // e.g. north → bottom (arriving from south)

        edgeList.push({
          id: `flow-${edgeKey}`,
          source: room.id,
          target: targetId,
          type: "flow",
          ...(sourceHandle ? { sourceHandle } : {}),
          ...(targetHandle ? { targetHandle } : {}),
          data: {
            color: getDistrictColor(room.district),
            throughput,
            direction: direction as string,
            crossDistrict,
          },
        });
      }
    }

    return edgeList;
  }, [rooms, entitiesByRoom]);

  // Build interaction arc edges from the store
  const interactionEdges = useMemo<Edge[]>(() => {
    const active = getActiveInteractions();
    const edges: Edge[] = [];
    for (const arc of active) {
      let sourceRoom: string | undefined;
      let targetRoom: string | undefined;

      if (arc.type === "move" && arc.fromRoom && arc.toRoom) {
        // Movement arcs use stored room IDs (entity already moved)
        sourceRoom = arc.fromRoom;
        targetRoom = arc.toRoom;
      } else {
        // Communication arcs use current entity positions
        sourceRoom = entityRooms[arc.from];
        targetRoom = entityRooms[arc.to];
      }

      if (!sourceRoom || !targetRoom) continue;
      if (sourceRoom === targetRoom) continue;

      edges.push({
        id: arc.id,
        source: sourceRoom,
        target: targetRoom,
        type: "interaction",
        data: {
          type: arc.type,
          createdAt: arc.createdAt,
          body: arc.body,
          recipient: arc.recipient,
          from: arc.from,
          to: arc.to,
        },
      });
    }
    return edges;
  }, [getActiveInteractions, entityRooms]);

  // ── Recall paths ─────────────────────────────────────────────────────
  // Draw the agent's reasoning on the graph layer: for each fresh
  // `recall_trace`, a pulsing amber path from the entity's current room
  // to each activated note, with the query text shown in a pill.
  const [recallTick, setRecallTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recallTick drives recomputation
  const recallLive = useMemo(
    () => hasLiveRecallTrace(recentTraces, Date.now()),
    [recentTraces, recallTick],
  );
  useEffect(() => {
    if (!recallLive) return;
    const interval = setInterval(() => setRecallTick((n) => n + 1), 200);
    return () => clearInterval(interval);
  }, [recallLive]);

  const roomNodeIds = useMemo(() => new Set(rooms.map((r) => r.id)), [rooms]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: recallTick drives fade animation
  const recallPathEdges = useMemo<Edge[]>(() => {
    if (hideGraph) return [];
    return buildRecallPathEdges(recentTraces, entityRooms, roomNodeIds, noteLayout, Date.now());
  }, [recentTraces, entityRooms, roomNodeIds, noteLayout, hideGraph, recallTick]);

  const allEdges = useMemo<Edge[]>(
    () => [
      ...flowEdges,
      ...canvasEdges,
      ...interactionEdges,
      ...graphLinkEdges,
      ...recallPathEdges,
    ],
    [flowEdges, canvasEdges, interactionEdges, graphLinkEdges, recallPathEdges],
  );

  // ── Search function for CommandBar ───────────────────────────────────────
  const searchFn = useCallback(
    (query: string) => {
      const state: SearchableWorldState = {
        entities: entities.map((e) => ({
          name: e.name,
          kind: e.kind,
          room: e.room,
          agentStatus: e.agentStatus
            ? {
                model: e.agentStatus.model,
                focus: e.agentStatus.focus,
                state: e.agentStatus.state,
                role: e.agentStatus.role,
                supports: e.agentStatus.supports,
              }
            : undefined,
        })),
        rooms: rooms.map((r) => ({
          id: r.id,
          short: r.short,
          district: r.district,
        })),
        flowNodes: allNodes,
      };
      return searchWorld(query, state);
    },
    [entities, rooms, allNodes],
  );

  // ── Initialize game WebSocket (chat WS at /ws) ─────────────────────────────
  // Ensure the WebSocket is alive. Auth handling only — CommandBar's own
  // perception handler renders all messages (no forwarding to avoid duplicates).
  useEffect(() => {
    ensureChatWs((raw: unknown) => {
      const p = raw as {
        kind?: string;
        data?: { text?: string; token?: string; entityId?: string; name?: string };
      };
      if (p.kind === "auth_error") {
        // Server rejected our login/reconnect — drop the stale token and reset
        // UI state so the login row reappears. The error text is rendered by
        // CommandBar's own handler.
        clearToken();
        useChatState.getState().setLoggedIn(false);
        return;
      }
      if (p.data?.token) {
        setToken(p.data.token);
      }
      if (p.data?.entityId) {
        useChatState.getState().setLoggedIn(true, p.data.name ?? p.data.entityId);
      }
    });
  }, []);

  // ── Send command via game WebSocket (chat WS at /ws) ─────────────────────
  const sendCommand = useCallback((command: string) => {
    const ws = getChatWs();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "command", command }));
    }
  }, []);

  // ── Drag-to-connect: create a typed edge between two nodes by dragging ──
  const onConnect = useCallback(
    (conn: { source: string | null; target: string | null }) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      // Canvas media nodes: canvas-<uuid>
      if (conn.source.startsWith("canvas-") && conn.target.startsWith("canvas-")) {
        const src = conn.source.slice("canvas-".length);
        const tgt = conn.target.slice("canvas-".length);
        sendCommand(`canvas connect ${src} ${tgt} related_to`);
        return;
      }
      // Graph notes: note-<id>
      if (conn.source.startsWith("note-") && conn.target.startsWith("note-")) {
        const src = conn.source.slice("note-".length);
        const tgt = conn.target.slice("note-".length);
        sendCommand(`note link ${src} ${tgt} related_to`);
        return;
      }
      // Cross-type drags (e.g. note → canvas node) aren't modeled yet; ignore.
    },
    [sendCommand],
  );

  // ── Right-click an edge → relationship picker ─────────────────────────
  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: { id: string; source: string; target: string; data?: unknown }) => {
      // Only handle our typed-relationship edges — room/interaction edges don't
      // carry a relationship and shouldn't show the picker.
      const data = (edge.data ?? {}) as { relationship?: string };
      const rel = data.relationship;
      if (!rel) return;
      // canvas-edge-<uuid> → canvas edge
      if (edge.id.startsWith("canvas-edge-") && edge.source.startsWith("canvas-")) {
        e.preventDefault();
        setEdgeMenu({
          kind: "canvas",
          edgeId: edge.id.slice("canvas-edge-".length),
          sourceId: edge.source.slice("canvas-".length),
          targetId: edge.target.slice("canvas-".length),
          relationship: rel,
          x: e.clientX,
          y: e.clientY,
        });
        return;
      }
      // notelink-<src>-<tgt>-<rel> → note link
      if (edge.id.startsWith("notelink-") && edge.source.startsWith("note-")) {
        e.preventDefault();
        setEdgeMenu({
          kind: "note",
          sourceId: edge.source.slice("note-".length),
          targetId: edge.target.slice("note-".length),
          relationship: rel,
          x: e.clientX,
          y: e.clientY,
        });
        return;
      }
    },
    [],
  );

  const handleSearchNavigate = useCallback(
    (category: string, targetId: string) => {
      if (category === "entity") {
        openContext("entity", targetId);
      } else if (category === "room") {
        openContext("room", targetId);
      }
    },
    [openContext],
  );

  // ── Visit an entity's canvas ───────────────────────────────────────────
  // Fetches (and lazy-creates) the entity's canvas via the REST endpoint,
  // then switches the dashboard canvas selector to it. The canvas WS feed
  // re-syncs naturally once selectedCanvasId changes.
  const handleVisitEntityCanvas = useCallback(async (entityName: string) => {
    try {
      const res = await fetch(`/api/entities/${encodeURIComponent(entityName)}/canvas`, {
        credentials: "same-origin",
      });
      if (!res.ok) return;
      const canvas = (await res.json()) as { id?: string };
      if (canvas.id) setSelectedCanvasId(canvas.id);
    } catch {
      // Best-effort — no retry, user can try again
    }
  }, []);

  // World ring bounds from ROOM positions only — canvas drops don't expand the ring
  const allNodePositions = useMemo(() => {
    const positions: { x: number; y: number }[] = [];
    for (const room of rooms) {
      const pos = roomPositions[room.id];
      if (pos) positions.push(pos);
    }
    return positions;
  }, [rooms, roomPositions]);

  // Fit world into the usable viewport (excluding topbar + bottom panels)
  const fitWorldInView = useCallback(
    (duration = 400) => {
      const topInset = 80;
      const bottomInset = 260;
      const sideInset = 220;
      const vh = window.innerHeight;
      const vw = window.innerWidth;

      const positions = Object.values(roomPositions);
      if (positions.length === 0) {
        fitView({ padding: 0.2, duration });
        return;
      }

      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const p of positions) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      // Room visual extent (200 up, 120 down, 150 side) + ring breathing room (80)
      const totalPad = 350;
      minX -= totalPad;
      maxX += totalPad;
      minY -= totalPad;
      maxY += totalPad;

      const worldW = maxX - minX;
      const worldH = maxY - minY;
      const worldCx = (minX + maxX) / 2;
      const worldCy = (minY + maxY) / 2;

      // Usable viewport area
      const usableW = vw - sideInset;
      const usableH = vh - topInset - bottomInset;

      // Zoom to fit world in usable area
      const zoomX = usableW / worldW;
      const zoomY = usableH / worldH;
      const zoom = Math.min(zoomX, zoomY) * 0.95;

      // Pan so world center sits in center of usable area
      const usableCenterX = sideInset / 2 + usableW / 2;
      const usableCenterY = topInset + usableH / 2;
      const x = usableCenterX - worldCx * zoom;
      const y = usableCenterY - worldCy * zoom;

      setViewport({ x, y, zoom }, { duration });
    },
    [fitView, roomPositions, setViewport],
  );

  // Keep ref in sync for keyboard handler
  fitWorldRef.current = fitWorldInView;

  const handleHome = useCallback(() => {
    fitWorldInView(400);
  }, [fitWorldInView]);

  // Initial focus
  const didInitialFocus = useRef(false);
  useEffect(() => {
    if (rooms.length > 0 && !didInitialFocus.current) {
      didInitialFocus.current = true;
      setTimeout(() => fitWorldInView(600), 500);
    }
  }, [rooms.length, fitWorldInView]);

  // Re-fit on window resize
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fitWorldInView(300), 200);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(timeout);
    };
  }, [fitWorldInView]);

  // Drag-drop handlers for file upload
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropping(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as HTMLElement)) return;
    setDropping(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDropping(false);

      const files = e.dataTransfer.files;
      if (!files.length) return;

      const position = screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });

      const cmdBar = commandBarRef.current;
      if (cmdBar) {
        cmdBar.addMessage(
          null,
          `Uploading ${files.length} file${files.length === 1 ? "" : "s"}...`,
          true,
          "system",
        );
      }

      try {
        const results = await canvasDrop(files, position);
        if (results.length === 0) {
          cmdBar?.addMessage(null, "Drop produced no canvas nodes.", true, "system");
          return;
        }
        // Enqueue every successfully-uploaded file for the intent prompt.
        // Append (rather than replace) so back-to-back drops queue up cleanly.
        setDropQueue((prev) => [...prev, ...results]);
        if (cmdBar) {
          const summary = results
            .slice(0, 3)
            .map((r) => `"${r.filename}"`)
            .join(", ");
          const more = results.length > 3 ? ` +${results.length - 3} more` : "";
          cmdBar.addMessage(
            null,
            `Dropped ${results.length} file${results.length === 1 ? "" : "s"}: ${summary}${more}. Set an intent to put an agent on it.`,
            true,
            "system",
          );
        }
      } catch (err) {
        cmdBar?.addMessage(
          null,
          `Drop failed: ${err instanceof Error ? err.message : "unknown error"}`,
          true,
          "system",
        );
      }
    },
    [screenToFlowPosition, canvasDrop],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: root canvas container; handlers are drag-and-drop (onDragOver/Leave/Drop), not click activation
    <div
      className={`uc-scanlines uc-pixel-grid${clearView ? " uc-clear-view" : ""}${entitiesExpanded ? " uc-entities-expanded" : ""}${worldNavExpanded ? " uc-worldnav-expanded" : ""}`}
      style={{
        background: "var(--color-bg)",
        color: "var(--color-text)",
        fontFamily: "'VT323', monospace",
        fontSize: "clamp(18px, 1.35vw, 28px)",
        overflow: "hidden",
        width: embedded ? "100%" : "100vw",
        height: embedded ? "100%" : "100vh",
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* ═══ TOP BAR ═══ */}
      {/* Loading overlay — shown before world data arrives */}
      {!connected && rooms.length === 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 150,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--color-bg)",
            gap: "16px",
          }}
        >
          <div
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: "clamp(20px, 2vw, 36px)",
              fontWeight: 700,
              color: "var(--color-primary)",
              letterSpacing: "4px",
            }}
          >
            MARINA
          </div>
          <div
            style={{
              fontFamily: "'VT323', monospace",
              fontSize: "clamp(16px, 1.2vw, 24px)",
              color: "#888",
            }}
          >
            Connecting to world...
          </div>
          <div
            style={{
              width: "60px",
              height: "60px",
              border: "3px solid #222",
              borderTop: "3px solid var(--color-primary)",
              borderRadius: "50%",
              animation: "uc-spin 1s linear infinite",
            }}
          />
        </div>
      )}

      <div className="uc-topbar" style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
        <span className="uc-logo">MARINA</span>

        {/* Instance status indicator */}
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "clamp(10px, 0.7vw, 13px)",
            marginLeft: "clamp(6px, 0.6vw, 12px)",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: setupStatus?.hasLlmKey ? "#22c55e" : "#f59e0b",
              flexShrink: 0,
            }}
          />
          <span style={{ color: "#888", fontFamily: "'VT323', monospace" }}>
            {instanceName || setupStatus?.instanceName || worldName || "Marina"}
          </span>
          {setupStatus && !setupStatus.hasLlmKey && (
            <span
              style={{
                color: "#f59e0b",
                fontSize: "clamp(8px, 0.6vw, 11px)",
                fontFamily: "'VT323', monospace",
              }}
            >
              (no LLM — add key in Admin)
            </span>
          )}
        </span>

        {/* Compass items area */}
        <div style={{ display: "flex", alignItems: "center", gap: "clamp(8px, 0.9vw, 16px)" }}>
          <div className="uc-divider" />
          <span className="uc-stat-value">{rooms.length}</span>
          <span className="uc-stat-label">rooms</span>
          <div className="uc-divider" />
          <span className="uc-stat-value">{entities.length}</span>
          <span className="uc-stat-label">entities</span>
          <div className="uc-divider" />
          <span className="uc-stat-value">{agentCount}</span>
          <span className="uc-stat-label">agents</span>
          <div className="uc-divider" />
          <span className="uc-stat-value">{wsConnections}</span>
          <span className="uc-stat-label">conn</span>
          {systemData?.projectCount != null && systemData.projectCount > 0 && (
            <>
              <div className="uc-divider" />
              <span className="uc-stat-value">{systemData.projectCount}</span>
              <span className="uc-stat-label">proj</span>
            </>
          )}
          {systemData?.uptime != null && systemData.uptime > 0 && (
            <>
              <div className="uc-divider" />
              <span className="uc-stat-value">{formatUptimeShort(systemData.uptime)}</span>
              <span className="uc-stat-label">uptime</span>
            </>
          )}
        </div>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Canvas WS connection badge — only visible when reconnecting, so the
            user notices when the realtime feed went silent. */}
        {canvasWsStatus === "reconnecting" && (
          <span
            title="The canvas WebSocket dropped; new nodes won't appear until it reconnects."
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "3px 8px",
              marginRight: "12px",
              fontFamily: "'Press Start 2P', monospace",
              fontSize: "clamp(6px, 0.52vw, 8px)",
              color: "#fbbf24",
              border: "1px solid rgba(251, 191, 36, 0.5)",
              background: "rgba(251, 191, 36, 0.08)",
              borderRadius: "2px",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "#fbbf24",
                animation: "pulse 1.4s ease-in-out infinite",
              }}
            />
            RECONNECTING
          </span>
        )}

        {/* Panel toggle buttons */}
        <div
          style={{
            display: "flex",
            gap: "2px",
            alignItems: "center",
            flexShrink: 0,
            marginRight: "12px",
          }}
        />

        {/* Theme switcher */}
        <button
          type="button"
          onClick={cycleTheme}
          style={{
            padding: "3px 10px",
            border: "1px solid var(--color-border)",
            background: "none",
            fontFamily: "'Press Start 2P', monospace",
            fontSize: "clamp(6px, 0.52vw, 8px)",
            color: "var(--color-primary)",
            cursor: "pointer",
          }}
          title="Cycle theme"
        >
          {themeName}
        </button>

        {/* Reset layout button */}
        <button
          type="button"
          onClick={handleReset}
          style={{
            padding: "3px 10px",
            border: "1px solid var(--color-border)",
            background: "none",
            fontFamily: "'Press Start 2P', monospace",
            fontSize: "clamp(6px, 0.52vw, 8px)",
            color: "#666",
            cursor: "pointer",
          }}
          title="Reset all panels to defaults"
        >
          Reset
        </button>

        {/* Clear view */}
        <button
          type="button"
          onClick={toggleClearView}
          style={{
            padding: "3px 10px",
            border: "1px solid var(--color-border)",
            background: "none",
            fontFamily: "'Press Start 2P', monospace",
            fontSize: "clamp(6px, 0.52vw, 8px)",
            color: clearView ? "var(--color-primary)" : "#555",
            cursor: "pointer",
          }}
          title="Clear view (Space)"
        >
          Clear
        </button>

        {/* Command bar toggle */}
        <button
          type="button"
          onClick={toggleCommandBar}
          style={{
            padding: "3px 10px",
            border: "1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)",
            background: "color-mix(in srgb, var(--color-primary) 3%, transparent)",
            fontFamily: "'VT323', monospace",
            fontSize: "clamp(12px, 0.83vw, 16px)",
            color: "var(--color-primary)",
            cursor: "pointer",
          }}
          title="Command bar ( / )"
        >
          /
        </button>

        {/* LIVE indicator */}
        <div className="uc-live">{connected ? "LIVE" : "OFFLINE"}</div>
      </div>

      {/* ═══ MAIN AREA ═══ */}
      {/* Drag-and-drop is wired on the outermost container so files dropped
          anywhere on the dashboard (including the top bar) are caught — no
          inner handler needed here. */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", minHeight: 0 }}>
        {/* Drop overlay */}
        {dropping && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 50,
              pointerEvents: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(244, 114, 182, 0.08)",
              border: "3px dashed var(--color-pink)",
              fontFamily: "'Press Start 2P', monospace",
              fontSize: "clamp(12px, 1vw, 18px)",
              color: "var(--color-pink)",
              letterSpacing: "3px",
            }}
          >
            DROP FILE HERE
          </div>
        )}

        {/* World ring overlay */}
        <WorldRing
          worldName={worldName || "World"}
          entityCount={entities.length}
          allPositions={allNodePositions}
        />

        <ReactFlow
          nodes={displayNodes}
          edges={allEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onNodeContextMenu={onNodeContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          onClick={onPaneClick}
          onDoubleClick={onPaneDoubleClick}
          defaultViewport={{ x: 0, y: 80, zoom: 0.6 }}
          minZoom={0.05}
          maxZoom={4}
          panOnDrag
          zoomOnScroll
          panOnScroll={false}
          proOptions={{ hideAttribution: true }}
          style={{ background: "transparent", width: "100%", height: "100%" }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="var(--color-border)"
          />
          {/* MiniMap replaced by custom SVG in WorldNav panel */}
        </ReactFlow>

        {/* Layer toggle chips (World · Canvas · Graph · Feed) */}
        {!clearView && (
          <div
            style={{
              position: "absolute",
              top: 12,
              left: 12,
              display: "flex",
              gap: 4,
              padding: "4px 6px",
              background: "rgba(8, 8, 12, 0.82)",
              border: "1px solid rgba(255,221,0,0.25)",
              borderRadius: 4,
              fontFamily: "'Press Start 2P', monospace",
              fontSize: 9,
              letterSpacing: 1,
              zIndex: 40,
            }}
          >
            {(
              [
                ["WORLD", 1, hideWorld, setHideWorld, "#FFDD00"],
                ["CANVAS", 2, hideCanvasNodes, setHideCanvasNodes, "#06b6d4"],
                ["GRAPH", 3, hideGraph, setHideGraph, "#a855f7"],
                ["FEED", 4, hideFeed, setHideFeed, "#22c55e"],
              ] as const
            ).map(([label, num, isHidden, setter, color]) => (
              <motion.button
                key={label}
                type="button"
                onClick={(e) => {
                  // Shift-click: solo this layer (hide all others, show this)
                  if (e.shiftKey) {
                    setHideWorld(label !== "WORLD");
                    setHideCanvasNodes(label !== "CANVAS");
                    setHideGraph(label !== "GRAPH");
                    setHideFeed(label !== "FEED");
                  } else {
                    setter(!isHidden);
                  }
                }}
                whileHover={{ scale: 1.06 }}
                whileTap={{ scale: 0.94 }}
                animate={{
                  background: isHidden ? "transparent" : `${color}22`,
                  borderColor: isHidden ? "#333" : color,
                  color: isHidden ? "#666" : color,
                }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                style={{
                  padding: "4px 8px",
                  borderStyle: "solid",
                  borderWidth: 1,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: "inherit",
                  letterSpacing: "inherit",
                  borderRadius: 2,
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
                title={`${label} layer — click to toggle (key ${num}), shift-click to solo`}
              >
                <span style={{ opacity: 0.5, fontSize: "0.75em" }}>{num}</span>
                <span>{label}</span>
              </motion.button>
            ))}
          </div>
        )}

        {/* Active-canvas breadcrumb — visible when the user has navigated into
            a non-default canvas (an entity's workspace, a project canvas, etc).
            Distinguishes "viewing global" from "viewing alice's workspace" so
            users don't lose orientation. */}
        {!clearView &&
          activeCanvasId &&
          (() => {
            const active = canvasList.find((c) => c.id === activeCanvasId);
            if (!active) return null;
            if (active.name === "global") return null;
            return (
              <div
                style={{
                  position: "absolute",
                  top: 48,
                  left: 12,
                  padding: "4px 8px",
                  background: "rgba(8, 8, 12, 0.82)",
                  border: "1px solid rgba(168,85,247,0.4)",
                  borderRadius: 3,
                  color: "#ccc",
                  fontFamily: "'VT323', monospace",
                  fontSize: 12,
                  zIndex: 35,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span style={{ color: "#a855f7", fontSize: 11 }}>viewing</span>
                <span style={{ color: "#FFDD00" }}>{active.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    const global = canvasList.find((c) => c.name === "global");
                    setSelectedCanvasId(global?.id ?? null);
                  }}
                  style={{
                    background: "transparent",
                    border: "1px solid #444",
                    color: "#888",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    fontSize: 11,
                    padding: "1px 5px",
                    borderRadius: 2,
                  }}
                  title="Return to global canvas"
                >
                  ×
                </button>
              </div>
            );
          })()}

        {/* Live activity timeline — toggleable via Feed layer chip */}
        <TimelineStrip
          hidden={hideFeed || clearView}
          onEventClick={(evt) => {
            // Drill-down: parse ref and navigate to the underlying object
            if (!evt.ref) return;
            const colon = evt.ref.indexOf(":");
            if (colon < 0) return;
            const kind = evt.ref.slice(0, colon);
            const ident = evt.ref.slice(colon + 1);
            // note:<id> → focus the graph note node and open its detail panel
            if (kind === "note") {
              const noteId = Number(ident);
              if (!Number.isFinite(noteId)) return;
              const n = displayNodes.find((x) => x.id === `note-${noteId}`);
              if (n) {
                fitView({
                  nodes: [{ id: `note-${noteId}` }],
                  padding: 0.6,
                  duration: 500,
                  maxZoom: 1.4,
                });
              }
              handleNoteClick(noteId);
              return;
            }
            // canvas_intent:<nodeId> → focus the canvas node
            if (kind === "canvas_intent") {
              const n = displayNodes.find((x) => x.id === `canvas-${ident}`);
              if (n) {
                fitView({
                  nodes: [{ id: `canvas-${ident}` }],
                  padding: 0.5,
                  duration: 500,
                  maxZoom: 1.2,
                });
              }
              return;
            }
            // Task events carry the entity; focus their room
            if (evt.entity) {
              const ent = entities.find((e) => e.name === evt.entity);
              if (ent) {
                fitView({
                  nodes: [{ id: ent.room }],
                  padding: 0.4,
                  duration: 400,
                  maxZoom: 1.2,
                });
              }
            }
          }}
        />

        {/* Legend is now the flip side of WorldNav (bottom-right) — see WorldNav onReplayTour */}

        {/* First-visit orientation — ambient, non-blocking, scoped by instance.
            Keying on tourKey lets "replay orientation" remount and re-read
            localStorage (which we just cleared). */}
        <WelcomeTour key={tourKey} instanceName={instanceName} hidden={clearView} />

        {/* Edge right-click relationship picker */}
        <EdgeContextMenu
          target={edgeMenu}
          onClose={() => setEdgeMenu(null)}
          sendCommand={sendCommand}
        />

        {/* Post-drop intent prompt — opens automatically after a drag-and-drop
            upload finishes, walks one file at a time. */}
        <AnimatePresence>
          {dropQueue.length > 0 && (
            <DropDialog files={dropQueue} onClose={() => setDropQueue([])} />
          )}
        </AnimatePresence>
      </div>

      {/* ═══ FLOATING PANELS ═══ */}
      <EntityPanel
        visible={showEntities && !clearView}
        onClose={() => {
          setShowEntities(false);
          setEntitiesExpanded(false);
        }}
        onEntityClick={handleEntityClick}
        sendCommand={sendCommand}
        onExpandChange={setEntitiesExpanded}
      />
      {/* FeedPanel merged into CommandBar "Events" tab */}
      {/* AdminPanel merged into CommandBar admin tabs */}
      <ContextPanel
        type={clearView ? null : contextType}
        id={clearView ? null : contextId}
        anchorPos={contextAnchor}
        onClose={closeContext}
        onEntityClick={handleEntityClick}
        onRoomClick={handleRoomClick}
        onNoteClick={(noteId) => handleNoteClick(noteId)}
        onVisitEntityCanvas={handleVisitEntityCanvas}
        sendCommand={sendCommand}
      />

      {/* ═══ WORLD NAV (bottom-right) ═══ */}
      <WorldNav
        visible={!clearView}
        districts={activeDistricts}
        hiddenDistricts={hiddenDistricts}
        toggleDistrict={toggleDistrict}
        hideEmptyRooms={hideEmptyRooms}
        setHideEmptyRooms={setHideEmptyRooms}
        canvasList={canvasList}
        activeCanvasId={activeCanvasId}
        setSelectedCanvasId={setSelectedCanvasId}
        roomCount={rooms.length}
        entityCount={entities.length}
        connectionCount={wsConnections}
        rooms={rooms}
        roomPositions={roomPositions}
        onHome={handleHome}
        onZoomIn={() => zoomIn({ duration: 200 })}
        onZoomOut={() => zoomOut({ duration: 200 })}
        onExpandChange={setWorldNavExpanded}
        onReplayTour={() => {
          clearSeenTour(instanceName);
          setTourKey((k) => k + 1);
        }}
      />

      {/* ═══ COMMAND BAR ═══ */}
      <CommandBar
        ref={commandBarRef}
        visible={showCommandBar && !clearView}
        onEntityClick={handleEntityClick}
        searchFn={searchFn}
        onSearchNavigate={handleSearchNavigate}
        sendCommand={sendCommand}
      />

      {/* ═══ CLEAR VIEW INDICATOR ═══ */}
      {clearView && (
        <div className="uc-clear-indicator" style={{ display: "flex" }}>
          CLEAR VIEW &mdash; press Space to restore panels
        </div>
      )}

      {/* ═══ RIGHT-CLICK CONTEXT MENU ═══ */}
      {contextMenu && (
        <div
          className="uc-node-context-menu"
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 200,
          }}
        >
          <button
            type="button"
            onClick={() => {
              const nodeId = contextMenu.nodeId;
              const nodeType = contextMenu.nodeType;
              closeContextMenu();
              if (nodeType === "room") {
                openContext("room", nodeId);
              } else if (isCanvasContentNode(nodeType)) {
                openContext("canvas", nodeId);
              }
            }}
          >
            Inspect
          </button>
          <button
            type="button"
            onClick={() => {
              const nodeId = contextMenu.nodeId;
              closeContextMenu();
              setDisplayNodes((nds) =>
                nds.map((n) => (n.id === nodeId ? { ...n, zIndex: (n.zIndex ?? 0) + 100 } : n)),
              );
            }}
          >
            Move to front
          </button>
          <div className="uc-context-menu-divider" />
          {/* Add Note — inline input or button */}
          {noteInput && noteInput.nodeId === contextMenu.nodeId ? (
            <div style={{ padding: "4px 8px", display: "flex", gap: "4px" }}>
              <input
                ref={noteInputRef}
                type="text"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && noteText.trim()) {
                    const target =
                      noteInput.nodeType === "room" ? noteInput.nodeId : noteInput.nodeId;
                    sendCommand(`note create ${noteText.trim()} @${target}`);
                    setNoteText("");
                    setNoteInput(null);
                    closeContextMenu();
                  }
                  if (e.key === "Escape") {
                    setNoteText("");
                    setNoteInput(null);
                  }
                }}
                placeholder="Type note..."
                style={{
                  flex: 1,
                  background: "rgba(17,17,24,0.8)",
                  border: "1px solid var(--color-border)",
                  color: "#ddd",
                  fontFamily: "'VT323', monospace",
                  fontSize: "14px",
                  padding: "3px 6px",
                  outline: "none",
                  minWidth: 0,
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setNoteInput({ nodeId: contextMenu.nodeId, nodeType: contextMenu.nodeType });
                setNoteText("");
                setTimeout(() => noteInputRef.current?.focus(), 50);
              }}
            >
              Add note
            </button>
          )}
          {isCanvasContentNode(contextMenu.nodeType) && (
            <>
              <div className="uc-context-menu-divider" />
              <button
                type="button"
                onClick={() => {
                  const nodeId = contextMenu.nodeId;
                  closeContextMenu();
                  const node = displayNodes.find((n) => n.id === nodeId);
                  if (node) {
                    const data = node.data as CanvasNodeMeta;
                    const nodeType = node.type as string;
                    setViewerTitle(data.title ?? nodeType);
                    const intentMode = !!data.intent;
                    const ct = (
                      intentMode
                        ? "intent"
                        : ["image", "video", "audio", "pdf", "document", "a2ui"].includes(nodeType)
                          ? nodeType
                          : "unknown"
                    ) as ViewerContentType;
                    setViewerContentType(ct);
                    if (intentMode && data.intent) {
                      const rawNodeId = nodeId.replace("canvas-", "");
                      setViewerContent(
                        JSON.stringify({
                          ...data.intent,
                          canvasId: data.canvasId,
                          nodeId: rawNodeId,
                        }),
                      );
                    } else {
                      setViewerContent(data.url ?? undefined);
                    }
                    setViewerOpen(true);
                  }
                }}
              >
                Open in viewer
              </button>
              {/* Set intent — inline prompt or button */}
              {noteInput &&
              noteInput.nodeType === "_intent" &&
              noteInput.nodeId === contextMenu.nodeId ? (
                <div style={{ padding: "4px 8px", display: "flex", gap: "4px" }}>
                  <input
                    type="text"
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter" && noteText.trim()) {
                        const rawId = contextMenu.nodeId.replace("canvas-", "");
                        const node = displayNodes.find((n) => n.id === contextMenu.nodeId);
                        const canvasId = node
                          ? ((node.data as Record<string, unknown>).canvasId as string)
                          : null;
                        if (canvasId) {
                          try {
                            const { authFetch } = await import("../lib/api");
                            const existingData = (node?.data as Record<string, unknown>) ?? {};
                            await authFetch(
                              `${window.location.origin}/api/canvases/${canvasId}/nodes/${rawId}`,
                              {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  data: {
                                    ...existingData,
                                    intent: { prompt: noteText.trim(), status: "pending" },
                                  },
                                }),
                              },
                            );
                            commandBarRef.current?.addMessage(
                              null,
                              `Intent set: "${noteText.trim()}"`,
                              true,
                              "system",
                            );
                          } catch {
                            commandBarRef.current?.addMessage(
                              null,
                              "Failed to set intent",
                              true,
                              "system",
                            );
                          }
                        }
                        setNoteText("");
                        setNoteInput(null);
                        closeContextMenu();
                      }
                      if (e.key === "Escape") {
                        setNoteText("");
                        setNoteInput(null);
                      }
                    }}
                    placeholder="What should be done with this?"
                    style={{
                      flex: 1,
                      background: "rgba(17,17,24,0.8)",
                      border: "1px solid var(--color-teal)",
                      color: "#ddd",
                      fontFamily: "'VT323', monospace",
                      fontSize: "14px",
                      padding: "3px 6px",
                      outline: "none",
                      minWidth: 0,
                    }}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setNoteInput({ nodeId: contextMenu.nodeId, nodeType: "_intent" });
                    setNoteText("");
                  }}
                >
                  Set intent
                </button>
              )}
              {/* ── Intent Actions: Claim / Complete / Fail ── */}
              {(() => {
                const node = displayNodes.find((n) => n.id === contextMenu.nodeId);
                const intentData = node ? (node.data as CanvasNodeMeta).intent : undefined;
                if (!intentData) return null;
                const rawId = contextMenu.nodeId.replace("canvas-", "");
                const canvasId = (node!.data as Record<string, unknown>).canvasId as string;
                return (
                  <>
                    <div className="uc-context-menu-divider" />
                    {/* Pending -> Claim */}
                    {intentData.status === "pending" && (
                      <button
                        type="button"
                        style={{ color: "#FFB800" }}
                        onClick={async () => {
                          const username = currentEntityName ?? "dashboard-user";
                          closeContextMenu();
                          try {
                            await claimIntent(canvasId, rawId, username);
                            commandBarRef.current?.addMessage(
                              null,
                              `Intent claimed by ${username}`,
                              true,
                              "system",
                            );
                          } catch {
                            commandBarRef.current?.addMessage(
                              null,
                              "Failed to claim intent",
                              true,
                              "system",
                            );
                          }
                        }}
                      >
                        Claim intent
                      </button>
                    )}
                    {/* Active + owned -> Complete / Fail */}
                    {intentData.status === "active" &&
                      intentData.claimedBy === currentEntityName && (
                        <>
                          {intentActionInput &&
                          intentActionInput.nodeId === contextMenu.nodeId &&
                          intentActionInput.action === "complete" ? (
                            <div
                              style={{
                                padding: "4px 8px",
                                display: "flex",
                                gap: "4px",
                              }}
                            >
                              <input
                                ref={intentInputRef}
                                type="text"
                                value={noteText}
                                onChange={(e) => setNoteText(e.target.value)}
                                onKeyDown={async (e) => {
                                  if (e.key === "Enter" && noteText.trim()) {
                                    closeContextMenu();
                                    try {
                                      await completeIntent(canvasId, rawId, noteText.trim());
                                      commandBarRef.current?.addMessage(
                                        null,
                                        "Intent completed",
                                        true,
                                        "system",
                                      );
                                    } catch {
                                      commandBarRef.current?.addMessage(
                                        null,
                                        "Failed to complete intent",
                                        true,
                                        "system",
                                      );
                                    }
                                  }
                                  if (e.key === "Escape") {
                                    setNoteText("");
                                    setIntentActionInput(null);
                                  }
                                }}
                                placeholder="Result text..."
                                style={{
                                  flex: 1,
                                  background: "rgba(17,17,24,0.8)",
                                  border: "1px solid #22c55e",
                                  color: "#ddd",
                                  fontFamily: "'VT323', monospace",
                                  fontSize: "14px",
                                  padding: "3px 6px",
                                  outline: "none",
                                  minWidth: 0,
                                }}
                              />
                            </div>
                          ) : (
                            <button
                              type="button"
                              style={{ color: "#22c55e" }}
                              onClick={() => {
                                setIntentActionInput({
                                  nodeId: contextMenu.nodeId,
                                  action: "complete",
                                });
                                setNoteText("");
                                setTimeout(() => intentInputRef.current?.focus(), 50);
                              }}
                            >
                              Complete intent
                            </button>
                          )}
                          {intentActionInput &&
                          intentActionInput.nodeId === contextMenu.nodeId &&
                          intentActionInput.action === "fail" ? (
                            <div
                              style={{
                                padding: "4px 8px",
                                display: "flex",
                                gap: "4px",
                              }}
                            >
                              <input
                                ref={intentInputRef}
                                type="text"
                                value={noteText}
                                onChange={(e) => setNoteText(e.target.value)}
                                onKeyDown={async (e) => {
                                  if (e.key === "Enter" && noteText.trim()) {
                                    closeContextMenu();
                                    try {
                                      await failIntent(canvasId, rawId, noteText.trim());
                                      commandBarRef.current?.addMessage(
                                        null,
                                        "Intent failed",
                                        true,
                                        "system",
                                      );
                                    } catch {
                                      commandBarRef.current?.addMessage(
                                        null,
                                        "Failed to update intent",
                                        true,
                                        "system",
                                      );
                                    }
                                  }
                                  if (e.key === "Escape") {
                                    setNoteText("");
                                    setIntentActionInput(null);
                                  }
                                }}
                                placeholder="Failure reason..."
                                style={{
                                  flex: 1,
                                  background: "rgba(17,17,24,0.8)",
                                  border: "1px solid #ef4444",
                                  color: "#ddd",
                                  fontFamily: "'VT323', monospace",
                                  fontSize: "14px",
                                  padding: "3px 6px",
                                  outline: "none",
                                  minWidth: 0,
                                }}
                              />
                            </div>
                          ) : (
                            <button
                              type="button"
                              style={{ color: "#ef4444" }}
                              onClick={() => {
                                setIntentActionInput({
                                  nodeId: contextMenu.nodeId,
                                  action: "fail",
                                });
                                setNoteText("");
                                setTimeout(() => intentInputRef.current?.focus(), 50);
                              }}
                            >
                              Fail intent
                            </button>
                          )}
                        </>
                      )}
                    {/* Done/Failed intents: status indicator */}
                    {(intentData.status === "done" || intentData.status === "failed") && (
                      <span
                        style={{
                          padding: "4px 12px",
                          fontSize: "12px",
                          color: intentData.status === "done" ? "#22c55e" : "#ef4444",
                          fontFamily: "'VT323', monospace",
                          opacity: 0.7,
                        }}
                      >
                        Intent {intentData.status}
                      </span>
                    )}
                  </>
                );
              })()}
              <div className="uc-context-menu-divider" />
              <button
                type="button"
                style={{ color: "#ef4444" }}
                onClick={async () => {
                  const rawNodeId = contextMenu.nodeId.replace("canvas-", "");
                  const reactFlowId = contextMenu.nodeId;
                  closeContextMenu();
                  try {
                    const { authFetch } = await import("../lib/api");
                    const node = displayNodes.find((n) => n.id === reactFlowId);
                    const canvasId = node
                      ? ((node.data as Record<string, unknown>).canvasId as string)
                      : null;
                    if (canvasId) {
                      const res = await authFetch(
                        `${window.location.origin}/api/canvases/${canvasId}/nodes/${rawNodeId}`,
                        {
                          method: "DELETE",
                        },
                      );
                      if (res.ok) {
                        // Remove from both canvas integration state AND display nodes
                        removeCanvasNode(rawNodeId);
                        setDisplayNodes((nds) => nds.filter((n) => n.id !== reactFlowId));
                        commandBarRef.current?.addMessage(
                          null,
                          "Canvas node deleted",
                          true,
                          "system",
                        );
                      }
                    }
                  } catch {
                    commandBarRef.current?.addMessage(
                      null,
                      "Failed to delete node",
                      true,
                      "system",
                    );
                  }
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}

      {/* ═══ VIEWER OVERLAY ═══ */}
      <Viewer
        open={viewerOpen}
        title={viewerTitle}
        contentType={viewerContentType}
        content={viewerContent}
        onClose={() => setViewerOpen(false)}
      />

      {/* Keyboard shortcut help overlay */}
      {showHelp && (
        // biome-ignore lint/a11y/useSemanticElements: backdrop overlay wraps a nested interactive role="dialog" — nesting it in a <button> is invalid HTML
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.7)",
            backdropFilter: "blur(4px)",
          }}
          onClick={() => setShowHelp(false)}
          onKeyDown={(e) => e.key === "Escape" && setShowHelp(false)}
          role="button"
          tabIndex={0}
        >
          <div
            style={{
              background: "rgba(8,8,14,0.97)",
              border: "2px solid var(--color-border)",
              borderRadius: "6px",
              padding: "24px 32px",
              fontFamily: "'VT323', monospace",
              color: "#ccc",
              fontSize: "18px",
              lineHeight: 2,
              minWidth: "320px",
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={() => {}}
            role="dialog"
            tabIndex={-1}
          >
            <div
              style={{
                fontFamily: "'Press Start 2P'",
                fontSize: "10px",
                color: "var(--color-primary)",
                marginBottom: "16px",
                letterSpacing: "2px",
              }}
            >
              KEYBOARD SHORTCUTS
            </div>
            <div>
              <span style={{ color: "var(--color-primary)" }}>/</span> — Toggle command bar
            </div>
            <div>
              <span style={{ color: "var(--color-primary)" }}>Space</span> — Clear view (hide
              panels)
            </div>
            <div>
              <span style={{ color: "var(--color-primary)" }}>Escape</span> — Close overlay / panel
            </div>
            <div>
              <span style={{ color: "var(--color-primary)" }}>Arrows</span> — Navigate to nearest
              room
            </div>
            <div>
              <span style={{ color: "var(--color-primary)" }}>?</span> — This help
            </div>
            <div>
              <span style={{ color: "var(--color-primary)" }}>Tab</span> — Cycle panels
            </div>
            <div>
              <span style={{ color: "var(--color-primary)" }}>Dbl-click</span> — Home / view detail
            </div>
            <div style={{ marginTop: "12px", color: "#666", fontSize: "14px" }}>
              Click anywhere to close
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Unified canvas-map view wrapped in ReactFlowProvider.
 * Rendered fullscreen at /?unified, or embedded in a dashboard panel's
 * back face (pass `embedded` to make it fill 100% of the parent instead
 * of the viewport).
 */
export function UnifiedCanvas({ embedded }: UnifiedCanvasProps = {}) {
  return (
    <ReactFlowProvider>
      <UnifiedCanvasInner embedded={embedded} />
    </ReactFlowProvider>
  );
}
