// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * LayerChips — the WORLD · CANVAS · GRAPH · FEED · MEMORY toggle bar in the
 * top-left of the unified canvas.
 *
 * Extracted mechanically from UnifiedCanvas.tsx. Props in (current visibility
 * map), callbacks out (`onToggle` for a click, `onSolo` for shift-click). The
 * motion animate/hover/tap behavior is unchanged. Each chip exposes
 * `aria-pressed` so the toggle state is available without color.
 */

import { motion } from "motion/react";
import { memo } from "react";
import { applyLayerKey, type LayerVisibility } from "../lib/memory-map-layer";

export type LayerId = keyof LayerVisibility;

/** Chip order, key number and accent colour — 1=World … 5=Memory. */
export const LAYER_CHIPS: ReadonlyArray<{
  id: LayerId;
  label: string;
  num: 1 | 2 | 3 | 4 | 5;
  color: string;
}> = [
  { id: "world", label: "WORLD", num: 1, color: "#FFDD00" },
  { id: "canvas", label: "CANVAS", num: 2, color: "#06b6d4" },
  { id: "graph", label: "GRAPH", num: 3, color: "#a855f7" },
  { id: "feed", label: "FEED", num: 4, color: "#22c55e" },
  { id: "memory", label: "MEMORY", num: 5, color: "#f59e0b" },
];

export interface LayerChipsProps {
  /** Current visibility map — `true` means the layer is HIDDEN. */
  hidden: LayerVisibility;
  /** Toggle one layer. */
  onToggle: (layer: LayerId, hide: boolean) => void;
  /** Apply a full visibility map (shift-click solo). */
  onApply: (next: LayerVisibility) => void;
}

export const LayerChips = memo(function LayerChips({ hidden, onToggle, onApply }: LayerChipsProps) {
  return (
    <div
      role="toolbar"
      aria-label="Layer visibility"
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        display: "flex",
        gap: 4,
        padding: "4px 6px",
        background: "rgba(8, 8, 12, 0.82)",
        border: "1px solid rgba(255,221,0,0.25)",
        borderRadius: 4,
        fontFamily: "'Press Start 2P', monospace",
        fontSize: 9,
        letterSpacing: 1,
        zIndex: 40,
      }}
    >
      {LAYER_CHIPS.map(({ id, label, num, color }) => {
        const isHidden = hidden[id];
        return (
          <motion.button
            key={label}
            type="button"
            aria-pressed={!isHidden}
            aria-label={`${label} layer, key ${num}`}
            onClick={(e) => {
              // Shift-click: solo this layer (hide all others, show this)
              if (e.shiftKey) {
                const solo = applyLayerKey(hidden, String(num), true);
                if (solo) onApply(solo);
              } else {
                onToggle(id, !isHidden);
              }
            }}
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.94 }}
            animate={{
              background: isHidden ? "transparent" : `${color}22`,
              borderColor: isHidden ? "#333" : color,
              color: isHidden ? "#666" : color,
            }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            style={{
              padding: "4px 8px",
              borderStyle: "solid",
              borderWidth: 1,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: "inherit",
              letterSpacing: "inherit",
              borderRadius: 2,
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
            title={`${label} layer — click to toggle (key ${num}), shift-click to solo`}
          >
            <span style={{ opacity: 0.5, fontSize: "0.75em" }} aria-hidden="true">
              {num}
            </span>
            <span>{label}</span>
          </motion.button>
        );
      })}
    </div>
  );
});
