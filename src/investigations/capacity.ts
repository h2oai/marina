// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Process capacity is independent of an episode's deadline and call allowance.
 * A non-cooperative provider retains its slot until it actually settles. */
export class InvestigationCapacity {
  private active = 0;
  private readonly waiting = new Set<() => void>();

  constructor(private readonly limit = 16) {}

  async run<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    while (this.active >= this.limit) {
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
    this.active++;
    try {
      return await work(signal);
    } finally {
      this.active--;
      for (const wake of [...this.waiting]) wake();
    }
  }
}
