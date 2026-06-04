import { Handle, type NodeProps, NodeResizer, Position } from "@xyflow/react";
import { useState } from "react";
import { emptyAssetLabel } from "../lib/node-fields";
import { NodeMeta } from "./NodeMeta";

export function ImageNode({ data, selected }: NodeProps) {
  const url = (data.url as string) ?? "";
  const filename = (data.filename as string) ?? "Image";
  const [errored, setErrored] = useState(false);

  return (
    <div className="rounded-lg overflow-hidden bg-gray-900 border border-cyan-800/50 shadow-lg shadow-cyan-900/20 h-full">
      <NodeResizer
        isVisible={!!selected}
        minWidth={100}
        minHeight={80}
        lineClassName="!border-cyan-500/50"
        handleClassName="!w-2 !h-2 !bg-cyan-500 !border-cyan-400"
      />
      <Handle type="target" position={Position.Top} className="!bg-cyan-500" />
      {url && !errored ? (
        <img
          src={url}
          alt={filename}
          className="w-full h-full object-cover"
          loading="lazy"
          onError={() => setErrored(true)}
        />
      ) : (
        <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm gap-1 px-2 text-center">
          <span>{emptyAssetLabel("image", errored)}</span>
          {errored && filename && (
            <span className="text-xs text-gray-600 truncate max-w-full" title={filename}>
              {filename}
            </span>
          )}
        </div>
      )}
      {selected && <NodeMeta filename={filename} data={data} />}
      <Handle type="source" position={Position.Bottom} className="!bg-cyan-500" />
    </div>
  );
}
