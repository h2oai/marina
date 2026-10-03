// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useCanvasNode } from "../hooks/use-canvas-node";
import type { DashboardPanelProps } from "../lib/panel-registry";
import { CanvasNodeEmbed } from "./CanvasNodeEmbed";
import { GlassPanel } from "./GlassPanel";

export function PublishedPanel({ binding, active = true, ...props }: DashboardPanelProps) {
  const target = binding?.kind === "canvas-node" ? binding : null;
  const query = useCanvasNode(target?.canvasId, target?.nodeId, active);
  const title =
    !query.isError && typeof query.data?.data.title === "string"
      ? query.data.data.title
      : "Published panel";
  return (
    <GlassPanel title="Published panel" {...props} viewTitle={title}>
      {target ? (
        <CanvasNodeEmbed canvasId={target.canvasId} nodeId={target.nodeId} active={active} />
      ) : (
        <p className="p-3 text-sm">
          This view has no target for the current resident. Open a published node from Canvas or
          Chat.
        </p>
      )}
    </GlassPanel>
  );
}
