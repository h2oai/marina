// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * 32-bit FNV-1a, the one string hash behind stable seeds, rotations and shards.
 * Two iteration orders exist in the code base and give different results on
 * characters outside the BMP, so both are named rather than merged: a hash
 * that already partitions stored data must not move.
 */

/** FNV-1a over the code points of `text` (`for … of`), as an unsigned 32-bit integer. */
export function fnv1a32(text: string): number {
  let hash = 2166136261;
  for (const ch of text) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/** FNV-1a over the UTF-16 code units of `text` (`charCodeAt(i)`), as an unsigned 32-bit integer. */
export function fnv1a32CodeUnits(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}
