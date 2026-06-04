/**
 * Hook that bridges canvas data into the unified world map view.
 *
 * Fetches canvas nodes for the "global" canvas via the existing API,
 * converts them to ReactFlow nodes positioned relative to their associated
 * room, and provides drag-drop upload support.
 *
 * Canvas nodes are auto-laid out in a ring around their associated room.
 * Edges are generated from canvas nodes to their rooms and from intent
 * nodes to claiming agents.
 */

import type { Edge, Node } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CanvasWsStatus, useCanvasEventSocket } from "../../canvas/hooks/use-canvas-ws";
import { defaultSize } from "../../canvas/lib/layout";
import type { CanvasData, CanvasEdgeData, CanvasNodeData } from "../../canvas/lib/types";
import { useWorldState } from "../../hooks/use-world-state";
import { authFetch } from "../../lib/api";
import { collisionRepulse, ringPosition } from "../lib/layout-utils";

/** Intent metadata attached to a canvas node's data field. */
export interface IntentMeta {
  status: "pending" | "active" | "done" | "failed";
  prompt?: string;
  claimedBy?: string;
  result?: string;
  failReason?: string;
}

const API_BASE = window.location.origin;

/** How long a newly-created canvas edge stays flashed (`activated: true`). */
const EDGE_FLASH_MS = 4000;

/** MIME prefix to canvas node type mapping. */
const MIME_TO_NODE_TYPE: Record<string, string> = {
  "image/": "image",
  "video/": "video",
  "audio/": "audio",
  "application/pdf": "pdf",
  "text/": "document",
};

/** Guess canvas node type from MIME type. */
function guessNodeType(mime: string): string {
  for (const [prefix, type] of Object.entries(MIME_TO_NODE_TYPE)) {
    if (mime.startsWith(prefix)) return type;
  }
  return "document";
}

/** Color assignments by node type and origin. */
function nodeColor(type: string, origin?: string): string {
  if (origin === "imported") return "#f472b6"; // rose
  switch (type) {
    case "intent":
      return "#06b6d4"; // cyan
    case "a2ui":
      return "#6366f1"; // indigo
    default:
      return "#8b5cf6"; // violet
  }
}

/** Extract intent data from a canvas node's data field. */
function getIntentData(n: CanvasNodeData): IntentMeta | undefined {
  const data = n.data as Record<string, unknown>;
  const intent = data.intent as
    | {
        status?: string;
        prompt?: string;
        claimedBy?: string;
        result?: string;
        failReason?: string;
      }
    | undefined;
  if (!intent) return undefined;
  return {
    status: (intent.status as "pending" | "active" | "done" | "failed") ?? "pending",
    prompt: intent.prompt,
    claimedBy: intent.claimedBy,
    result: intent.result,
    failReason: intent.failReason,
  };
}

/**
 * Determine which room a canvas node belongs to.
 * Falls back to the creator_name's current room or first available room.
 */
function resolveRoom(node: CanvasNodeData, roomIds: string[]): string | undefined {
  const data = node.data as Record<string, unknown>;
  // Check if room is explicitly set in data
  if (typeof data.room === "string" && roomIds.includes(data.room)) {
    return data.room;
  }
  // Fall back to first room if available
  return roomIds.length > 0 ? roomIds[0] : undefined;
}

/** Map of room ID to positions of canvas nodes assigned to that room. */
interface RoomNodeGroup {
  roomId: string;
  nodes: { canvasNode: CanvasNodeData; index: number }[];
}

/** Minimal canvas entry for the selector. */
export interface CanvasListEntry {
  id: string;
  name: string;
}

interface UseCanvasIntegrationResult {
  /** ReactFlow nodes for canvas items, positioned relative to rooms. */
  canvasNodes: Node[];
  /** ReactFlow edges: canvas-to-room links and intent-to-agent arcs. */
  canvasEdges: Edge[];
  /** Loading state. */
  loading: boolean;
  /** List of all available canvases for the selector. */
  canvasList: CanvasListEntry[];
  /** Currently active canvas ID. */
  activeCanvasId: string | null;
  /** Live connection status of the canvas WebSocket subscription. */
  wsStatus: CanvasWsStatus;
  /**
   * Handle file drop onto the canvas. Uploads each file as an asset, creates
   * a canvas node, and returns one descriptor per successfully-created node so
   * the caller can prompt for follow-up intents.
   */
  onDrop: (files: FileList, position: { x: number; y: number }) => Promise<DroppedFileResult[]>;
  /** Remove a canvas node from local state (after server delete). */
  removeNode: (nodeId: string) => void;
}

/**
 * Description of a file that was just dropped, uploaded, and turned into a
 * canvas node. Surfaces enough metadata for an intent prompt without forcing
 * the dialog to re-fetch the node.
 */
export interface DroppedFileResult {
  filename: string;
  mime: string;
  size: number;
  nodeId: string;
  canvasId: string;
}

/**
 * Bridge hook that fetches canvas data and converts it into
 * ReactFlow nodes/edges positioned relative to world rooms.
 *
 * @param roomPositions - Map of room IDs to their x,y positions in the flow.
 * @param roomIds - Array of all room IDs in the world.
 * @param entityRooms - Map of entity names to their current room IDs.
 * @param selectedCanvasId - Optional canvas ID override from the selector.
 */
export function useCanvasIntegration(
  roomPositions: Record<string, { x: number; y: number }>,
  roomIds: string[],
  entityRooms: Record<string, string>,
  selectedCanvasId?: string | null,
): UseCanvasIntegrationResult {
  const [canvasId, setCanvasId] = useState<string | null>(null);
  const [canvasList, setCanvasList] = useState<CanvasListEntry[]>([]);
  const [rawNodes, setRawNodes] = useState<CanvasNodeData[]>([]);
  const [rawEdges, setRawEdges] = useState<CanvasEdgeData[]>([]);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);
  const initialCanvasIdRef = useRef(selectedCanvasId);

  // Live canvas-node updates: merge node_added / node_updated / node_deleted
  // events from /canvas-ws into rawNodes so the unified surface reflects
  // realtime publishes without a page refresh. The socket subscribes first and
  // buffers events; we call `markReady` after the snapshot fetch resolves, so
  // events that arrived during the fetch round-trip apply in order without
  // being overwritten by stale snapshot data.
  //
  // Declared before the fetch effects so they can reference these handles.
  const {
    status: wsStatus,
    markReady: markWsReady,
    resetForFetch: resetWsBuffer,
  } = useCanvasEventSocket(canvasId, (event) => {
    if (event.type === "node_added" && event.node) {
      const node = event.node;
      setRawNodes((prev) => {
        if (prev.some((n) => n.id === node.id)) return prev;
        return [...prev, node];
      });
    } else if (event.type === "node_updated" && event.nodeId && event.changes) {
      const next = event.changes;
      const id = event.nodeId;
      setRawNodes((prev) => prev.map((n) => (n.id === id ? next : n)));
    } else if (event.type === "node_deleted" && event.nodeId) {
      const id = event.nodeId;
      setRawNodes((prev) => prev.filter((n) => n.id !== id));
    }
  });

  // Fetch canvas list on mount
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    const initialId = initialCanvasIdRef.current;
    resetWsBuffer();

    authFetch(`${API_BASE}/api/canvases`)
      .then((r) => {
        if (!r.ok) return [];
        return r.json() as Promise<CanvasData[]>;
      })
      .then((list) => {
        setCanvasList(list.map((c: CanvasData) => ({ id: c.id, name: c.name })));
        const target = initialId
          ? list.find((c: CanvasData) => c.id === initialId)
          : (list.find((c: CanvasData) => c.name === "global") ?? list[0]);
        if (!target) {
          setLoading(false);
          return;
        }
        setCanvasId(target.id);
        return authFetch(`${API_BASE}/api/canvases/${target.id}`);
      })
      .then((r) => {
        if (!r?.ok) {
          setLoading(false);
          return;
        }
        return r.json() as Promise<CanvasData>;
      })
      .then((data) => {
        if (data) {
          setRawNodes(data.nodes);
          setRawEdges(data.edges ?? []);
        }
        setLoading(false);
        markWsReady();
      })
      .catch(() => {
        setLoading(false);
        markWsReady();
      });
  }, [markWsReady, resetWsBuffer]);

  // Live canvas-edge updates: react to canvas_edge_created/deleted events
  // from the dashboard WS stream so edges appear without a page refresh.
  const eventFeed = useWorldState((s) => s.eventFeed);
  const lastSeenEdgeEventRef = useRef<number>(0);
  useEffect(() => {
    if (!canvasId) return;
    for (const event of eventFeed) {
      if (event.timestamp <= lastSeenEdgeEventRef.current) break;
      if (
        (event.type === "canvas_edge_created" || event.type === "canvas_edge_deleted") &&
        (event as unknown as { canvasId?: string }).canvasId === canvasId
      ) {
        if (event.type === "canvas_edge_created") {
          const e = event as unknown as {
            edgeId?: string;
            sourceId?: string;
            targetId?: string;
            relationship?: string;
            entity?: string;
            timestamp: number;
          };
          if (e.edgeId && e.sourceId && e.targetId && e.relationship) {
            setRawEdges((prev) => {
              if (prev.some((x) => x.id === e.edgeId)) return prev;
              return [
                ...prev,
                {
                  id: e.edgeId!,
                  sourceId: e.sourceId!,
                  targetId: e.targetId!,
                  relationship: e.relationship!,
                  data: null,
                  creatorName: e.entity ?? "unknown",
                  createdAt: e.timestamp,
                },
              ];
            });
          }
        } else {
          const e = event as unknown as { edgeId?: string };
          if (e.edgeId) {
            setRawEdges((prev) => prev.filter((x) => x.id !== e.edgeId));
          }
        }
      }
    }
    lastSeenEdgeEventRef.current = eventFeed[0]?.timestamp ?? lastSeenEdgeEventRef.current;
  }, [eventFeed, canvasId]);

  // Switch canvas when selectedCanvasId changes
  useEffect(() => {
    if (selectedCanvasId && selectedCanvasId !== canvasId) {
      setLoading(true);
      setCanvasId(selectedCanvasId);
      resetWsBuffer();
      authFetch(`${API_BASE}/api/canvases/${selectedCanvasId}`)
        .then((r) => {
          if (!r.ok) {
            setRawNodes([]);
            setRawEdges([]);
            setLoading(false);
            markWsReady();
            return;
          }
          return r.json() as Promise<CanvasData>;
        })
        .then((data) => {
          if (data) {
            setRawNodes(data.nodes);
            setRawEdges(data.edges ?? []);
          }
          setLoading(false);
          markWsReady();
        })
        .catch(() => {
          setRawNodes([]);
          setRawEdges([]);
          setLoading(false);
          markWsReady();
        });
    }
  }, [selectedCanvasId, canvasId, markWsReady, resetWsBuffer]);

  // Tick while any canvas edge is inside the flash window, so the
  // `activated: true` flag naturally expires without a page refresh.
  const [edgeFlashTick, setEdgeFlashTick] = useState(0);
  useEffect(() => {
    const cutoff = Date.now() - EDGE_FLASH_MS;
    const hasFresh = rawEdges.some((e) => e.createdAt > cutoff);
    if (!hasFresh) return;
    const interval = setInterval(() => setEdgeFlashTick((n) => n + 1), 500);
    return () => clearInterval(interval);
  }, [rawEdges]);

  // Group canvas nodes by room and compute positions
  // biome-ignore lint/correctness/useExhaustiveDependencies: edgeFlashTick drives re-derivation of `activated` flag
  const { canvasNodes, canvasEdges } = useMemo(() => {
    if (rawNodes.length === 0 || roomIds.length === 0) {
      return { canvasNodes: [] as Node[], canvasEdges: [] as Edge[] };
    }

    // Group nodes by room
    const groups: Record<string, RoomNodeGroup> = {};
    const assignedNodes: {
      canvasNode: CanvasNodeData;
      roomId: string;
      ringIndex: number;
    }[] = [];

    for (const cn of rawNodes) {
      const roomId = resolveRoom(cn, roomIds);
      if (!roomId) continue;

      if (!groups[roomId]) {
        groups[roomId] = { roomId, nodes: [] };
      }
      const idx = groups[roomId].nodes.length;
      groups[roomId].nodes.push({ canvasNode: cn, index: idx });
      assignedNodes.push({ canvasNode: cn, roomId, ringIndex: idx });
    }

    // Compute ring positions around each room
    const positions: { id: string; x: number; y: number }[] = [];
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    for (const assigned of assignedNodes) {
      const { canvasNode: cn, roomId, ringIndex } = assigned;
      const group = groups[roomId]!;
      const total = group.nodes.length;
      const roomPos = roomPositions[roomId];
      if (!roomPos) continue;

      // Use the node's stored position if it has one (from drag-drop), otherwise ring layout
      let absX: number;
      let absY: number;
      if (cn.x != null && cn.y != null && (cn.x !== 0 || cn.y !== 0)) {
        // Dropped at specific position — use it directly
        absX = cn.x;
        absY = cn.y;
      } else {
        // No position — arrange in ring around room
        const baseRadius = 180 + total * 20;
        const pos = ringPosition(ringIndex, total, baseRadius);
        absX = roomPos.x + pos.x;
        absY = roomPos.y + pos.y;
      }
      positions.push({ id: cn.id, x: absX, y: absY });

      const intentData = getIntentData(cn);
      const origin = (cn.data as Record<string, unknown>).origin as string | undefined;
      const color = nodeColor(cn.type, origin);
      const rawData = cn.data as Record<string, unknown>;

      // Emit per-type ReactFlow nodes so the unified surface uses the same
      // rich renderers (TextNode / ImageNode / VideoNode / …) the standalone
      // canvas page uses. Intent metadata rides on `data.intent` and the
      // shared `withIntent` HOC overlays the badge on every type.
      const nodeData: Record<string, unknown> = {
        ...rawData,
        asset_id: cn.asset_id,
        creator_name: cn.creator_name,
        parent_node_id: cn.parent_node_id,
        created_at: cn.created_at,
        canvas_id: cn.canvas_id,
        canvasId: cn.canvas_id,
        room: roomId,
        origin,
        color,
        intent: intentData,
        title: (rawData.title as string) ?? (rawData.filename as string) ?? cn.type,
        author: (rawData.author as string | undefined) ?? cn.creator_name,
      };

      const ds = defaultSize(cn.type);
      const isGenericDefault = cn.width === 300 && cn.height === 200;
      const w = isGenericDefault ? ds.w : cn.width;
      const h = isGenericDefault ? ds.h : cn.height;

      nodes.push({
        id: `canvas-${cn.id}`,
        type: cn.type,
        position: { x: absX, y: absY },
        data: nodeData,
        draggable: true,
        style: { width: w, height: h },
      });

      // Edge from canvas node to its room
      edges.push({
        id: `canvas-link-${cn.id}`,
        source: roomId,
        target: `canvas-${cn.id}`,
        type: "flow",
        data: { color, throughput: 0 },
        style: { stroke: color, strokeWidth: 0.8, opacity: 0.15 },
      });

      // If intent is active and claimed, draw arc to claiming agent's room
      if (intentData?.status === "active" && intentData.claimedBy) {
        const agentRoom = entityRooms[intentData.claimedBy];
        if (agentRoom && roomPositions[agentRoom]) {
          edges.push({
            id: `intent-arc-${cn.id}`,
            source: `canvas-${cn.id}`,
            target: agentRoom,
            type: "interaction",
            animated: true,
            data: { type: "task", createdAt: Date.now() },
            style: { stroke: "#06b6d4", strokeWidth: 1.5, opacity: 0.4 },
          });
        }
      }
    }

    // Apply collision repulsion
    collisionRepulse(positions, 4, 100);

    // Update node positions after repulsion
    for (let i = 0; i < nodes.length; i++) {
      const pos = positions[i];
      if (pos) {
        nodes[i]!.position = { x: pos.x, y: pos.y };
      }
    }

    // First-class typed edges (canvas_edges) — rendered with the graphLink edge type.
    // Both endpoints must be rendered canvas nodes; otherwise skip (they may be on
    // a canvas we're not currently displaying, which happens for cross-canvas refs).
    // Edges created in the last EDGE_FLASH_MS get `activated: true` so the reader
    // sees *which* edge just appeared — content over motion applied to causality.
    const renderedNodeIds = new Set(nodes.map((n) => n.id));
    const flashCutoff = Date.now() - EDGE_FLASH_MS;
    for (const e of rawEdges) {
      const src = `canvas-${e.sourceId}`;
      const tgt = `canvas-${e.targetId}`;
      if (!renderedNodeIds.has(src) || !renderedNodeIds.has(tgt)) continue;
      edges.push({
        id: `canvas-edge-${e.id}`,
        source: src,
        target: tgt,
        type: "graphLink",
        data: { relationship: e.relationship, activated: e.createdAt > flashCutoff },
      });
    }

    // Thread edges: reply chains follow parent_node_id. Distinct from the
    // typed canvas_edges — these are "A is a reply to B", rendered as a soft
    // curve in violet so conversations read visually as threads.
    for (const cn of rawNodes) {
      if (!cn.parent_node_id) continue;
      const src = `canvas-${cn.parent_node_id}`;
      const tgt = `canvas-${cn.id}`;
      if (!renderedNodeIds.has(src) || !renderedNodeIds.has(tgt)) continue;
      edges.push({
        id: `thread-${cn.id}`,
        source: src,
        target: tgt,
        type: "graphLink",
        data: { relationship: "part_of" },
      });
    }

    // Intent → result causal arcs: when a completed intent references its
    // result node (data.intent.resultNodeId), draw an animated arc from the
    // intent node to the result node. Closes the "request → fulfillment" loop.
    for (const cn of rawNodes) {
      const data = cn.data as Record<string, unknown>;
      const intent = data.intent as { resultNodeId?: string } | undefined;
      if (!intent?.resultNodeId) continue;
      const src = `canvas-${cn.id}`;
      const tgt = `canvas-${intent.resultNodeId}`;
      if (!renderedNodeIds.has(src) || !renderedNodeIds.has(tgt)) continue;
      edges.push({
        id: `intent-result-${cn.id}`,
        source: src,
        target: tgt,
        type: "graphLink",
        data: { relationship: "derived_from", activated: true },
      });
    }

    return { canvasNodes: nodes, canvasEdges: edges };
  }, [rawNodes, rawEdges, roomIds, roomPositions, entityRooms, edgeFlashTick]);

  // Drag-drop upload handler. Returns one descriptor per successfully-created
  // node so the caller can prompt the user for an intent on each.
  const onDrop = useCallback(
    async (files: FileList, position: { x: number; y: number }): Promise<DroppedFileResult[]> => {
      let targetCanvasId = canvasId;

      // Auto-create a canvas if none exists — drag-and-drop is a first-class
      // entry point, so the user shouldn't have to set up scaffolding first.
      if (!targetCanvasId) {
        try {
          const createRes = await authFetch(`${API_BASE}/api/canvases`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "global" }),
          });
          if (createRes.ok) {
            const created = (await createRes.json()) as { id: string; name: string };
            targetCanvasId = created.id;
            setCanvasId(created.id);
            setCanvasList((prev) => [...prev, { id: created.id, name: created.name }]);
          } else {
            return [];
          }
        } catch {
          return [];
        }
      }

      const results: DroppedFileResult[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const nodeType = guessNodeType(file.type);
        const dropX = position.x + i * 120;
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
          const asset = (await uploadRes.json()) as { id: string; url: string };

          // 2. Create node on canvas
          const res = await authFetch(`${API_BASE}/api/canvases/${targetCanvasId}/nodes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: nodeType,
              asset_id: asset.id,
              x: dropX,
              y: dropY,
              width: 100,
              height: 80,
              creator_name: "canvas-drop",
              data: {
                url: asset.url,
                filename: file.name,
                mime: file.type,
                origin: "imported",
                title: file.name,
                author: "canvas-drop",
                feedType: "manual",
              },
            }),
          });
          if (!res.ok) continue;

          const newNode = (await res.json()) as CanvasNodeData;
          setRawNodes((prev) => [...prev, newNode]);
          results.push({
            filename: file.name,
            mime: file.type || "application/octet-stream",
            size: file.size,
            nodeId: newNode.id,
            canvasId: targetCanvasId!,
          });
        } catch {
          // Continue with remaining files
        }
      }
      return results;
    },
    [canvasId],
  );

  const removeNode = useCallback((nodeId: string) => {
    setRawNodes((prev) => prev.filter((n) => n.id !== nodeId));
  }, []);

  return {
    canvasNodes,
    canvasEdges,
    loading,
    canvasList,
    activeCanvasId: canvasId,
    wsStatus,
    onDrop,
    removeNode,
  };
}

// ── Intent Action Helpers ──────────────────────────────────────────────────

/**
 * Generic helper that patches intent data on a canvas node.
 * Fetches the current node data, merges the intent update, and PATCHes back.
 */
async function updateIntent(
  canvasId: string,
  nodeId: string,
  intentUpdate: Record<string, unknown>,
): Promise<void> {
  const resp = await authFetch(`${API_BASE}/api/canvases/${canvasId}/nodes/${nodeId}`);
  if (!resp.ok) throw new Error(`Failed to fetch node: ${resp.status}`);
  const node = await resp.json();
  const data = typeof node.data === "string" ? JSON.parse(node.data) : (node.data ?? {});
  data.intent = { ...data.intent, ...intentUpdate };
  const patchResp = await authFetch(`${API_BASE}/api/canvases/${canvasId}/nodes/${nodeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: JSON.stringify(data) }),
  });
  if (!patchResp.ok) throw new Error(`Failed to update intent: ${patchResp.status}`);
}

/** Claim a pending intent for the given user. */
export async function claimIntent(
  canvasId: string,
  nodeId: string,
  username: string,
): Promise<void> {
  await updateIntent(canvasId, nodeId, {
    status: "active",
    claimedBy: username,
    claimedAt: Date.now(),
  });
}

/** Complete an active intent with a result string. */
export async function completeIntent(
  canvasId: string,
  nodeId: string,
  result: string,
): Promise<void> {
  await updateIntent(canvasId, nodeId, { status: "done", result });
}

/** Fail an active intent with a reason string. */
export async function failIntent(canvasId: string, nodeId: string, reason: string): Promise<void> {
  await updateIntent(canvasId, nodeId, { status: "failed", failReason: reason });
}
