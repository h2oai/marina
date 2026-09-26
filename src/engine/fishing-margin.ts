// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The bar a new candidate must clear over the incumbent. Fishing through more
 * candidates raises it — each try is another draw at a lucky result — so it
 * grows with the number tried before: 0.02 + 0.01·log₂(1 + tried). Shared by
 * arena signal discovery and `evolve replicate`, so both hold the same line.
 */
export function promotionMargin(triedBefore: number): number {
  return 0.02 + 0.01 * Math.log2(1 + Math.max(0, triedBefore));
}
