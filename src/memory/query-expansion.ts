// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { normalizeMemoryExpansion } from "../sdk/memory-expansion";
import { MemoryError } from "./service-types";

export function memoryQueryExpansion(query: string, raw: unknown) {
  try {
    return normalizeMemoryExpansion(query, raw);
  } catch {
    throw new MemoryError(
      400,
      "invalid_expansion",
      "Use a policy label and at most four bounded queries",
    );
  }
}
