// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether the user/OS has asked to reduce motion. Used to drop continuous
 * animations (SVG `<animate>` loops, particle flows) that are pure ambience but
 * cost steady CPU/paint. Reading it per render is cheap (synchronous matchMedia)
 * and these call sites are inside memoized components.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
