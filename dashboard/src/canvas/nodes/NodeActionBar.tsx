// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { PanelsTopLeft, Wand2 } from "lucide-react";

import { openBoundPanel } from "../../lib/panel-bindings";

/**
 * Small hover-reveal action bar overlaid on canvas nodes.
 * Uses Tailwind `group-hover` — parent must have `group` class.
 * Dispatches a custom event so CanvasPage can open the detail panel.
 */
export function NodeActionBar({ nodeId, canvasId }: { nodeId: string; canvasId?: string }) {
  return (
    <div className="absolute bottom-1 right-1 z-10 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex gap-1">
      {canvasId && (
        <button
          type="button"
          aria-label="Open as panel"
          title="Open as panel"
          className="nodrag rounded border border-border bg-bg-hover/90 p-1 text-primary"
          onClick={(event) => {
            event.stopPropagation();
            openBoundPanel({ kind: "canvas-node", canvasId, nodeId });
          }}
        >
          <PanelsTopLeft size={14} />
        </button>
      )}
      <button
        type="button"
        className="bg-bg-hover/90 border border-border rounded p-1 text-text hover:text-primary transition-colors"
        title="Set intent — ask an agent to do something with this"
        onClick={(e) => {
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("marina:open-detail", { detail: { nodeId } }));
        }}
      >
        <Wand2 size={14} />
      </button>
    </div>
  );
}
