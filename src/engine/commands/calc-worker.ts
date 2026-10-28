// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker entry for `calc`: evaluates one expression off the main thread so a
 * pathological expression (e.g. `rationalize` of a high-degree product) can
 * only stall this worker, which the caller terminates at its deadline. The
 * server's event loop never runs mathjs.
 *
 * The worker posts `{ ready: true }` once mathjs has loaded (the static import
 * below); the caller starts an evaluation's deadline only after that, so a slow
 * module load on a busy machine is not counted against the expression.
 */

import { evalExpression } from "./calc-eval";

declare const self: Worker;

self.onmessage = (event: MessageEvent<{ id: number; source: string }>) => {
  const { id, source } = event.data;
  self.postMessage({ id, result: evalExpression(source) });
};

self.postMessage({ ready: true });
