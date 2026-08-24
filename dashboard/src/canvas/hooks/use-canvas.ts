// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Node, NodeChange } from "@xyflow/react";
import { applyNodeChanges } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "../../lib/api";
import { defaultSize, tilePosition } from "../lib/layout";
import { type CanvasData, type CanvasNodeData, normalizeNodeType } from "../lib/types";

const API_BASE = window.location.origin;

function toFlowNode(n: CanvasNodeData, index: number): Node {
  const type = normalizeNodeType(n.type);
  const ds = defaultSize(type);

  // Use stored dimensions if they differ from the old 300×200 default,
  // otherwise use the type-specific default
  const isGenericDefault = n.width === 300 && n.height === 200;
  const w = isGenericDefault ? ds.w : n.width;
  const h = isGenericDefault ? ds.h : n.height;

  // Auto-tile: if position is 0,0 and not the first node, use tiling
  const needsTile = n.x === 0 && n.y === 0 && index > 0;
  const pos = needsTile ? tilePosition(index) : { x: n.x, y: n.y };

  return {
    id: n.id,
    type,
    position: pos,
    data: {
      ...n.data,
      asset_id: n.asset_id,
      creator_name: n.creator_name,
      parent_node_id: n.parent_node_id,
      created_at: n.created_at,
      updated_at: n.updated_at,
      canvas_id: n.canvas_id,
    },
    style: { width: w, height: h },
  };
}

/**
 * Optional lifecycle hooks for race-free coordination with the canvas WS.
 *
 * `onBeforeFetch` fires synchronously before the snapshot request goes out;
 * `onSnapshotReady` fires once the snapshot has been applied to state. Use
 * these to flip a buffer into "drain mode" so events that arrived during the
 * fetch land in order without overwriting newer data.
 */
interface UseCanvasOptions {
  onBeforeFetch?: () => void;
  onSnapshotReady?: () => void;
  /** Change to request a fresh snapshot without changing canvases. */
  refreshKey?: number;
  onMutationError?: (message: string) => void;
}

export function useCanvas(canvasId: string | null, options: UseCanvasOptions = {}) {
  const [canvas, setCanvas] = useState<CanvasData | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const onBeforeFetchRef = useRef(options.onBeforeFetch);
  const onSnapshotReadyRef = useRef(options.onSnapshotReady);
  const previousCanvasIdRef = useRef<string | null>(null);
  const refreshKey = options.refreshKey;
  const onMutationErrorRef = useRef(options.onMutationError);

  useEffect(() => {
    onBeforeFetchRef.current = options.onBeforeFetch;
    onSnapshotReadyRef.current = options.onSnapshotReady;
    onMutationErrorRef.current = options.onMutationError;
  }, [options.onBeforeFetch, options.onSnapshotReady, options.onMutationError]);

  // Fetch canvas data
  useEffect(() => {
    // Reading the key makes the recovery refresh an explicit effect input.
    void refreshKey;
    if (!canvasId) {
      setCanvas(null);
      setNodes([]);
      setError(null);
      setLoading(false);
      previousCanvasIdRef.current = null;
      return;
    }
    if (previousCanvasIdRef.current !== canvasId) {
      setCanvas(null);
      setNodes([]);
      setError(null);
      previousCanvasIdRef.current = canvasId;
    }
    setLoading(true);
    onBeforeFetchRef.current?.();
    authFetch(`${API_BASE}/api/canvases/${canvasId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: CanvasData) => {
        setCanvas(data);
        setNodes(data.nodes.map((n, i) => toFlowNode(n, i)));
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => {
        // A failed snapshot is still a completed snapshot attempt. Release the
        // live-event buffer so recovery events do not remain queued forever.
        onSnapshotReadyRef.current?.();
        setLoading(false);
      });
  }, [canvasId, refreshKey]);

  // Handle node position/size changes (from drag or resize)
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  // Persist position change to backend
  const persistNodePosition = useCallback(
    async (nodeId: string, x: number, y: number) => {
      if (!canvasId) return;
      try {
        const response = await authFetch(`${API_BASE}/api/canvases/${canvasId}/nodes/${nodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ x, y }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch {
        onMutationErrorRef.current?.("Could not save the node position. The canvas was refreshed.");
      }
    },
    [canvasId],
  );

  // Persist size change to backend
  const persistNodeSize = useCallback(
    async (nodeId: string, width: number, height: number) => {
      if (!canvasId) return;
      try {
        const response = await authFetch(`${API_BASE}/api/canvases/${canvasId}/nodes/${nodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ width: Math.round(width), height: Math.round(height) }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch {
        onMutationErrorRef.current?.("Could not save the node size. The canvas was refreshed.");
      }
    },
    [canvasId],
  );

  // Persist arbitrary data changes to a node.
  // Strips metadata fields injected by toFlowNode / API enrichment so they
  // don't pollute the DB data column. Applies optimistic local update immediately.
  const persistNodeData = useCallback(
    async (nodeId: string, data: Record<string, unknown>) => {
      if (!canvasId) return;
      const { canvas_id, creator_name, created_at, updated_at, asset_id, ...clean } = data;

      let previousData: Record<string, unknown> | undefined;
      // Optimistic local update — badge appears immediately
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== nodeId) return n;
          previousData = n.data;
          return { ...n, data: { ...n.data, ...clean } };
        }),
      );

      try {
        const res = await authFetch(`${API_BASE}/api/canvases/${canvasId}/nodes/${nodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: clean }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        if (previousData) {
          setNodes((prev) =>
            prev.map((node) => (node.id === nodeId ? { ...node, data: previousData! } : node)),
          );
        }
        onMutationErrorRef.current?.(
          "Could not save the node changes. Your previous content was restored.",
        );
      }
    },
    [canvasId],
  );

  // Delete nodes from canvas
  const deleteNodes = useCallback(
    async (nodeIds: string[]) => {
      if (!canvasId || nodeIds.length === 0) return;
      // Snapshot for rollback on failure
      let snapshot: Node[] | null = null;
      setNodes((nds) => {
        snapshot = nds;
        return nds.filter((n) => !nodeIds.includes(n.id));
      });
      const failed: string[] = [];
      for (const nodeId of nodeIds) {
        try {
          const res = await authFetch(`${API_BASE}/api/canvases/${canvasId}/nodes/${nodeId}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            if (import.meta.env.DEV) console.warn(`[canvas] node DELETE failed: ${res.status}`);
            failed.push(nodeId);
          }
        } catch (err) {
          if (import.meta.env.DEV) console.warn("[canvas] node DELETE error:", err);
          failed.push(nodeId);
        }
      }
      // Restore any nodes whose DELETE did not succeed
      if (failed.length > 0 && snapshot) {
        const restore = (snapshot as Node[]).filter((n) => failed.includes(n.id));
        setNodes((nds) => [...nds, ...restore]);
        onMutationErrorRef.current?.(
          `Could not delete ${failed.length} node${failed.length === 1 ? "" : "s"}. ${failed.length === 1 ? "It was" : "They were"} restored.`,
        );
      }
    },
    [canvasId],
  );

  return {
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
  };
}

/** Fetch list of all canvases */
export async function fetchCanvases(): Promise<CanvasData[]> {
  const r = await authFetch(`${API_BASE}/api/canvases`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
