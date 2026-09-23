// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile-time proof that a readonly tuple of method names covers every key
 * of `T`. Resolves to `true` when complete; otherwise to an object naming the
 * missing keys, so assigning `true` fails with the offending names in the error.
 */
export type ExactKeys<T, K extends readonly PropertyKey[]> = [Exclude<keyof T, K[number]>] extends [
  never,
]
  ? true
  : { missing: Exclude<keyof T, K[number]> };
