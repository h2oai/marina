// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas animation helpers — built on motion (formerly Framer Motion).
 *
 * Two helpers:
 *   - `animateLayout` — tweens React Flow node positions/sizes to a new
 *     target map over 600ms with a soft spring. Used by toolbar "auto
 *     layout" buttons. Drives a single MotionValue and feeds the proxy
 *     value to `setNodes` per frame.
 *   - `springEntrance` — scale + fade-in stagger for newly mounted DOM
 *     elements (canvas nodes). Pure motion `animate()` calls.
 */

import type { Node } from "@xyflow/react";
import { animate } from "motion/react";

type SetNodes = React.Dispatch<React.SetStateAction<Node[]>>;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Animate nodes from their current positions to target positions.
 * Drives a 0→1 motion value, interpolates positions per frame, and
 * pushes them through `setNodes`.
 */
export function animateLayout(
  nodes: Node[],
  targetMap: Map<string, { x: number; y: number; w: number; h: number }>,
  setNodes: SetNodes,
): Promise<void> {
  if (prefersReducedMotion() || nodes.length === 0) {
    setNodes((prev) =>
      prev.map((n) => {
        const target = targetMap.get(n.id);
        if (!target) return n;
        return {
          ...n,
          position: { x: target.x, y: target.y },
          style: { width: target.w, height: target.h },
        };
      }),
    );
    return Promise.resolve();
  }

  const starts = new Map(
    nodes.map((n) => [
      n.id,
      {
        x: n.position.x,
        y: n.position.y,
        w: (n.style?.width as number) ?? 300,
        h: (n.style?.height as number) ?? 200,
      },
    ]),
  );

  return new Promise<void>((resolve) => {
    const proxy = { t: 0 };
    animate(0, 1, {
      duration: 0.6,
      type: "spring",
      stiffness: 120,
      damping: 14,
      onUpdate: (latest) => {
        proxy.t = latest;
        setNodes((prev) =>
          prev.map((n) => {
            const start = starts.get(n.id);
            const target = targetMap.get(n.id);
            if (!start || !target) return n;
            return {
              ...n,
              position: {
                x: start.x + (target.x - start.x) * latest,
                y: start.y + (target.y - start.y) * latest,
              },
              style: {
                width: start.w + (target.w - start.w) * latest,
                height: start.h + (target.h - start.h) * latest,
              },
            };
          }),
        );
      },
      onComplete: () => resolve(),
    });
  });
}

/**
 * Animate a spring entrance for DOM elements (scale 0 -> 1) with stagger.
 */
export function springEntrance(elements: Element | Element[] | NodeListOf<Element>) {
  if (prefersReducedMotion()) return;

  const els =
    elements instanceof Element
      ? [elements]
      : (Array.from(elements as Iterable<Element>) as Element[]);

  els.forEach((el, i) => {
    animate(
      el,
      { scale: [0, 1], opacity: [0, 1] },
      {
        duration: 0.5,
        delay: i * 0.05,
        type: "spring",
        stiffness: 120,
        damping: 14,
      },
    );
  });
}
