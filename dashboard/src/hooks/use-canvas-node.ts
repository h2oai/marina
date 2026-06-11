import { useQuery } from "@tanstack/react-query";
import type { CanvasNodeData } from "../canvas/lib/types";
import { authFetch } from "../lib/api";

const API_BASE = window.location.origin;

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

export function useCanvasNode(canvasId?: string, nodeId?: string) {
  return useQuery({
    queryKey: ["canvasNode", canvasId, nodeId],
    enabled: Boolean(canvasId && nodeId),
    staleTime: 60_000,
    queryFn: async (): Promise<CanvasNodeData & { data: Record<string, unknown> }> => {
      const res = await authFetch(`${API_BASE}/api/canvases/${canvasId}/nodes/${nodeId}`);
      if (!res.ok) {
        throw new Error(`Failed to load canvas node ${nodeId}: ${res.status}`);
      }
      const node = (await res.json()) as CanvasNodeData;
      return { ...node, data: parseNodeData(node.data) };
    },
  });
}
