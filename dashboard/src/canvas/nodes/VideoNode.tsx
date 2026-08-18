// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { Handle, type NodeProps, NodeResizer, Position } from "@xyflow/react";
import { useState } from "react";
import { emptyAssetLabel } from "../lib/node-fields";
import { NodeMeta } from "./NodeMeta";

export function VideoNode({ data, selected }: NodeProps) {
  const url = (data.url as string) ?? "";
  const filename = (data.filename as string) ?? "Video";
  const mime = (data.mime as string) ?? "video/mp4";
  const [errored, setErrored] = useState(false);

  return (
    <div className="rounded-lg overflow-hidden bg-bg-card border border-purple-800/50 shadow-lg shadow-purple-900/20 h-full flex flex-col">
      <NodeResizer
        isVisible={!!selected}
        minWidth={200}
        minHeight={150}
        lineClassName="!border-purple-500/50"
        handleClassName="!w-2 !h-2 !bg-purple-500 !border-purple-400"
      />
      <Handle type="target" position={Position.Top} className="!bg-purple-500" />
      {url && !errored ? (
        // biome-ignore lint/a11y/useMediaCaption: user-uploaded video has no caption track
        <video
          controls
          className="nodrag w-full flex-1 object-contain bg-black"
          preload="metadata"
          onError={() => setErrored(true)}
        >
          <source src={url} type={mime} />
        </video>
      ) : (
        <div className="flex flex-col items-center justify-center flex-1 text-text-dim text-sm gap-1 px-2 text-center">
          <span>{emptyAssetLabel("video", errored)}</span>
          {errored && filename && (
            <span className="text-xs text-text-dim truncate max-w-full" title={filename}>
              {filename}
            </span>
          )}
        </div>
      )}
      {selected && <NodeMeta filename={filename} data={data} />}
      <Handle type="source" position={Position.Bottom} className="!bg-purple-500" />
    </div>
  );
}
