import { Handle, type NodeProps, NodeResizer, Position } from "@xyflow/react";

export function FrameNode({ data, selected }: NodeProps) {
  const label = (data.label as string) ?? (data.title as string) ?? "Frame";
  const color = (data.color as string) ?? "#374151";

  return (
    <div
      className="rounded-xl border-2 border-dashed h-full flex flex-col"
      style={{ borderColor: color, backgroundColor: `${color}15` }}
    >
      <NodeResizer
        isVisible={!!selected}
        minWidth={200}
        minHeight={100}
        lineClassName="!border-yellow-500/50"
        handleClassName="!w-2 !h-2 !bg-yellow-500 !border-yellow-400"
      />
      <Handle type="target" position={Position.Top} className="!bg-yellow-500" />
      <div className="px-3 py-1 text-xs font-bold uppercase tracking-wider" style={{ color }}>
        {label}
      </div>
      <div className="flex-1" />
      <Handle type="source" position={Position.Bottom} className="!bg-yellow-500" />
    </div>
  );
}
