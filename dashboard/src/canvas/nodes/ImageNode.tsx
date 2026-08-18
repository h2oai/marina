// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Handle, type NodeProps, NodeResizer, Position } from "@xyflow/react";
import { useState } from "react";
import { emptyAssetLabel } from "../lib/node-fields";
import { NodeMeta } from "./NodeMeta";

export function ImageNode({ data, selected }: NodeProps) {
  const url = (data.url as string) ?? "";
  const filename = (data.filename as string) ?? "Image";
  const [errored, setErrored] = useState(false);

  return (
    <div className="rounded-lg overflow-hidden bg-bg-card border border-primary/40 shadow-lg shadow-black/30 h-full">
      <NodeResizer
        isVisible={!!selected}
        minWidth={100}
        minHeight={80}
        lineClassName="!border-primary/50"
        handleClassName="!w-2 !h-2 !bg-primary !border-primary"
      />
      <Handle type="target" position={Position.Top} className="!bg-primary" />
      {url && !errored ? (
        <img
          src={url}
          alt={filename}
          className="w-full h-full object-cover"
          loading="lazy"
          onError={() => setErrored(true)}
        />
      ) : (
        <div className="flex flex-col items-center justify-center h-full text-text-dim text-sm gap-1 px-2 text-center">
          <span>{emptyAssetLabel("image", errored)}</span>
          {errored && filename && (
            <span className="text-xs text-text-dim truncate max-w-full" title={filename}>
              {filename}
            </span>
          )}
        </div>
      )}
      {selected && <NodeMeta filename={filename} data={data} />}
      <Handle type="source" position={Position.Bottom} className="!bg-primary" />
    </div>
  );
}
