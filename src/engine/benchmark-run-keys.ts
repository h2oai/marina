// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run keys: a short-lived `/v1` credential minted by THIS server for one
 * benchmark run it launched (`BenchmarkRunner`), handed to the harness child
 * in its environment. A third-party harness can only send a base URL and a key,
 * so the key carries what the run needs:
 *
 * - the arm: the instrument stack its requests get (`x-marina-stack`), unless
 *   a request names one itself;
 * - the eval context (`x-marina-eval`): leakage rule 2 for measurement;
 * - a spend cap: the run's upstream spend is attributed to the key, and once
 *   it reaches the cap every further call is refused (`run_budget_exhausted`);
 * - a transport guard: after {@link TRANSPORT_TRIP} consecutive network
 *   failures the key refuses every call (`run_transport_failed`), so a broken
 *   connection fails the run fast instead of burning its budget on retries.
 *
 * Keys live in this process only, expire, and are revoked when the run ends.
 * They grant no name-map authority and no entity beyond the one they name.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

/** Prefix of every run key (`mrk_` + 32 hex). */
export const RUN_KEY_PREFIX = "mrk_";
/** Consecutive network failures that stop a run. */
export const TRANSPORT_TRIP = 5;
/** A key unused this long after its last call or mint is dead. */
const DEFAULT_TTL_MS = 6 * 3_600_000;

export interface RunKeyGrant {
  /** The ledger run this key serves. */
  runId: string;
  /** `x-marina-stack` value for requests that do not name one (`none`, `full`, members…). */
  stack?: string;
  /** `x-marina-eval` value for requests that carry none. */
  evalTag?: string;
  /** Upstream spend cap for the whole run, USD (undefined = none). */
  capUsd?: number;
  /** The entity the key's requests act as (a distinct passthru identity), if any. */
  entityName?: string;
  /** Persist cumulative charges, including calls already admitted when the key is revoked. */
  onSpend?: (costUsd: number) => void;
}

export interface RunKeyState extends RunKeyGrant {
  spentUsd: number;
  calls: number;
  /** Consecutive network failures. */
  strikes: number;
  /** Why the key refuses every call, once it does. */
  tripped?: "budget" | "transport";
  expiresAt: number;
}

const keys = new Map<string, RunKeyState>();
const current = new AsyncLocalStorage<RunKeyState>();

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a key for a run; returns the bearer token (never logged or stored). */
export function mintRunKey(grant: RunKeyGrant, ttlMs = DEFAULT_TTL_MS): string {
  const token = `${RUN_KEY_PREFIX}${randomBytes(16).toString("hex")}`;
  keys.set(digest(token), {
    ...grant,
    spentUsd: 0,
    calls: 0,
    strikes: 0,
    expiresAt: Date.now() + ttlMs,
  });
  return token;
}

/** The live state of a presented token, or undefined (unknown, revoked, expired). */
export function lookupRunKey(token: string, now = Date.now()): RunKeyState | undefined {
  if (!token.startsWith(RUN_KEY_PREFIX)) return undefined;
  const id = digest(token);
  const state = keys.get(id);
  if (!state) return undefined;
  if (state.expiresAt <= now) {
    keys.delete(id);
    return undefined;
  }
  return state;
}

/** Revoke a key (its run ended); returns its final state. */
export function revokeRunKey(token: string): RunKeyState | undefined {
  const id = digest(token);
  const state = keys.get(id);
  keys.delete(id);
  return state;
}

/** Why this key refuses calls now (`run_budget_exhausted` / `run_transport_failed`), if it does. */
export function runKeyRefusal(
  state: RunKeyState,
): { code: "run_budget_exhausted" | "run_transport_failed"; message: string } | undefined {
  if (state.tripped === "transport")
    return {
      code: "run_transport_failed",
      message: `this run stopped after ${TRANSPORT_TRIP} consecutive upstream network failures`,
    };
  if (state.tripped === "budget" || (state.capUsd !== undefined && state.spentUsd >= state.capUsd))
    return {
      code: "run_budget_exhausted",
      message: `this run spent its cap ($${state.spentUsd.toFixed(2)} of $${(state.capUsd ?? 0).toFixed(2)})`,
    };
  return undefined;
}

/** Run `fn` with `state` as the request's run key (spend and failures attribute to it). */
export function withRunKey<T>(state: RunKeyState, fn: () => T): T {
  return current.run(state, fn);
}

/** An upstream call finished: attribute its cost, reset or count transport strikes. */
export function noteRunKeyCall(outcome: {
  ok: boolean;
  costUsd?: number;
  network?: boolean;
}): void {
  const state = current.getStore();
  if (!state) return;
  state.calls++;
  state.expiresAt = Math.max(state.expiresAt, Date.now() + DEFAULT_TTL_MS);
  if (outcome.costUsd !== undefined && Number.isFinite(outcome.costUsd)) {
    state.spentUsd += outcome.costUsd;
    state.onSpend?.(state.spentUsd);
  }
  if (state.capUsd !== undefined && state.spentUsd >= state.capUsd) state.tripped ??= "budget";
  if (outcome.ok) state.strikes = 0;
  else if (outcome.network && ++state.strikes >= TRANSPORT_TRIP) state.tripped ??= "transport";
}

/** Test seam. */
export function resetRunKeysForTests(): void {
  keys.clear();
}
