// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Shared admission for model/decision calls across every branch and nested Score.
 * Attempts count before dispatch, including failed requests. This is a call cap,
 * not a dollar cap: providers can bill a request even after cancellation. */
export class WorkBudget {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly waiting = new Set<() => void>();
  private active = 0;
  private attempted = 0;
  private peak = 0;

  constructor(
    readonly limits: Readonly<{ calls: number; concurrency: number; timeoutMs: number }>,
    signal?: AbortSignal,
  ) {
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${key} must be a positive safe integer`);
    }
    this.limits = Object.freeze({ ...limits });
    this.signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(limits.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
  }

  snapshot() {
    return { attempted: this.attempted, active: this.active, peak: this.peak, limits: this.limits };
  }

  cancel(reason: unknown) {
    this.controller.abort(reason);
  }

  async run<T>(work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
    const signal = parent ? AbortSignal.any([this.signal, parent]) : this.signal;
    signal.throwIfAborted();
    while (this.active >= this.limits.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.waiting.delete(wake);
          signal.removeEventListener("abort", abort);
        };
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        this.waiting.add(wake);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
    }
    if (this.attempted >= this.limits.calls) {
      const error = new Error(`shared call budget exhausted (${this.limits.calls})`);
      this.cancel(error);
      throw error;
    }
    this.attempted++;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    // Return promptly on abort even for a non-cooperative transport. Keep its
    // slot counted until it actually settles: cancellation is not proof that
    // an upstream request stopped running or stopped costing money.
    const pending = (async () => {
      try {
        const result = await work(signal);
        signal.throwIfAborted();
        return result;
      } finally {
        this.active--;
        for (const wake of [...this.waiting]) wake();
      }
    })();
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      return await Promise.race([pending, cancelled]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }
}
