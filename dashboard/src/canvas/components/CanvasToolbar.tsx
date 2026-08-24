// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Node } from "@xyflow/react";
import { motion } from "motion/react";
import { authFetch } from "../../lib/api";
import { defaultSize } from "../lib/layout";

const HOVER = { scale: 1.05 };
const TAP = { scale: 0.95 };

interface CanvasToolbarProps {
  canvasId: string | null;
  nodes: Node[];
  selectedCount?: number;
  onConnect?: () => void;
  onMutationError?: (message: string) => void;
  onDelete?: () => void;
  onAnimateLayout?: (
    targetMap: Map<string, { x: number; y: number; w: number; h: number }>,
  ) => Promise<void>;
}

const API_BASE = window.location.origin;

export function CanvasToolbar({
  canvasId,
  nodes,
  selectedCount = 0,
  onDelete,
  onConnect,
  onMutationError,
  onAnimateLayout,
}: CanvasToolbarProps) {
  const exportCanvas = () => {
    if (!canvasId) return;
    const data = {
      canvasId,
      exportedAt: new Date().toISOString(),
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
        style: n.style,
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `canvas-${canvasId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const layoutGrid = async () => {
    if (!canvasId) return;
    const cols = 4;
    const gap = 20;
    const cellW = 420;
    const cellH = 500;

    // Compute target positions
    const targetMap = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * (cellW + gap);
      const y = row * (cellH + gap);
      const size = defaultSize(node.type ?? "text");
      targetMap.set(node.id, { x, y, w: size.w, h: size.h });
    }

    // Animate first, then persist
    if (onAnimateLayout) {
      await onAnimateLayout(targetMap);
    }

    // Persist to backend
    let failures = 0;
    for (const [nodeId, target] of targetMap) {
      try {
        const response = await authFetch(`${API_BASE}/api/canvases/${canvasId}/nodes/${nodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            x: target.x,
            y: target.y,
            width: target.w,
            height: target.h,
          }),
        });
        if (!response.ok) failures++;
      } catch {
        failures++;
      }
    }
    if (failures > 0)
      onMutationError?.(
        `Could not save the grid layout for ${failures} node${failures === 1 ? "" : "s"}.`,
      );
  };

  const layoutTimeline = async () => {
    if (!canvasId) return;
    const sorted = [...nodes].sort((a, b) => {
      const aTime = (a.data.created_at as number) ?? 0;
      const bTime = (b.data.created_at as number) ?? 0;
      return aTime - bTime;
    });

    const gap = 40;
    let x = 0;

    // Compute target positions
    const targetMap = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (let i = 0; i < sorted.length; i++) {
      const node = sorted[i]!;
      const size = defaultSize(node.type ?? "text");
      targetMap.set(node.id, { x, y: 0, w: size.w, h: size.h });
      x += size.w + gap;
    }

    // Animate first, then persist
    if (onAnimateLayout) {
      await onAnimateLayout(targetMap);
    }

    // Persist to backend
    let failures = 0;
    for (const [nodeId, target] of targetMap) {
      try {
        const response = await authFetch(`${API_BASE}/api/canvases/${canvasId}/nodes/${nodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            x: target.x,
            y: target.y,
            width: target.w,
            height: target.h,
          }),
        });
        if (!response.ok) failures++;
      } catch {
        failures++;
      }
    }
    if (failures > 0)
      onMutationError?.(
        `Could not save the timeline layout for ${failures} node${failures === 1 ? "" : "s"}.`,
      );
  };

  return (
    <div className="flex items-center gap-1">
      <motion.button
        type="button"
        onClick={exportCanvas}
        disabled={!canvasId}
        whileHover={HOVER}
        whileTap={TAP}
        className="text-xs text-text hover:text-text-bright bg-bg-hover px-2 py-1 rounded border border-border disabled:opacity-30"
        title="Export canvas as JSON"
      >
        Export
      </motion.button>
      <motion.button
        type="button"
        onClick={layoutGrid}
        disabled={!canvasId || nodes.length === 0}
        whileHover={HOVER}
        whileTap={TAP}
        className="text-xs text-text hover:text-text-bright bg-bg-hover px-2 py-1 rounded border border-border disabled:opacity-30"
        title="Arrange nodes in a grid"
      >
        Grid
      </motion.button>
      <motion.button
        type="button"
        onClick={layoutTimeline}
        disabled={!canvasId || nodes.length === 0}
        whileHover={HOVER}
        whileTap={TAP}
        className="text-xs text-text hover:text-text-bright bg-bg-hover px-2 py-1 rounded border border-border disabled:opacity-30"
        title="Arrange nodes in a timeline"
      >
        Timeline
      </motion.button>
      {selectedCount > 0 && onDelete && (
        <motion.button
          type="button"
          onClick={onDelete}
          whileHover={HOVER}
          whileTap={TAP}
          className="text-xs text-red-400 hover:text-red-200 bg-bg-hover px-2 py-1 rounded border border-red-900/50 hover:border-red-700"
          title={`Delete ${selectedCount} selected node${selectedCount > 1 ? "s" : ""}`}
        >
          Delete ({selectedCount})
        </motion.button>
      )}
      {selectedCount === 2 && onConnect && (
        <motion.button
          type="button"
          onClick={onConnect}
          whileHover={HOVER}
          whileTap={TAP}
          className="text-xs text-cyan-300 hover:text-cyan-100 bg-bg-hover px-2 py-1 rounded border border-cyan-900/60 hover:border-cyan-700"
          title="Create a typed relationship between the two selected nodes"
        >
          Connect
        </motion.button>
      )}
    </div>
  );
}
