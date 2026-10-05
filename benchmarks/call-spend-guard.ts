// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A hard spend stop for a harness run. Every model call made through a Marina
 * reports its cost in `x-marina-cost-usd`; a run adds each one to its guard
 * and checks the guard BEFORE the next call. Once the spend reaches the cap,
 * or the server answers with its daily cap (`429 spend_cap_reached`), the
 * guard trips: every further call throws `BudgetExhausted`.
 *
 * A harness must treat a tripped item as NOT RUN, never as an answer or a
 * wrong answer: it is left out of scoring and the run is marked stopped. The
 * overshoot is bounded by the calls already in flight when the cap is reached.
 *
 * This is the PER-CALL stop (BrowseComp-Plus checks it before every model
 * call). Batch jobs that stop between items with a reserve for work in flight
 * use `SpendGuard` in `src/engine/spend-guard.ts` instead.
 */

export class BudgetExhausted extends Error {
  constructor(readonly reason: string) {
    super(`budget stop: ${reason}`);
    this.name = "BudgetExhausted";
  }
}

export class CallSpendGuard {
  private spentUsd = 0;
  private tripped?: string;

  /** `maxUsd` undefined = no cap of its own (the server's daily cap still trips it). */
  constructor(readonly maxUsd?: number) {
    if (maxUsd !== undefined && !(maxUsd >= 0)) throw new Error("maxUsd must be ≥ 0");
  }

  get spent(): number {
    return this.spentUsd;
  }

  /** Why the guard stopped the run, or undefined while spending may continue. */
  get stoppedBy(): string | undefined {
    if (this.tripped) return this.tripped;
    if (this.maxUsd !== undefined && this.spentUsd >= this.maxUsd)
      return `spend cap $${this.maxUsd} reached ($${this.spentUsd.toFixed(2)} spent)`;
    return undefined;
  }

  /** Record one call's cost (non-finite or negative values are ignored). */
  add(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.spentUsd += usd;
  }

  /** Stop for an outside reason (e.g. the server's daily spend cap). */
  trip(reason: string): void {
    this.tripped ??= reason;
  }

  /** Throws `BudgetExhausted` once the guard has stopped; call before every paid request. */
  check(): void {
    const why = this.stoppedBy;
    if (why) throw new BudgetExhausted(why);
  }
}

/** A Marina refusal because its daily spend cap is reached (`429`, code `spend_cap_reached`). */
export function isSpendCapRefusal(status: number, body: string): boolean {
  return status === 429 && body.includes("spend_cap_reached");
}

/** Parse `--max-usd`: undefined when absent; a positive finite number otherwise. */
export function parseMaxUsd(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error("--max-usd must be a positive number");
  return n;
}
