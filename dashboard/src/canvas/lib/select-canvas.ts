// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Minimal shape shared by the standalone and unified canvas selectors. */
interface SelectableCanvas {
  id: string;
  name: string;
}

/**
 * Choose the canvas that gives a visitor the most coherent first impression.
 *
 * An explicit deep-link wins. Otherwise prefer the automatically populated
 * activity feed, then the seeded guide, then the shared workspace, then the
 * first available canvas.
 */
export function selectInitialCanvas<T extends SelectableCanvas>(
  canvases: T[],
  requestedId?: string | null,
): T | undefined {
  if (requestedId) {
    const requested = canvases.find((canvas) => canvas.id === requestedId);
    if (requested) return requested;
  }
  return (
    canvases.find((canvas) => canvas.name === "feed") ??
    canvases.find((canvas) => canvas.name === "guide") ??
    canvases.find((canvas) => canvas.name === "global") ??
    canvases[0]
  );
}
