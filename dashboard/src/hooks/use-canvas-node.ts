// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useCanvasEventSocket } from "../canvas/hooks/use-canvas-ws";
import type { CanvasNodeData } from "../canvas/lib/types";
import { authFetch, getToken } from "../lib/api";
import { apiOrigin } from "../lib/api-origin";
import { useChatState } from "./use-chat-state";

const API_BASE = apiOrigin();

function parseNodeData(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

export function useCanvasNode(canvasId?: string, nodeId?: string, active = true) {
  const resident = useChatState((s) => s.entityName);
  const loggedIn = useChatState((s) => s.loggedIn);
  const client = useQueryClient();
  const key = ["canvasNode", resident, loggedIn, getToken(), canvasId, nodeId];
  const socket = useCanvasEventSocket(active && canvasId && nodeId ? canvasId : null, (event) => {
    if (
      event.type === "canvas_deleted" ||
      (event.type === "node_deleted" && event.nodeId === nodeId)
    ) {
      client.setQueryData(key, null);
    } else if (event.type === "node_updated" && event.nodeId === nodeId && event.changes) {
      client.setQueryData(key, (current: CanvasNodeData | null | undefined) =>
        current && current.updated_at > event.changes!.updated_at ? current : event.changes,
      );
    }
  });
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(active && canvasId && nodeId),
    staleTime: 60_000,
    refetchInterval: active ? 15_000 : false,
    retry: false,
    queryFn: async ({ signal }): Promise<CanvasNodeData & { data: Record<string, unknown> }> => {
      const res = await authFetch(
        `${API_BASE}/api/canvases/${encodeURIComponent(canvasId!)}/nodes/${encodeURIComponent(nodeId!)}`,
        { signal },
      );
      if (!res.ok) {
        throw new Error(`Failed to load canvas node ${nodeId}: ${res.status}`);
      }
      const node = (await res.json()) as CanvasNodeData;
      return { ...node, data: parseNodeData(node.data) };
    },
  });
  const refetch = query.refetch;
  const markReady = socket.markReady;
  useEffect(() => {
    if (!active || !canvasId || !nodeId || !socket.connectionGeneration) return;
    let disposed = false;
    void refetch({ cancelRefetch: false }).then(() => {
      if (!disposed) markReady();
    });
    return () => {
      disposed = true;
    };
  }, [active, canvasId, nodeId, socket.connectionGeneration, refetch, markReady]);
  return query;
}
