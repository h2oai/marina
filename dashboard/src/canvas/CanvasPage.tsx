// Copyright 2025-2026 Marina Contributors
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
import { useCanvasWs } from "./hooks/use-canvas-ws";
import { animateLayout as animateLayoutUtil, springEntrance } from "./lib/animations";
import { defaultSize } from "./lib/layout";
import type { CanvasData } from "./lib/types";
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filteredIds, setFilteredIds] = useState<Set<string> | null>(null);
  const [dropping, setDropping] = useState(false);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();
  const prevNodeIdsRef = useRef<Set<string>>(new Set());

  // Load canvas list on mount — default to "global" canvas
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; selectedId guard prevents the initial choice from clobbering later selections
  useEffect(() => {
    fetchCanvases().then((list) => {
      setCanvasList(list);
      if (list.length > 0 && !selectedId) {
        const global = list.find((c) => c.name === "global");
        setSelectedId(global?.id ?? list[0]!.id);
      }
    });
  }, []);

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
  });

  const wsHandle = useCanvasWs(selectedId, setNodes);
  const wsStatus = wsHandle.status;
  wsHandleRef.current = wsHandle;

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

  // Derive edges from parent_node_id relationships, styled by type
  const edges = useMemo<Edge[]>(() => {
    const nodeIds = new Set(nodes.map((n) => n.id));
    return nodes
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
  }, [nodes]);

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
      <div className="flex items-center gap-3 px-4 py-2 bg-bg-card border-b border-border">
        <h1 className="text-primary font-bold text-sm tracking-wider">MARINA CANVAS</h1>
        <div className="w-px h-5 bg-bg-hover" />
        <select
          className="bg-bg-hover text-text text-sm rounded px-2 py-1 border border-border focus:outline-none focus:border-primary"
          value={selectedId ?? ""}
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
          <span className="text-xs text-text-dim">
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
        <div className="flex-1" />
        <SearchBar nodes={nodes} onFilterChange={onFilterChange} />
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
        {error && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="text-red-400 text-sm">Error: {error}</div>
          </div>
        )}
        {!loading && !selectedId && (
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
        {!loading && selectedId && nodes.length === 0 && (
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
          fitView
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
