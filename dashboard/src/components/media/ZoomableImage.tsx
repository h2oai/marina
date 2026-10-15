// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * An image the viewer can zoom and pan: wheel (around the pointer), pinch
 * (two pointers), drag to pan when zoomed, double-click toggles fit ↔ 1:1,
 * and the toolbar's Fit / 1:1 / + / − buttons. Scale 1 is "fit" (the image
 * contained in the stage); "1:1" is one image pixel per CSS pixel. A blurred
 * placeholder fills the fixed stage until the bytes arrive (no layout shift).
 */

import { Maximize, Minus, Plus, Scan } from "lucide-react";
import {
  forwardRef,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 16;

export interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

export const FIT: ZoomState = { scale: 1, x: 0, y: 0 };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Zoom to `next` keeping the stage point (`px`, `py`, relative to centre) fixed. */
export function zoomAround(state: ZoomState, next: number, px: number, py: number): ZoomState {
  const scale = clampScale(next);
  if (scale === 1) return FIT;
  const k = scale / state.scale;
  return { scale, x: px - (px - state.x) * k, y: py - (py - state.y) * k };
}

export interface ZoomableImageHandle {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  actual(): void;
}

interface Props {
  src: string | undefined;
  alt: string;
  placeholder?: string | null;
  onError?: () => void;
  onZoomChange?: (state: ZoomState) => void;
}

export const ZoomableImage = forwardRef<ZoomableImageHandle, Props>(function ZoomableImage(
  { src, alt, placeholder, onError, onZoomChange },
  ref,
) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [zoom, setZoomState] = useState<ZoomState>(FIT);
  const [loaded, setLoaded] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; start: ZoomState } | null>(null);
  const pinch = useRef<{ dist: number; start: ZoomState } | null>(null);

  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  useEffect(() => {
    onZoomChangeRef.current?.(zoom);
  }, [zoom]);

  // A new image starts at fit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the source changes.
  useEffect(() => {
    setZoomState(FIT);
    setLoaded(false);
  }, [src]);

  /** Scale at which one image pixel is one CSS pixel. */
  const actualScale = useCallback(() => {
    const img = imgRef.current;
    if (!img?.naturalWidth || !img.clientWidth) return 2;
    return img.naturalWidth / img.clientWidth;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => setZoomState((z) => zoomAround(z, z.scale * 1.5, 0, 0)),
      zoomOut: () => setZoomState((z) => zoomAround(z, z.scale / 1.5, 0, 0)),
      fit: () => setZoomState(FIT),
      actual: () => setZoomState({ scale: clampScale(actualScale()), x: 0, y: 0 }),
    }),
    [actualScale],
  );

  const relative = useCallback((clientX: number, clientY: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // Non-passive so the page does not scroll while zooming.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = relative(e.clientX, e.clientY);
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      setZoomState((z) => zoomAround(z, z.scale * factor, p.x, p.y));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [relative]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), start: zoom };
      drag.current = null;
    } else if (pointers.current.size === 1 && zoom.scale !== 1) {
      drag.current = { x: e.clientX, y: e.clientY, start: zoom };
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = relative((a.x + b.x) / 2, (a.y + b.y) / 2);
      const start = pinch.current.start;
      setZoomState(
        zoomAround(start, (start.scale * dist) / (pinch.current.dist || 1), mid.x, mid.y),
      );
    } else if (drag.current) {
      const d = drag.current;
      setZoomState({ ...d.start, x: d.start.x + e.clientX - d.x, y: d.start.y + e.clientY - d.y });
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (zoom.scale !== 1) setZoomState(FIT);
    else {
      const p = relative(e.clientX, e.clientY);
      setZoomState(zoomAround(FIT, Math.max(2, actualScale()), p.x, p.y));
    }
  };

  const zoomed = zoom.scale !== 1;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer zoom/pan; the zoom toolbar and +/−/0 keys are the keyboard equivalents.
    <div
      ref={stageRef}
      data-testid="zoom-stage"
      data-scale={zoom.scale.toFixed(3)}
      className={`relative flex h-full w-full touch-none select-none items-center justify-center overflow-hidden ${
        zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {placeholder && !loaded && (
        <img
          src={placeholder}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-contain blur-xl"
        />
      )}
      {src && (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={onError}
          className="relative max-h-full max-w-full object-contain will-change-transform motion-safe:transition-transform motion-safe:duration-75"
          style={{
            transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
            opacity: loaded ? 1 : 0,
          }}
        />
      )}
    </div>
  );
});

/** Zoom toolbar (rendered in the viewer header). */
export function ZoomControls({
  scale,
  onZoomIn,
  onZoomOut,
  onFit,
  onActual,
}: {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onActual: () => void;
}) {
  const btn =
    "rounded p-1 text-text-dim transition-colors hover:bg-bg-hover hover:text-primary focus-visible:text-primary";
  return (
    <fieldset className="flex items-center gap-0.5">
      <legend className="sr-only">Zoom</legend>
      <button type="button" className={btn} onClick={onZoomOut} aria-label="Zoom out">
        <Minus size={14} aria-hidden="true" />
      </button>
      <output className="min-w-[3.5ch] text-center text-[10px] tabular-nums text-text-dim">
        {scale === 1 ? "fit" : `${Math.round(scale * 100)}%`}
      </output>
      <button type="button" className={btn} onClick={onZoomIn} aria-label="Zoom in">
        <Plus size={14} aria-hidden="true" />
      </button>
      <button type="button" className={btn} onClick={onFit} aria-label="Fit to screen">
        <Maximize size={14} aria-hidden="true" />
      </button>
      <button type="button" className={btn} onClick={onActual} aria-label="Actual size (1:1)">
        <Scan size={14} aria-hidden="true" />
      </button>
    </fieldset>
  );
}
