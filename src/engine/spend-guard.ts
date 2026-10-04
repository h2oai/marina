// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One spend stop for batch work (backtests, selection runs, bot passes,
 * benchmark attempts): a job's own budget on top of the world's daily caps.
 *
 * - `stopReason()` is checked before starting each item. It stops while every
 *   item still in flight can finish under the budget: spent + a reserve of
 *   `reserveFactor × concurrency × mean item cost` (at least `minReserveUsd`).
 *   The same reserve is held against the daily caps (`dailyBudget`, the tighter
 *   of the world cap and this process's `MARINA_SPEND_SCOPE` cap), and an
 *   exact `dailyCapRefusal` is checked first.
 * - `share(slots)` gives each concurrent unit a hard cap of its own (for a
 *   unit that runs as its own process with its own ledger, such as a coding
 *   session). The shares never add up to more than the budget left, so the
 *   budget is a true total cap, up to the one call in flight when a share runs out.
 *
 * The guard only counts what it is told (`record`, `settle`). The world ledger
 * still records every dollar where it is spent.
 */

import { dailyBudget, dailyCapRefusal } from "./spend-ledger";

export interface SpendGuardOptions {
  /** Names the budget in refusals ("selection budget", "metaculus daily cap"). */
  label: string;
  /** The job's own budget in USD; undefined = only the daily caps. */
  budgetUsd?: number;
  /** Already spent against `budgetUsd` (earlier runs, earlier passes). */
  spentUsd?: number;
  /** Items in flight at once (default 1). */
  concurrency?: number;
  /** The smallest reserve held back before starting an item (default 0). */
  minReserveUsd?: number;
  /** Reserve = factor × concurrency × mean item cost (default 1.5). */
  reserveFactor?: number;
  /** Also stop at the world's (and scope's) daily caps (default true). */
  daily?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface SpendShare {
  /** The most this unit may spend. */
  capUsd: number;
  /** Return the unit's share with what it actually spent. */
  settle(actualUsd: number): void;
}

export class SpendGuard {
  private spent: number;
  private itemCost = 0;
  private items = 0;
  private reserved = 0;

  constructor(private readonly opts: SpendGuardOptions) {
    this.spent = opts.spentUsd ?? 0;
  }

  /** Total counted against the job's budget so far. */
  get spentUsd(): number {
    return this.spent;
  }

  /** Count one finished item's cost. */
  record(usd: number | undefined): void {
    const cost = usd && Number.isFinite(usd) && usd > 0 ? usd : 0;
    this.spent += cost;
    this.itemCost += cost;
    this.items++;
  }

  meanItemUsd(): number {
    return this.items ? this.itemCost / this.items : 0;
  }

  /** What is held back for the items in flight. */
  reserveUsd(): number {
    const factor = this.opts.reserveFactor ?? 1.5;
    const concurrency = Math.max(1, this.opts.concurrency ?? 1);
    return Math.max(this.opts.minReserveUsd ?? 0, factor * concurrency * this.meanItemUsd());
  }

  /** The job's budget left (minus outstanding shares), or undefined when it has none. */
  remainingUsd(): number | undefined {
    if (this.opts.budgetUsd === undefined) return undefined;
    return Math.max(0, this.opts.budgetUsd - this.spent - this.reserved);
  }

  /** Why the next item must not start, or undefined when there is room. */
  stopReason(): string | undefined {
    const reserve = this.reserveUsd();
    const budget = this.opts.budgetUsd;
    if (budget !== undefined && this.spent + this.reserved + reserve >= budget) {
      return `${this.opts.label} $${budget.toFixed(2)} reached: $${this.spent.toFixed(2)} spent + $${reserve.toFixed(2)} reserve`;
    }
    if (this.opts.daily === false) return undefined;
    const env = this.opts.env ?? process.env;
    const now = this.opts.now?.() ?? Date.now();
    const refused = dailyCapRefusal(env, now);
    if (refused) return refused;
    const s = dailyBudget(env, now);
    if (s !== undefined && reserve > 0 && s.spentUsd + reserve >= s.capUsd) {
      return `${s.label} spend cap $${s.capUsd.toFixed(2)}: $${s.spentUsd.toFixed(2)} spent + $${reserve.toFixed(2)} reserve`;
    }
    return undefined;
  }

  /**
   * Reserve a hard cap for one unit among `slots` units that may run at once
   * (counting this one): the budget left split evenly, so concurrent units can
   * never together exceed it. Undefined when the budget is spent; a share of
   * `Infinity` when the guard has no budget of its own.
   */
  share(slots = this.opts.concurrency ?? 1): SpendShare | undefined {
    const left = this.remainingUsd();
    if (left === undefined) {
      return { capUsd: Number.POSITIVE_INFINITY, settle: (usd) => this.record(usd) };
    }
    if (left <= 0.000_001) return undefined;
    const capUsd = left / Math.max(1, slots);
    this.reserved += capUsd;
    let settled = false;
    return {
      capUsd,
      settle: (usd) => {
        if (settled) return;
        settled = true;
        this.reserved -= capUsd;
        this.record(usd);
      },
    };
  }
}

/**
 * A `MARINA_DAILY_SPEND_CAP_USD` value for a child process that must not spend
 * more than `usd`: rounded DOWN (never up past the share), and never `0` or
 * `off`, which would mean "uncapped". A non-positive or non-finite share
 * becomes the smallest cap there is. Callers give a finite cap; an unbudgeted
 * unit keeps its own default rather than going uncapped.
 */
export function capEnvValue(usd: number): string {
  if (!(usd > 0) || !Number.isFinite(usd)) return "0.000001";
  return String(Math.max(0.000_001, Math.floor(usd * 1e6) / 1e6));
}
