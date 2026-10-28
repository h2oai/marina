// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** One upstream attempt, not an orchestration stage or a cumulative usage delta. */
export interface SpendReceipt {
  id: string;
  source: string;
  model?: string;
  state: "pending" | "priced" | "unknown";
  usd?: number;
  reason?: string;
}
export type SpendObserver = (receipt: SpendReceipt) => void;
const observers = new AsyncLocalStorage<SpendObserver | undefined>();

export function withSpendObservation<T>(observer: SpendObserver | undefined, action: () => T): T {
  return observers.run(observer, action);
}

export function beginObservedSpend(source: string, model?: string) {
  const observer = observers.getStore();
  if (!observer) return undefined;
  const receipt = { id: randomUUID(), source, ...(model ? { model } : {}) };
  observer({ ...receipt, state: "pending" });
  let settled = false;
  return {
    settle(usd?: number, reason?: string) {
      if (settled) return;
      observer({
        ...receipt,
        state: usd !== undefined && Number.isFinite(usd) && usd >= 0 ? "priced" : "unknown",
        ...(usd !== undefined && Number.isFinite(usd) && usd >= 0 ? { usd } : {}),
        ...(reason ? { reason } : {}),
      });
      settled = true;
    },
  };
}

/** Adapters that expose only a final charge still get a distinct receipt. */
export function observeRecordedSpend(source: string, usd: number | undefined): void {
  beginObservedSpend(source)?.settle(
    usd,
    usd === undefined ? "Adapter returned no price" : undefined,
  );
}
