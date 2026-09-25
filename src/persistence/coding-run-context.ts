// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

/** Captured at command ingress: late tool results retain the original attempt. */
export const codingRunContext = new AsyncLocalStorage<{
  sessionId?: string;
  runId?: string;
  taskId?: number;
}>();
