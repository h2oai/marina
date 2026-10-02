// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { CanvasEdgeData, CanvasNodeData } from "./types";

export interface CanvasEvent {
  type:
    | "node_added"
    | "node_updated"
    | "node_deleted"
    | "edge_added"
    | "edge_deleted"
    | "canvas_deleted";
  canvasId: string;
  node?: CanvasNodeData;
  nodeId?: string;
  changes?: CanvasNodeData;
  edge?: CanvasEdgeData;
  edgeId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompleteNode(value: unknown): value is CanvasNodeData {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.canvas_id === "string" &&
    typeof value.type === "string" &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    typeof value.creator_name === "string" &&
    typeof value.created_at === "number" &&
    typeof value.updated_at === "number"
  );
}

/** Reject malformed or cross-subscription events before they can corrupt rendered state. */
export function parseCanvasEvent(payload: unknown, canvasId: string): CanvasEvent | null {
  if (!isRecord(payload) || payload.canvasId !== canvasId || typeof payload.type !== "string") {
    return null;
  }
  switch (payload.type) {
    case "node_added":
      return isCompleteNode(payload.node) ? (payload as unknown as CanvasEvent) : null;
    case "node_updated":
      return typeof payload.nodeId === "string" && isCompleteNode(payload.changes)
        ? (payload as unknown as CanvasEvent)
        : null;
    case "node_deleted":
      return typeof payload.nodeId === "string" ? (payload as unknown as CanvasEvent) : null;
    case "edge_added":
      return isRecord(payload.edge) &&
        typeof payload.edge.id === "string" &&
        typeof payload.edge.sourceId === "string" &&
        typeof payload.edge.targetId === "string" &&
        typeof payload.edge.relationship === "string"
        ? (payload as unknown as CanvasEvent)
        : null;
    case "edge_deleted":
      return typeof payload.edgeId === "string" ? (payload as unknown as CanvasEvent) : null;
    case "canvas_deleted":
      // The subscribed canvas itself is gone — the canvasId guard above
      // already ensured this event targets our subscription.
      return payload as unknown as CanvasEvent;
    default:
      return null;
  }
}
