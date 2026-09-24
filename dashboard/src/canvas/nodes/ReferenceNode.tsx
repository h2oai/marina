// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Handle, type NodeProps, NodeResizer, Position } from "@xyflow/react";
import { parseCanvasReference, ReferenceContent } from "../../components/CanvasReference";
import { TextNode } from "./TextNode";

export function ReferenceNode(props: NodeProps) {
  const reference = parseCanvasReference(props.data.reference);
  if (!reference) return <TextNode {...props} />;
  return (
    <div className="h-full overflow-auto rounded-lg border border-primary/40 bg-bg-card p-4 text-text">
      <NodeResizer isVisible={props.selected} minWidth={240} minHeight={180} />
      <Handle type="target" position={Position.Top} />
      <ReferenceContent reference={reference} compact />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
