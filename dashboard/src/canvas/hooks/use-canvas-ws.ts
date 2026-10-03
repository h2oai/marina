// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Node } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChatState } from "../../hooks/use-chat-state";
import { getToken } from "../../lib/api";
import type { CanvasEvent } from "../lib/canvas-events";
import { resyncCanvas, subscribeCanvas } from "../lib/canvas-subscription";

export { type CanvasEvent, parseCanvasEvent } from "../lib/canvas-events";

import { defaultSize, nextTilePosition } from "../lib/layout";
import { type CanvasNodeData, normalizeNodeType } from "../lib/types";

/**
 * Connection state of the canvas WebSocket. `live` means the socket is open;
 * `reconnecting` means we lost it and an automatic reconnect is in flight;
 * `idle` is the pre-connect / no-canvas state.
 */
export type CanvasWsStatus = "idle" | "live" | "reconnecting";

/**
 * Race-free fetch + live event stream.
 *
 * Realtime canvas state has to come from two sources: a snapshot (`/api/canvases/:id`)
 * and a live stream (`/canvas-ws`). Naïvely doing fetch-then-subscribe loses any
 * event that fires during the fetch round-trip. Subscribing first and then fetching
 * loses events that fire between subscribe and the first event handler attaching
 * IF we apply them before the snapshot lands.
 *
 * The correct shape is:
 *   1. Subscribe first; buffer every event.
 *   2. Fetch snapshot.
 *   3. Apply snapshot to state.
 *   4. Drain the buffer in arrival order, applying each event with merge logic
 *      that dedupes on node ID (existing wins for node_added, no-op on missing
 *      node for node_updated / node_deleted).
 *   5. Flip to live mode; subsequent events apply directly.
 *
 * `useCanvasEventSocket` exposes the buffering knobs so consumers control the
 * snapshot lifecycle (they're the ones doing the fetch). Until `markReady()`
 * is called, every event goes into the buffer and the apply callback isn't
 * invoked. After `markReady()`, the buffer drains in arrival order, then events
 * apply live.
 */
interface CanvasEventSocketHandle {
  /** Live connection status; drives the "Reconnecting…" badge in the UI. */
  status: CanvasWsStatus;
  /** Increments on every successful connection, including reconnects. */
  connectionGeneration: number;
  /**
   * Signal that the snapshot has been applied to state. Drains any buffered
   * events synchronously, then enters live mode. Idempotent.
   */
  markReady: () => void;
  /**
   * Reset the buffered/live state. Call before a fresh fetch (e.g. when the
   * canvas selector changes). Subsequent events buffer until `markReady()`.
   */
  resetForFetch: () => void;
}

export function useCanvasEventSocket(
  canvasId: string | null,
  onEvent: (event: CanvasEvent) => void,
): CanvasEventSocketHandle {
  const identity = useChatState((state) => `${state.loggedIn}:${state.entityName}`);
  const token = identity ? getToken() : null;
  const onEventRef = useRef(onEvent);
  const bufferRef = useRef<CanvasEvent[]>([]);
  const readyRef = useRef(false);
  const [status, setStatus] = useState<CanvasWsStatus>("idle");
  const [connectionGeneration, setConnectionGeneration] = useState(0);

  // Keep the latest handler without re-subscribing the socket on every render.
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const markReady = useCallback(() => {
    if (readyRef.current) return;
    const buffered = bufferRef.current;
    bufferRef.current = [];
    readyRef.current = true;
    for (const ev of buffered) onEventRef.current(ev);
  }, []);

  const resetForFetch = useCallback(() => {
    // When a disconnect already put the socket into buffered mode, preserve
    // events received by the new subscription before the recovery fetch began.
    if (!readyRef.current) return;
    readyRef.current = false;
    bufferRef.current = [];
  }, []);

  useEffect(() => {
    if (!canvasId) {
      setStatus("idle");
      return;
    }
    bufferRef.current = [];
    readyRef.current = false;
    const release = subscribeCanvas(canvasId, token, {
      event(event) {
        if (!readyRef.current) {
          if (bufferRef.current.length >= 1024) {
            bufferRef.current = [];
            resyncCanvas(canvasId, token);
          } else bufferRef.current.push(event);
        } else onEventRef.current(event);
      },
      status(next) {
        setStatus(next);
        if (next === "live") setConnectionGeneration((generation) => generation + 1);
        else {
          readyRef.current = false;
          bufferRef.current = [];
        }
      },
    });
    return () => {
      release();
      bufferRef.current = [];
      readyRef.current = false;
    };
  }, [canvasId, token]);

  return { status, connectionGeneration, markReady, resetForFetch };
}

type SetNodes = React.Dispatch<React.SetStateAction<Node[]>>;

function toFlowNode(n: CanvasNodeData, existing: Node[]): Node {
  const type = normalizeNodeType(n.type);
  const ds = defaultSize(type);
  const isGenericDefault = n.width === 300 && n.height === 200;
  const w = isGenericDefault ? ds.w : n.width;
  const h = isGenericDefault ? ds.h : n.height;

  // Auto-tile new nodes that arrive at 0,0
  const needsTile = n.x === 0 && n.y === 0 && existing.length > 0;
  const pos = needsTile ? nextTilePosition(existing) : { x: n.x, y: n.y };

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
      canvas_id: n.canvas_id,
    },
    style: { width: w, height: h },
  };
}

/**
 * Standalone canvas page consumer: merges WS events into the React Flow node
 * state. Events are batched via rAF to avoid per-message renders.
 *
 * Returns the live connection status + `markReady()` — call `markReady` once
 * the initial snapshot has been applied so buffered events drain in order.
 */
export interface UseCanvasWsHandle {
  status: CanvasWsStatus;
  connectionGeneration: number;
  markReady: () => void;
  resetForFetch: () => void;
}

export function useCanvasWs(
  canvasId: string | null,
  setNodes: SetNodes,
  onCanvasEvent?: (event: CanvasEvent) => void,
): UseCanvasWsHandle {
  const pendingRef = useRef<CanvasEvent[]>([]);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      pendingRef.current = [];
    };
  }, []);

  const handle = useCanvasEventSocket(canvasId, (event) => {
    pendingRef.current.push(event);
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const events = pendingRef.current;
      if (events.length === 0) return;
      pendingRef.current = [];

      for (const event of events) onCanvasEvent?.(event);

      setNodes((prev) => {
        let nodes = prev;
        for (const ev of events) {
          if (ev.type === "node_added" && ev.node) {
            const nodeData = ev.node;
            if (nodes.some((n) => n.id === nodeData.id)) continue;
            nodes = [...nodes, toFlowNode(nodeData, nodes)];
          }

          if (ev.type === "node_updated" && ev.nodeId && ev.changes) {
            const c = ev.changes;
            const type = normalizeNodeType(c.type);
            const ds = defaultSize(type);
            const isGenericDefault = c.width === 300 && c.height === 200;
            const w = isGenericDefault ? ds.w : c.width;
            const h = isGenericDefault ? ds.h : c.height;
            const eid = ev.nodeId;

            nodes = nodes.map((n) => {
              if (n.id !== eid) return n;
              return {
                ...n,
                type,
                position: { x: c.x, y: c.y },
                data: {
                  ...c.data,
                  asset_id: c.asset_id,
                  creator_name: c.creator_name,
                  parent_node_id: c.parent_node_id,
                  created_at: c.created_at,
                  canvas_id: c.canvas_id,
                },
                style: { width: w, height: h },
              };
            });
          }

          if (ev.type === "node_deleted" && ev.nodeId) {
            const eid = ev.nodeId;
            nodes = nodes.filter((n) => n.id !== eid);
          }
        }
        return nodes;
      });
    });
  });

  return handle;
}
