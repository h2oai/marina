// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tiny helper: a sleep that can be cut short by a wake() call.
 *
 * Used by the autonomous-loop cycle-delay sleep so an arriving perception
 * can wake the loop immediately instead of waiting up to `loopCycleDelay`.
 * Crew fast-dispatch fix #3 — see docs/crew-fast-dispatch-design.md.
 *
 * Lifecycle:
 *   1. caller `await waiter.sleep(ms)` — armed, will resolve at deadline
 *   2. external trigger calls `waiter.wake()` — resolves immediately
 *   3. either path clears the active wakeup so subsequent wake() calls
 *      become no-ops until the next sleep() arms again
 *
 * Idempotent on `wake()` — repeated wakes during a single sleep cycle
 * collapse to one. Concurrent overlapping `sleep()` calls are NOT
 * supported (the second one overwrites the wakeup binding); callers
 * are expected to await one sleep at a time.
 */
export class InterruptibleWaiter {
  private active: (() => void) | null = null;

  /**
   * Sleep up to `ms` milliseconds. Resolves at the deadline OR when
   * `wake()` is called, whichever comes first.
   */
  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.active === wakeup) this.active = null;
        resolve();
      }, ms);
      const wakeup = (): void => {
        clearTimeout(timer);
        if (this.active === wakeup) this.active = null;
        resolve();
      };
      this.active = wakeup;
    });
  }

  /** Cut a currently-armed sleep short. No-op when no sleep is armed. */
  wake(): void {
    const wakeup = this.active;
    if (wakeup) wakeup();
  }

  /** Inspection helper used by tests + diagnostics. */
  isArmed(): boolean {
    return this.active !== null;
  }
}
