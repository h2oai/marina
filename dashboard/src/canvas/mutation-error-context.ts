// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext } from "react";

/**
 * How a canvas node component reports a refused or failed save: the page that
 * renders the canvas provides its notice mechanism (Canvas page notice, the
 * unified canvas command bar). Without a provider, failures are dropped.
 */
export const CanvasMutationErrorContext = createContext<((message: string) => void) | null>(null);

export function useCanvasMutationError(): (message: string) => void {
  const report = useContext(CanvasMutationErrorContext);
  return report ?? (() => {});
}
