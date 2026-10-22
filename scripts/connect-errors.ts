// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { LoginRefusedError } from "../src/sdk/client";

/**
 * True for a transport failure (server down / unreachable), false for a login
 * refusal. A refusal is typed by the SDK; its text (which may mention a
 * connection) is never read as a network error.
 */
export function isTransportFailure(err: unknown): boolean {
  if (err instanceof LoginRefusedError) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /WebSocket connection|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|timed out/i.test(
    message,
  );
}
