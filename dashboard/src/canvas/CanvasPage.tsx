// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  type NodeDimensionChange,
  type OnSelectionChangeParams,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/api";
import { CanvasToolbar } from "./components/CanvasToolbar";
import { ContextMenu } from "./components/ContextMenu";
import { NodeDetailPanel } from "./components/NodeDetailPanel";
import { SearchBar } from "./components/SearchBar";
import { fetchCanvases, useCanvas } from "./hooks/use-canvas";
import type { CanvasEvent } from "./hooks/use-canvas-ws";
import { useCanvasWs } from "./hooks/use-canvas-ws";
import { animateLayout as animateLayoutUtil, springEntrance } from "./lib/animations";
import { defaultSize } from "./lib/layout";
import { selectInitialCanvas } from "./lib/select-canvas";
import type { CanvasData, CanvasEdgeData } from "./lib/types";
import { nodeTypes } from "./nodes";

const API_BASE = window.location.origin;

const MIME_TO_NODE_TYPE: Record<string, string> = {
  "image/": "image",
  "video/": "video",
  "audio/": "audio",
  "application/pdf": "pdf",
  "text/": "document",
};

// Specific MIME types must come before generic prefixes (text/csv before text/)
const MIME_INTENT_SUGGESTIONS: [string, string][] = [
  ["application/pdf", "Summarize the key points of this document"],
  ["application/json", "Analyze the structure and key data in this JSON"],
  ["text/csv", "Parse this data and describe the key findings"],
  ["text/", "Read this file and summarize its contents"],
  ["image/", "Describe what you see in this image"],
];

function suggestIntent(mime: string): string | undefined {
  for (const [prefix, prompt] of MIME_INTENT_SUGGESTIONS) {
    if (mime.startsWith(prefix)) return prompt;
  }
  return undefined;
}

function guessNodeType(mime: string): string {
  for (const [prefix, type] of Object.entries(MIME_TO_NODE_TYPE)) {
    if (mime.startsWith(prefix)) return type;
  }
  return "document";
}

function CanvasInner() {
  const [canvasList, setCanvasList] = useState<CanvasData[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const requestedCanvasIdRef = useRef(new URLSearchParams(window.location.search).get("canvas"));
  const [filteredIds, setFilteredIds] = useState<Set<string> | null>(null);
  const [dropping, setDropping] = useState(false);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { fitView, screenToFlowPosition } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const prevNodeIdsRef = useRef<Set<string>>(new Set());
  const [snapshotRefreshKey, setSnapshotRefreshKey] = useState(0);
  const [liveEdges, setLiveEdges] = useState<CanvasEdgeData[]>([]);
  const handledGenerationRef = useRef(0);
  const skipNextConnectionRecoveryRef = useRef(true);
  const fittedSnapshotRef = useRef<string>();

  // Load canvas list on mount. Prefer the auto-populated activity feed so a
  // running Marina opens on visible work rather than an empty workspace.
  const loadCanvasList = useCallback(() => {
    setListError(null);
    fetchCanvases()
      .then((list) => {
        setCanvasList(list);
        setSelectedId((current) => {
          if (current && list.some((canvas) => canvas.id === current)) return current;
          return selectInitialCanvas(list, requestedCanvasIdRef.current)?.id ?? null;
        });
      })
      .catch((cause) => {
        setListError(cause instanceof Error ? cause.message : "Request failed");
      });
  }, []);
  useEffect(loadCanvasList, [loadCanvasList]);
  useEffect(() => {
    const refreshOnFocus = () => loadCanvasList();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [loadCanvasList]);

  // Keep deep links truthful even when an invalid/deleted requested canvas
  // falls back to a valid guide/feed workspace.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set("canvas", selectedId);
    else url.searchParams.delete("canvas");
    window.history.replaceState(null, "", url);
  }, [selectedId]);

  // Real-time updates via WebSocket. The hook subscribes first and buffers
  // every event; we flip its `markReady` once the snapshot has been applied,
  // so events that arrived during the fetch round-trip drain in order instead
  // of being overwritten by the snapshot. `resetForFetch` puts the buffer back
  // for the next canvas selection.
  //
  // `setNodes` and the WS handle reference each other — declare placeholders
  // first, the real wiring happens after `useCanvas` returns its setter.
  const wsHandleRef = useRef<{ markReady: () => void; resetForFetch: () => void } | null>(null);

  const {
    canvas,
    nodes,
    setNodes,
    loading,
    error,
    onNodesChange,
    persistNodePosition,
    persistNodeSize,
    persistNodeData,
    deleteNodes,
  } = useCanvas(selectedId, {
    onBeforeFetch: () => wsHandleRef.current?.resetForFetch(),
    onSnapshotReady: () => wsHandleRef.current?.markReady(),
    refreshKey: snapshotRefreshKey,
  });

  useEffect(() => setLiveEdges(canvas?.edges ?? []), [canvas?.edges]);
  const handleCanvasEvent = useCallback((event: CanvasEvent) => {
    if (event.type === "edge_added" && event.edge) {
      setLiveEdges((current) =>
        current.some((edge) => edge.id === event.edge!.id) ? current : [...current, event.edge!],
      );
    } else if (event.type === "edge_deleted" && event.edgeId) {
      setLiveEdges((current) => current.filter((edge) => edge.id !== event.edgeId));
    } else if (event.type === "node_deleted" && event.nodeId) {
      setLiveEdges((current) =>
        current.filter((edge) => edge.sourceId !== event.nodeId && edge.targetId !== event.nodeId),
      );
    }
  }, []);
  const wsHandle = useCanvasWs(selectedId, setNodes, handleCanvasEvent);
  const wsStatus = wsHandle.status;
  wsHandleRef.current = wsHandle;

  // React Flow's declarative fitView runs before asynchronously fetched nodes
  // are measured. Fit once after each canvas snapshot becomes renderable so
  // valid nodes cannot remain off-screen or visibility:hidden until interaction.
  useEffect(() => {
    if (!selectedId || loading || nodes.length === 0 || !nodesInitialized) return;
    const snapshotKey = `${selectedId}:${snapshotRefreshKey}`;
    if (fittedSnapshotRef.current === snapshotKey) return;
    fittedSnapshotRef.current = snapshotKey;
    requestAnimationFrame(() => {
      if (window.innerWidth < 640 && nodes[0]) {
        // Fitting a desktop-wide board onto a phone makes every card illegible.
        // Start on the first card at a readable scale; the minimap and pan
        // controls retain access to the rest of the infinite canvas.
        void fitView({ nodes: [nodes[0]], padding: 0.12, maxZoom: 0.9, duration: 250 });
      } else {
        void fitView({ padding: 0.18, duration: 250 });
      }
    });
  }, [fitView, loading, nodes, nodesInitialized, selectedId, snapshotRefreshKey]);

  // Selecting a different canvas already starts its own snapshot fetch; its
  // first connection must not schedule a duplicate recovery fetch.
  useEffect(() => {
    void selectedId;
    skipNextConnectionRecoveryRef.current = true;
  }, [selectedId]);

  // Apart from a canvas's first connection, every generation follows a
  // disconnect and needs a recovery snapshot to reconcile offline mutations.
  useEffect(() => {
    const generation = wsHandle.connectionGeneration;
    if (generation === 0 || generation <= handledGenerationRef.current) return;
    handledGenerationRef.current = generation;
    if (skipNextConnectionRecoveryRef.current) {
      skipNextConnectionRecoveryRef.current = false;
      return;
    }
    setSnapshotRefreshKey((key) => key + 1);
  }, [wsHandle.connectionGeneration]);

  // ── Node entrance animation ─────────────────────────────────────────
  useEffect(() => {
    if (nodes.length === 0) return;

    const currentIds = new Set(nodes.map((n) => n.id));
    const newIds: string[] = [];
    for (const id of currentIds) {
      if (!prevNodeIdsRef.current.has(id)) {
        newIds.push(id);
      }
    }
    prevNodeIdsRef.current = currentIds;

    if (newIds.length === 0) return;

    // Slight delay to let DOM render. Animate the node's inner content div,
    // NOT the React Flow wrapper — the wrapper's `transform` carries the
    // node's translate(x,y) position, and motion's scale animation would
    // overwrite it (ending at `transform: none`), stacking every node at
    // the origin.
    requestAnimationFrame(() => {
      const elements = newIds
        .map((id) => document.querySelector(`[data-id="${id}"] > div`))
        .filter((el): el is Element => el != null);

      if (elements.length > 0) {
        springEntrance(elements);
      }
    });
  }, [nodes]);

  // Track selected nodes for toolbar delete button
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);

  // Detail panel — opens on double-click
  const [detailNode, setDetailNode] = useState<Node | null>(null);
  const [suggestedPrompt, setSuggestedPrompt] = useState<string | undefined>();

  const onNodeDoubleClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setDetailNode(node);
  }, []);

  // Keep detail panel in sync with node updates
  useEffect(() => {
    if (!detailNode) return;
    const updated = nodes.find((n) => n.id === detailNode.id);
    if (!updated) {
      setDetailNode(null); // node was deleted
    } else if (updated !== detailNode) {
      setDetailNode(updated);
    }
  }, [nodes, detailNode]);

  // Listen for custom events from NodeActionBar hover button
  useEffect(() => {
    const handler = (e: Event) => {
      const nodeId = (e as CustomEvent).detail.nodeId as string;
      const node = nodes.find((n) => n.id === nodeId);
      if (node) setDetailNode(node);
    };
    window.addEventListener("marina:open-detail", handler);
    return () => window.removeEventListener("marina:open-detail", handler);
  }, [nodes]);

  // Right-click context menu
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
  } | null>(null);

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
  }, []);

  const onSelectionChange = useCallback(({ nodes: sel }: OnSelectionChangeParams) => {
    setSelectedNodeIds(sel.map((n) => n.id));
  }, []);

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      deleteNodes(deleted.map((n) => n.id));
    },
    [deleteNodes],
  );

  const handleToolbarDelete = useCallback(() => {
    if (selectedNodeIds.length > 0) {
      deleteNodes(selectedNodeIds);
      setSelectedNodeIds([]);
    }
  }, [selectedNodeIds, deleteNodes]);

  const onNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, node: Node) => {
      persistNodePosition(node.id, node.position.x, node.position.y);
    },
    [persistNodePosition],
  );

  const applyNodeDataSnapshot = useCallback(
    (nodeId: string, data: Record<string, unknown>) => {
      setNodes((cur) =>
        cur.map((node) =>
          node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node,
        ),
      );
    },
    [setNodes],
  );

  // Persist resize when a dimension change is completed
  const resizeTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);

      // Debounce resize persistence — dimension changes fire continuously
      for (const change of changes) {
        if (change.type === "dimensions" && change.resizing === false) {
          const dc = change as NodeDimensionChange;
          const nodeId = dc.id;
          clearTimeout(resizeTimerRef.current[nodeId]);
          resizeTimerRef.current[nodeId] = setTimeout(() => {
            // Read the final dimensions from the current nodes
            setNodes((cur) => {
              const n = cur.find((nd) => nd.id === nodeId);
              if (n?.measured?.width && n?.measured?.height) {
                persistNodeSize(nodeId, n.measured.width, n.measured.height);
              }
              return cur;
            });
          }, 200);
        }
      }
    },
    [onNodesChange, persistNodeSize, setNodes],
  );

  const displayNodes = useMemo(() => {
    if (!filteredIds) return nodes;
    return nodes.map((n) => ({
      ...n,
      hidden: !filteredIds.has(n.id),
    }));
  }, [nodes, filteredIds]);

  // Render both conversational parent links and first-class typed Canvas
  // relationships returned by the snapshot API.
  const edges = useMemo<Edge[]>(() => {
    const nodeIds = new Set(nodes.map((n) => n.id));
    const parentEdges = nodes
      .filter((n) => {
        const pid = n.data.parent_node_id as string | null;
        return pid && nodeIds.has(pid);
      })
      .map((n) => {
        const feedType = n.data.feedType as string | undefined;
        const isIntentResult = feedType === "intent_result";
        const isConversation = feedType === "conversation";

        let stroke = "var(--color-primary)"; // default: theme primary
        if (isIntentResult) stroke = "#10b981"; // emerald
        if (isConversation) stroke = "#8b5cf6"; // violet

        return {
          id: `e-${n.data.parent_node_id}-${n.id}`,
          source: n.data.parent_node_id as string,
          target: n.id,
          type: "smoothstep",
          animated: isIntentResult || isConversation,
          style: { stroke, strokeWidth: 1.5, opacity: 0.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        };
      });
    const typedEdges = liveEdges
      .filter((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId))
      .map((edge) => ({
        id: edge.id,
        source: edge.sourceId,
        target: edge.targetId,
        type: "smoothstep",
        label: edge.relationship,
        style: { stroke: "#22d3ee", strokeWidth: 1.5, opacity: 0.7 },
        labelStyle: { fill: "var(--color-text-dim)", fontSize: 10 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#22d3ee" },
      }));
    return [...parentEdges, ...typedEdges];
  }, [liveEdges, nodes]);

  const onFilterChange = useCallback((filtered: Node[] | null) => {
    if (!filtered) {
      setFilteredIds(null);
      return;
    }
    setFilteredIds(new Set(filtered.map((n) => n.id)));
  }, []);

  // ── Animated layout callback for toolbar ────────────────────────────
  const handleAnimateLayout = useCallback(
    async (targetMap: Map<string, { x: number; y: number; w: number; h: number }>) => {
      await animateLayoutUtil(nodes, targetMap, setNodes);
    },
    [nodes, setNodes],
  );

  // ── Drag & Drop Upload ───────────────────────────────────────────────

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropping(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear if leaving the wrapper (not entering a child)
    if (e.currentTarget.contains(e.relatedTarget as HTMLElement)) return;
    setDropping(false);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setNodes from useNodesState is stable
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDropping(false);

      if (!selectedId) return;
      const files = e.dataTransfer.files;
      if (!files.length) return;

      // Convert screen position to flow coordinates
      const position = screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });

      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const nodeType = guessNodeType(file.type);
        const size = defaultSize(nodeType);
        const dropX = position.x + i * (size.w + 20);
        const dropY = position.y;

        try {
          // 1. Upload file as asset
          const form = new FormData();
          form.append("file", file);
          form.append("entity", "canvas-drop");

          const uploadRes = await authFetch(`${API_BASE}/api/assets`, {
            method: "POST",
            body: form,
          });
          if (!uploadRes.ok) continue;
          const asset = await uploadRes.json();

          // 2. Create node on canvas at drop position with type-aware size
          await authFetch(`${API_BASE}/api/canvases/${selectedId}/nodes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: nodeType,
              asset_id: asset.id,
              x: dropX,
              y: dropY,
              width: size.w,
              height: size.h,
              creator_name: "canvas-drop",
              data: {
                url: asset.url,
                filename: file.name,
                mime: file.type,
              },
            }),
          });
          // Node will appear via WebSocket broadcast
          // Auto-suggest intent for the last dropped file
          if (i === files.length - 1) {
            const suggestion = suggestIntent(file.type);
            if (suggestion) {
              setSuggestedPrompt(suggestion);
              // Open detail panel for the new node once it appears via WS
              const checkForNode = () => {
                setNodes((cur) => {
                  const newNode = cur.find(
                    (nd) =>
                      (nd.data as Record<string, unknown>).filename === file.name && !detailNode,
                  );
                  if (newNode) setDetailNode(newNode);
                  return cur;
                });
              };
              // Small delay for WS event to arrive
              setTimeout(checkForNode, 500);
            }
          }
        } catch {
          // Continue with remaining files
        }
      }
    },
    [selectedId, screenToFlowPosition, detailNode],
  );

  return (
    <div className="w-screen h-screen bg-bg flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 overflow-x-auto px-3 md:px-4 py-2 bg-bg-card border-b border-border shrink-0">
        <h1 className="text-primary font-bold text-sm tracking-wider whitespace-nowrap shrink-0">
          MARINA CANVAS
        </h1>
        <div className="w-px h-5 bg-bg-hover" />
        <select
          className="bg-bg-hover text-text text-sm rounded px-2 py-1 border border-border focus:outline-none focus:border-primary shrink-0"
          value={selectedId ?? ""}
          onFocus={loadCanvasList}
          onChange={(e) => setSelectedId(e.target.value || null)}
        >
          {canvasList.length === 0 && <option value="">No canvases</option>}
          {canvasList.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {canvas && (
          <span className="hidden lg:inline text-xs text-text-dim whitespace-nowrap">
            {canvas.description} &middot; {nodes.length} nodes &middot; by {canvas.creator_name}
          </span>
        )}
        {wsStatus === "reconnecting" && (
          <span
            className="text-xs text-amber-400 flex items-center gap-1 px-2 py-0.5 rounded bg-amber-900/30 border border-amber-800/50"
            title="The canvas WebSocket is offline; new updates won't appear until it reconnects."
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            Reconnecting…
          </span>
        )}
        <div className="flex-1 min-w-2" />
        <div className="hidden md:block">
          <SearchBar nodes={nodes} onFilterChange={onFilterChange} />
        </div>
        <div className="w-px h-5 bg-bg-hover" />
        <CanvasToolbar
          canvasId={selectedId}
          nodes={nodes}
          selectedCount={selectedNodeIds.length}
          onDelete={handleToolbarDelete}
          onAnimateLayout={handleAnimateLayout}
        />
        <div className="w-px h-5 bg-bg-hover" />
        <a
          href="/dashboard"
          className="text-xs text-text-dim hover:text-text-bright transition-colors"
        >
          Dashboard
        </a>
      </div>

      {/* Canvas area */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: file drop zone — drag/drop handlers, not click-activation */}
      <div
        ref={reactFlowWrapper}
        className="flex-1 relative"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Drop overlay */}
        {dropping && (
          <div className="absolute inset-0 z-50 pointer-events-none flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary/50 rounded-lg m-2">
            <div className="text-primary text-lg font-medium">Drop files to add to canvas</div>
          </div>
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="text-primary text-sm animate-pulse">Loading canvas...</div>
          </div>
        )}
        {listError && !selectedId && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="rounded border border-red-800/60 bg-bg-card p-4 text-center shadow-xl">
              <div className="text-red-400 text-sm">Could not load canvases: {listError}</div>
              <button
                type="button"
                className="mt-3 rounded border border-primary/50 px-3 py-1 text-xs text-primary hover:bg-primary/10"
                onClick={loadCanvasList}
              >
                Retry
              </button>
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="rounded border border-red-800/60 bg-bg-card p-4 text-center shadow-xl">
              <div className="text-red-400 text-sm">Canvas unavailable: {error}</div>
              <button
                type="button"
                className="mt-3 rounded border border-primary/50 px-3 py-1 text-xs text-primary hover:bg-primary/10"
                onClick={() => setSnapshotRefreshKey((key) => key + 1)}
              >
                Retry
              </button>
            </div>
          </div>
        )}
        {!loading && !listError && !selectedId && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="text-center text-text-dim max-w-md">
              <div className="text-lg mb-2">No Canvas Selected</div>
              <div className="text-sm mb-3">
                Create one in-game: <code className="text-primary">canvas create mycanvas</code>
              </div>
              <div className="text-xs text-text-dim">
                Tip: the <span className="text-primary">guide</span> canvas has an interactive
                tutorial. Select it from the dropdown above.
              </div>
            </div>
          </div>
        )}
        {!loading && !error && selectedId && nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <div className="text-center text-text-dim max-w-sm">
              <div className="text-sm mb-2">This canvas is empty</div>
              <div className="text-xs space-y-1">
                <div>Drop files here to add them, or publish from the command line:</div>
                <div>
                  <code className="text-primary/70">canvas asset upload &lt;url&gt;</code>
                  {" then "}
                  <code className="text-primary/70">canvas publish image &lt;id&gt;</code>
                </div>
                <div className="mt-2 text-text-dim">
                  Double-click any node to set an intent or start a conversation.
                </div>
              </div>
            </div>
          </div>
        )}
        <ReactFlow
          nodes={displayNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onNodeDragStop={onNodeDragStop}
          onNodesDelete={onNodesDelete}
          onSelectionChange={onSelectionChange}
          onNodeDoubleClick={onNodeDoubleClick}
          onNodeContextMenu={onNodeContextMenu}
          onPaneClick={() => setContextMenu(null)}
          minZoom={0.1}
          maxZoom={4}
          proOptions={{ hideAttribution: true }}
          className="bg-bg"
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="var(--color-border)"
          />
          <Controls className="!bg-bg-hover !border-border !shadow-lg [&>button]:!bg-bg-hover [&>button]:!border-border [&>button]:!text-text [&>button:hover]:!bg-bg-hover" />
          <MiniMap
            className="!bg-bg-card !border-border"
            nodeColor="var(--color-primary)"
            maskColor="rgba(0,0,0,0.7)"
          />
        </ReactFlow>
      </div>

      {/* Detail panel — double-click a node to inspect */}
      <NodeDetailPanel
        node={detailNode}
        onClose={() => {
          setDetailNode(null);
          setSuggestedPrompt(undefined);
        }}
        canvasId={selectedId}
        onSetIntent={persistNodeData}
        onIntentActionResult={applyNodeDataSnapshot}
        nodes={nodes}
        suggestedPrompt={suggestedPrompt}
      />

      {/* Right-click context menu */}
      <AnimatePresence>
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            nodeId={contextMenu.nodeId}
            onSetIntent={() => {
              const node = nodes.find((n) => n.id === contextMenu.nodeId);
              if (node) setDetailNode(node);
            }}
            onDelete={() => deleteNodes([contextMenu.nodeId])}
            onClose={() => setContextMenu(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export function CanvasPage() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
