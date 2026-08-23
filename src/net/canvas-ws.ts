// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ServerWebSocket } from "bun";

/** Any WebSocket that has at least a canvasId field. */
type CanvasCompatibleWS = ServerWebSocket<{ canvasId?: string; [key: string]: unknown }>;

/**
 * Minimal canvas-scope lookup — the subset of MarinaDB the subscription gate
 * needs. Kept structural so canvas-ws stays decoupled from the persistence
 * layer and trivially testable.
 */
export interface CanvasScopeLookup {
  getCanvas(id: string): { scope: string; scope_id: string | null } | undefined;
}

/**
 * The authenticated principal behind a canvas WebSocket subscription. Populated
 * by the WS-upgrade layer from the resolved connection identity.
 */
export interface CanvasSubscriptionPrincipal {
  /**
   * Resolved in-world entity id (or an auth sentinel). Undefined for a fully
   * anonymous subscriber (no token, no dev bypass).
   */
  entityId?: string;
  /**
   * True when the principal is a trusted operator/admin (desktop operator
   * credential, sovereign-admin rank, or a granted operator gate) — may
   * subscribe to any canvas including other entities' private workspaces.
   */
  isOperator?: boolean;
}

/**
 * Decide whether `principal` may subscribe to real-time events for `canvasId`.
 *
 * Public/shared canvases (any scope other than per-entity) are an open
 * observability surface — the same content already streams over the dashboard
 * feed and renders on public /who pages — so anyone may subscribe. Per-entity
 * *private* workspaces (`scope === "entity"`) are restricted to their owner
 * (`scope_id`) or a trusted operator. An unknown canvas id is allowed: it
 * broadcasts nothing, so there is nothing to leak.
 */
export function authorizeCanvasSubscription(
  db: CanvasScopeLookup,
  canvasId: string,
  principal: CanvasSubscriptionPrincipal | undefined,
): boolean {
  const canvas = db.getCanvas(canvasId);
  if (!canvas) return true; // nonexistent canvas emits no events — nothing to leak
  if (canvas.scope !== "entity") return true; // public / shared surface
  if (principal?.isOperator) return true; // operator / admin
  return !!principal?.entityId && principal.entityId === canvas.scope_id; // owner only
}

export type CanvasEvent =
  | { type: "node_added"; canvasId: string; node: Record<string, unknown> }
  | { type: "node_updated"; canvasId: string; nodeId: string; changes: Record<string, unknown> }
  | { type: "node_deleted"; canvasId: string; nodeId: string }
  | {
      type: "edge_added";
      canvasId: string;
      edge: {
        id: string;
        sourceId: string;
        targetId: string;
        relationship: string;
        data: Record<string, unknown> | null;
        creatorName: string;
        createdAt: number;
      };
    }
  | { type: "edge_deleted"; canvasId: string; edgeId: string }
  | { type: "canvas_deleted"; canvasId: string };

/**
 * Maintains WebSocket clients per canvas and broadcasts real-time events
 * when nodes are added, updated, or deleted.
 */
export class CanvasBroadcaster {
  private clients = new Map<string, Set<CanvasCompatibleWS>>();

  /**
   * Register a new WebSocket client for a specific canvas.
   *
   * When `auth` is supplied, the subscription is authorized against the
   * connection's resolved principal via {@link authorizeCanvasSubscription};
   * a denied subscription is NOT registered and the method returns `false` so
   * the caller can close the socket. Omitting `auth` preserves the legacy
   * unauthenticated behavior for internal/trusted callers — the WS-upgrade
   * layer must always pass `auth` for network-facing subscriptions.
   */
  addClient(
    ws: CanvasCompatibleWS,
    canvasId: string,
    auth?: { db: CanvasScopeLookup; principal?: CanvasSubscriptionPrincipal },
  ): boolean {
    if (auth && !authorizeCanvasSubscription(auth.db, canvasId, auth.principal)) {
      return false;
    }
    if (!this.clients.has(canvasId)) {
      this.clients.set(canvasId, new Set());
    }
    this.clients.get(canvasId)!.add(ws);
    return true;
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
