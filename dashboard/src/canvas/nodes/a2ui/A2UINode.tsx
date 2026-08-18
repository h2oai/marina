// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { Handle, type NodeProps, NodeResizer, Position } from "@xyflow/react";
import { useCallback } from "react";
import { authFetch } from "../../../lib/api";
import { NodeMeta } from "../NodeMeta";
import { A2UIRenderer } from "./A2UIRenderer";
import type { A2UIAction, A2UINodeData } from "./types";

const API_BASE = window.location.origin;

export function A2UINode({ data, id, selected }: NodeProps) {
  const canvasId = data.canvas_id as string | undefined;
  const title = (data.title as string) ?? "A2UI";
  const nodeData: A2UINodeData = {
    components: (data.components as A2UINodeData["components"]) ?? [],
    rootId: data.rootId as string | undefined,
    dataModel: data.dataModel as Record<string, unknown> | undefined,
  };

  const handleAction = useCallback(
    async (action: A2UIAction) => {
      if (!canvasId) return;
      try {
        await authFetch(`${API_BASE}/api/canvases/${canvasId}/nodes/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            data: {
              ...data,
              lastAction: {
                name: action.event.name,
                payload: action.event.payload,
                timestamp: Date.now(),
              },
            },
          }),
        });
      } catch {
        // Silent fail — same pattern as DocumentNode
      }
    },
    [canvasId, id, data],
  );

  return (
    <div className="rounded-lg overflow-hidden bg-bg-card border border-indigo-800/50 shadow-lg shadow-indigo-900/20 flex flex-col h-full">
      <NodeResizer
        isVisible={!!selected}
        minWidth={200}
        minHeight={120}
        lineClassName="!border-indigo-500/50"
        handleClassName="!w-2 !h-2 !bg-indigo-500 !border-indigo-400"
      />
      <Handle type="target" position={Position.Top} className="!bg-indigo-500" />
      {selected && (
        <NodeMeta filename={title} data={data as Record<string, unknown>} className="mb-1" />
      )}
      <div className="flex-1 p-3 overflow-auto">
        <A2UIRenderer nodeData={nodeData} onAction={handleAction} />
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-indigo-500" />
    </div>
  );
}
