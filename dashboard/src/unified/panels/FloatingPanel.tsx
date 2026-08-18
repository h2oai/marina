// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * FloatingPanel -- Shared wrapper for draggable, resizable, rollable panels.
 *
 * Visual port of the .fpanel class from 06-tiled.html mockup:
 * - background: rgba(8,8,14,0.96)
 * - border: 2px solid var(--border)
 * - box-shadow: 6px 6px 0 rgba(0,0,0,0.5)
 * - backdrop-filter: blur(10px)
 * - Header: Press Start 2P ~7-10px uppercase, gold blink dot, roll/close buttons
 * - Auto-fade to 25% opacity 0.8s after mouse leave
 * - Title bar draggable, bottom-right resizable
 */

import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/** Shared z-index counter across all FloatingPanel instances. */
let globalZIndex = 70;

/** Props for the FloatingPanel wrapper component. */
export interface FloatingPanelProps {
  /** Panel title shown in the header. */
  title: string;
  /** Panel children (body content). */
  children: ReactNode;
  /** Whether the panel is visible. */
  visible: boolean;
  /** Called when the close button is clicked. */
  onClose: () => void;
  /** Initial CSS position (left, top). */
  initialPosition?: { left: string; top: string };
  /** Initial CSS dimensions (width, height). */
  initialSize?: { width: string; height: string };
  /** Whether to start in rolled-up state. */
  defaultRolled?: boolean;
  /** Optional extra class name. */
  className?: string;
}

/**
 * Reusable floating panel wrapper with drag, resize, roll, close, and auto-fade.
 */
export const FloatingPanel = memo(function FloatingPanel({
  title,
  children,
  visible,
  onClose,
  initialPosition,
  initialSize,
  defaultRolled = false,
  className = "",
}: FloatingPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [rolled, setRolled] = useState(defaultRolled);
  const [faded, setFaded] = useState(false);
  const [zIndex, setZIndex] = useState(globalZIndex);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Drag state
  const dragRef = useRef({
    dragging: false,
    offsetX: 0,
    offsetY: 0,
  });

  // Resize state
  const resizeRef = useRef({
    resizing: false,
    startX: 0,
    startY: 0,
    startW: 0,
    startH: 0,
  });

  // Bring to front on click
  const bringToFront = useCallback(() => {
    globalZIndex += 1;
    setZIndex(globalZIndex);
  }, []);

  // Fade management
  const scheduleFade = useCallback(() => {
    clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => {
      setFaded(true);
    }, 800);
  }, []);

  const cancelFade = useCallback(() => {
    clearTimeout(fadeTimerRef.current);
    setFaded(false);
  }, []);

  // Start fading after initial render
  useEffect(() => {
    if (visible) scheduleFade();
    return () => clearTimeout(fadeTimerRef.current);
  }, [visible, scheduleFade]);

  // Drag handlers
  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      bringToFront();
      const rect = panel.getBoundingClientRect();
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      dragRef.current = {
        dragging: true,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
      };
      e.preventDefault();
    },
    [bringToFront],
  );

  // Resize start
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      bringToFront();
      const rect = panel.getBoundingClientRect();
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.width = `${rect.width}px`;
      panel.style.height = `${rect.height}px`;
      resizeRef.current = {
        resizing: true,
        startX: e.clientX,
        startY: e.clientY,
        startW: rect.width,
        startH: rect.height,
      };
      e.preventDefault();
      e.stopPropagation();
    },
    [bringToFront],
  );

  // Global mouse move/up for drag and resize
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (dragRef.current.dragging) {
        panel.style.left = `${e.clientX - dragRef.current.offsetX}px`;
        panel.style.top = `${e.clientY - dragRef.current.offsetY}px`;
      }
      if (resizeRef.current.resizing) {
        const dx = e.clientX - resizeRef.current.startX;
        const dy = e.clientY - resizeRef.current.startY;
        panel.style.width = `${Math.max(200, resizeRef.current.startW + dx)}px`;
        panel.style.height = `${Math.max(100, resizeRef.current.startH + dy)}px`;
      }
    };
    const onMouseUp = () => {
      dragRef.current.dragging = false;
      resizeRef.current.resizing = false;
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  if (!visible) return null;

  const rolledClass = rolled ? " rolled" : "";
  const fadedClass = faded ? " faded" : "";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: panel surface — mouse handlers drive z-order focus and hover-fade, not a click action
    <div
      ref={panelRef}
      className={`uc-floating-panel${rolledClass}${fadedClass} ${className}`}
      style={{
        left: initialPosition?.left ?? "12px",
        top: initialPosition?.top ?? "52px",
        width: initialSize?.width ?? "280px",
        height: rolled ? "auto" : (initialSize?.height ?? "320px"),
        zIndex,
        minHeight: rolled ? undefined : "100px",
      }}
      onMouseDown={() => {
        bringToFront();
        cancelFade();
      }}
      onMouseEnter={cancelFade}
      onMouseLeave={scheduleFade}
    >
      {/* Header / drag handle */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle — onMouseDown initiates pointer drag, not a click action */}
      <div className="uc-panel-header" onMouseDown={onDragStart}>
        {/* Blinking indicator */}
        <div className="uc-blink-dot" />
        <span>{title}</span>
        <span className="uc-spacer" />
        {/* Roll button */}
        <button
          type="button"
          className="uc-panel-btn"
          onClick={(e) => {
            e.stopPropagation();
            setRolled((r) => !r);
          }}
          title={rolled ? "Expand" : "Collapse"}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {rolled ? "\u25B8" : "\u25BE"}
        </button>
        {/* Close button */}
        <button
          type="button"
          className="uc-panel-btn"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close"
          onMouseDown={(e) => e.stopPropagation()}
        >
          x
        </button>
      </div>

      {/* Body */}
      {!rolled && <div className="uc-fp-body">{children}</div>}

      {/* Resize handle */}
      {!rolled && (
        // biome-ignore lint/a11y/noStaticElementInteractions: resize grip — onMouseDown initiates pointer drag-to-resize, not a click action
        <div className="uc-fp-resize" onMouseDown={onResizeStart}>
          <div />
        </div>
      )}
    </div>
  );
});
