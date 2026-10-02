// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker entry for `calc`: evaluates one expression off the main thread so a
 * pathological expression (e.g. `rationalize` of a high-degree product) can
 * only stall this worker, which the caller terminates at its deadline. The
 * server's event loop never runs mathjs.
 */

import { evalExpression } from "./calc";

declare const self: Worker;

self.onmessage = (event: MessageEvent<{ id: number; source: string }>) => {
  const { id, source } = event.data;
  self.postMessage({ id, result: evalExpression(source) });
};
