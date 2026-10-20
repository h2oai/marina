// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Moved to the shared model backend `src/model/` (2026-10-20); this
 * re-export keeps the old import path working. New code imports `src/model`.
 */

export { callCost, modelAccess, type Usage } from "../model/access";
export { type ModelCompleteOptions, modelComplete } from "../model/complete";
