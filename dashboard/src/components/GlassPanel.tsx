// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Maximize2, Minimize2, Plus, RefreshCw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils";

/**
 * Focus/pop-out wiring a grid panel forwards to its GlassPanel. App owns the
 * focused-panel state and the enlarge/restore layout; panels just relay it.
 */
export interface PanelFocusProps {
  isFocused?: boolean;
  onToggleFocus?: () => void;
}

interface GlassPanelProps {
  title?: string;
  icon?: ReactNode;
  children: ReactNode;
  backContent?: ReactNode;
  className?: string;
  isFocused?: boolean;
  onDoubleClick?: () => void;
  /** When provided, renders an explicit pop-out/restore button in the header. */
  onToggleFocus?: () => void;
  headerExtra?: ReactNode;
  /**
   * Whether the front face scrolls its own overflow (default true). Panels that
   * own their scroll regions (e.g. Web Chat) pass false to avoid a nested bar.
   */
  bodyScroll?: boolean;
  /**
   * What the flip affordance means. "data" (default) shows a refresh icon for a
   * back-face data view; "create" shows a "+" (and "×" when open) so it reads as
   * an explicit create action rather than a cryptic flip.
   */
  flipMode?: "data" | "create";
}

const FLIP_TRANSITION = { duration: 0.4, ease: [0.4, 0, 0.2, 1] as const };

export function GlassPanel({
  title,
  icon,
  children,
  backContent,
  className,
  isFocused,
  onDoubleClick,
  onToggleFocus,
  headerExtra,
  bodyScroll = true,
  flipMode = "data",
}: GlassPanelProps) {
  const [isFlipped, setIsFlipped] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className={cn(
        "glass-panel flex h-full flex-col overflow-hidden",
        isFocused && "glass-panel-focused",
        className,
      )}
    >
      {title && (
        // biome-ignore lint/a11y/noStaticElementInteractions: react-grid-layout drag handle; double-click toggles focus and it wraps a nested flip button
        <div
          className="drag-handle flex cursor-grab items-center gap-1.5 border-b border-border px-2 py-1"
          onDoubleClick={onDoubleClick}
        >
          {icon && <span className="text-primary">{icon}</span>}
          <h2 className="flex-1 font-display text-[11px] font-semibold tracking-wider text-primary uppercase">
            {title}
          </h2>
          {headerExtra}
          {backContent &&
            (flipMode === "create" ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsFlipped((f) => !f);
                }}
                className={cn(
                  "transition-colors",
                  isFlipped ? "text-primary" : "text-text-dim hover:text-primary",
                )}
                title={isFlipped ? "Close" : "New agent"}
                aria-label={isFlipped ? "Close create form" : "New agent"}
              >
                {isFlipped ? <X size={13} /> : <Plus size={13} />}
              </button>
            ) : (
              <motion.button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsFlipped((f) => !f);
                }}
                animate={{ rotate: isFlipped ? 180 : 0 }}
                transition={FLIP_TRANSITION}
                className="text-text-dim hover:text-primary transition-colors"
                title={isFlipped ? "Show front" : "Show data"}
              >
                <RefreshCw size={10} />
              </motion.button>
            ))}
          {onToggleFocus && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFocus();
              }}
              className="text-text-dim transition-colors hover:text-primary"
              title={isFocused ? "Restore panel size (Esc)" : "Pop out — enlarge this panel"}
            >
              {isFocused ? <Minimize2 size={10} /> : <Maximize2 size={10} />}
            </button>
          )}
        </div>
      )}
      {/* Body — 3D card flip on isFlipped toggle. Perspective on the
          parent gives the rotation depth. min-h-0 lets the flex children
          shrink below their content height so the face can scroll. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={{ perspective: 1200 }}>
        <AnimatePresence mode="wait" initial={false}>
          {isFlipped ? (
            <motion.div
              key="back"
              initial={{ rotateY: -90, opacity: 0 }}
              animate={{ rotateY: 0, opacity: 1 }}
              exit={{ rotateY: 90, opacity: 0 }}
              transition={FLIP_TRANSITION}
              style={{ backfaceVisibility: "hidden", transformOrigin: "center" }}
              className="flex flex-1 flex-col overflow-hidden overflow-y-auto"
            >
              {backContent}
            </motion.div>
          ) : (
            <motion.div
              key="front"
              initial={{ rotateY: 90, opacity: 0 }}
              animate={{ rotateY: 0, opacity: 1 }}
              exit={{ rotateY: -90, opacity: 0 }}
              transition={FLIP_TRANSITION}
              style={{ backfaceVisibility: "hidden", transformOrigin: "center" }}
              className={cn(
                "flex min-h-0 flex-1 flex-col overflow-x-hidden",
                bodyScroll ? "overflow-y-auto" : "overflow-y-hidden",
              )}
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
