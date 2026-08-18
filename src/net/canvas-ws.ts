// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ServerWebSocket } from "bun";

/** Any WebSocket that has at least a canvasId field. */
type CanvasCompatibleWS = ServerWebSocket<{ canvasId?: string; [key: string]: unknown }>;

export type CanvasEvent =
  | { type: "node_added"; canvasId: string; node: Record<string, unknown> }
  | { type: "node_updated"; canvasId: string; nodeId: string; changes: Record<string, unknown> }
  | { type: "node_deleted"; canvasId: string; nodeId: string };

/**
 * Maintains WebSocket clients per canvas and broadcasts real-time events
 * when nodes are added, updated, or deleted.
 */
export class CanvasBroadcaster {
  private clients = new Map<string, Set<CanvasCompatibleWS>>();

  /** Register a new WebSocket client for a specific canvas. */
  addClient(ws: CanvasCompatibleWS, canvasId: string): void {
    if (!this.clients.has(canvasId)) {
      this.clients.set(canvasId, new Set());
    }
    this.clients.get(canvasId)!.add(ws);
  }

  /** Remove a WebSocket client. */
  removeClient(ws: CanvasCompatibleWS): void {
    for (const [, clients] of this.clients) {
      clients.delete(ws);
    }
  }

  /** Broadcast an event to all clients watching a specific canvas. */
  broadcast(event: CanvasEvent): void {
    const clients = this.clients.get(event.canvasId);
    if (!clients || clients.size === 0) return;

    const payload = JSON.stringify(event);
    for (const ws of clients) {
      try {
        if (ws.readyState === 1) {
          ws.send(payload);
        }
      } catch {
        clients.delete(ws);
      }
    }
  }

  /** Get connected client count for a canvas. */
  clientCount(canvasId: string): number {
    return this.clients.get(canvasId)?.size ?? 0;
  }

  /** Total connected clients across all canvases. */
  totalClients(): number {
    let total = 0;
    for (const [, clients] of this.clients) {
      total += clients.size;
    }
    return total;
  }
}
