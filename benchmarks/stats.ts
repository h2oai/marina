// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compatibility shim: the paired statistics moved to `src/stats/paired.ts`
 * (core code must not import from the harness tree). Import from `src/stats`.
 */

export * from "../src/stats/paired";
