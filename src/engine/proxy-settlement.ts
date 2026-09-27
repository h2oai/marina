// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a proxied model call cost, keyed by its request id, for the agent that
 * made it. A STREAMING response's headers leave before the upstream reports
 * usage, so the `x-marina-cost-usd` header can only ride non-streaming replies —
 * and agents stream, so every proxied turn read as $0 and per-agent spend caps
 * never saw it. Marina's own agents run in the proxy's process: the passthru
 * settles each completed call here, and the agent reads it back at turn end by
 * the `x-request-id` it already received. Bounded; oldest entries fall off.
 */

export interface SettledProxyCall {
  costUsd?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

const MAX_ENTRIES = 1_000;
const settled = new Map<string, SettledProxyCall>();

export function settleProxyCall(requestId: string, call: SettledProxyCall): void {
  settled.delete(requestId);
  settled.set(requestId, call);
  while (settled.size > MAX_ENTRIES) settled.delete(settled.keys().next().value as string);
}

/** The settled call for a request id, removed on read (each call is counted once). */
export function takeSettledProxyCall(requestId: string): SettledProxyCall | undefined {
  const call = settled.get(requestId);
  settled.delete(requestId);
  return call;
}
