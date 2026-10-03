// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Handle, type NodeProps, NodeResizer, Position } from "@xyflow/react";
import { InteractivePanel } from "../../../components/InteractivePanel";
import { NodeMeta } from "../NodeMeta";

export function A2UINode({ data, id, selected }: NodeProps) {
  const canvasId = data.canvas_id as string | undefined;
  const title = (data.title as string) ?? "A2UI";
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
        <InteractivePanel canvasId={canvasId} nodeId={id} data={data} />
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-indigo-500" />
    </div>
  );
}
