// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * UnifiedCanvas configuration: the ReactFlow node and edge type registries,
 * canvas-content predicates, viewer routing and layer-visibility preferences.
 */

import type { EdgeTypes, Node, NodeTypes } from "@xyflow/react";
import { nodeTypes as canvasContentNodeTypes } from "../canvas/nodes";
import { FlowEdge } from "./edges/FlowEdge";
import { GraphLinkEdge } from "./edges/GraphLinkEdge";
import { InteractionArc } from "./edges/InteractionArc";
import { MemoryMapEdge } from "./edges/MemoryMapEdge";
import { RecallPath } from "./edges/RecallPath";
import { GraphNoteNode } from "./nodes/GraphNoteNode";
import { MemoryMapNode } from "./nodes/MemoryMapNode";
import { RoomNode } from "./nodes/RoomNode";
import type { ViewerContentType } from "./overlays/Viewer";

/**
 * Canvas content node types — every per-type renderer the standalone canvas
 * registers (text / image / video / pdf / audio / document / frame / a2ui /
 * embed) is also rendered in the unified surface, so node content is the same
 * across both views. The unified surface adds its own `room` and `graphNote`
 * overlays for the world-map and knowledge-graph layers.
 */
export const CANVAS_CONTENT_TYPES: ReadonlySet<string> = new Set(
  Object.keys(canvasContentNodeTypes),
);

/** True when this ReactFlow node hosts canvas content (vs. a room/graphNote overlay). */
export function isCanvasContentNode(type: string | undefined): boolean {
  return type !== undefined && CANVAS_CONTENT_TYPES.has(type);
}

/** Shape of `data` on canvas content nodes after useCanvasIntegration has populated it. */
export interface CanvasNodeMeta {
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
export const nodeTypes: NodeTypes = {
  ...canvasContentNodeTypes,
  room: RoomNode,
  graphNote: GraphNoteNode,
  memoryNode: MemoryMapNode,
};

/** Custom edge types registered with ReactFlow. */
export const edgeTypes: EdgeTypes = {
  flow: FlowEdge,
  interaction: InteractionArc,
  graphLink: GraphLinkEdge,
  recallPath: RecallPath,
  memoryEdge: MemoryMapEdge,
};

/** What the Viewer overlay shows for a canvas content node. */
export interface ViewerTarget {
  title: string;
  contentType: ViewerContentType;
  content: string | undefined;
}

/**
 * Viewer routing for a canvas content node: intent overlays use the dedicated
 * intent viewer (carrying the canvas and raw node ids for claim/complete/fail),
 * media types use their own renderer, anything else the placeholder.
 */
export function viewerTargetFor(node: Node): ViewerTarget {
  const data = node.data as CanvasNodeMeta;
  const nodeType = node.type as string;
  const intentMode = !!data.intent;
  const contentType = (
    intentMode
      ? "intent"
      : ["image", "video", "audio", "pdf", "document", "a2ui"].includes(nodeType)
        ? nodeType
        : "unknown"
  ) as ViewerContentType;
  if (intentMode && data.intent) {
    const rawNodeId = node.id.replace("canvas-", "");
    return {
      title: data.title ?? nodeType,
      contentType,
      content: JSON.stringify({ ...data.intent, canvasId: data.canvasId, nodeId: rawNodeId }),
    };
  }
  return { title: data.title ?? nodeType, contentType, content: data.url ?? undefined };
}

/**
 * Load a boolean layer-visibility preference from localStorage.
 * If the key has never been set (first visit), returns `firstVisitDefault`.
 */
export function loadLayerPref(key: string, firstVisitDefault: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return firstVisitDefault;
    return raw === "true";
  } catch {
    return firstVisitDefault;
  }
}

export function saveLayerPref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore — private mode, etc.
  }
}

/** Format seconds into short uptime display. */
export function formatUptimeShort(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}
