// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Why the lesson writer or the lesson judge gave no answer, and whether that
 * cause passes on its own. A durable delivery (`src/outcomes/deliver.ts`)
 * WAITS on a transient cause — the daily spend cap, throttling, an overloaded
 * or failing upstream, a timeout, a dropped connection — without spending an
 * attempt, and spends attempts toward `failed` only on a cause that repeats
 * for the same input (an auth or request refusal, a reply that is never in
 * the expected shape).
 *
 * `invalid_response` (the backend answered, but not in the expected shape) is
 * NOT transient: the reply came back on time, so retrying the same input with
 * the same model can fail the same way forever. It spends an attempt per pass;
 * a one-off malformed reply is retried on later passes, and one that repeats
 * ends `failed` with the kind in its reason.
 */

import { DecisionError } from "../decisions/types";
import { isSpendRefusal } from "../engine/spend-ledger";
import { failureKind } from "../model/retry";

export interface Unavailable {
  /** `DecisionError` code, or a model-call failure kind (`rate_limited`, `timeout`, …). */
  kind: string;
  /** The cause passes on its own: wait, never spend an attempt on it. */
  transient: boolean;
  /** The error message, clipped. */
  message: string;
}

/** DecisionError codes that pass on their own. */
const TRANSIENT_DECISION_CODES = new Set([
  "timeout",
  "rate_limited",
  "overloaded",
  "spend_cap",
  "decisions_disabled",
]);

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** An HTTP status named in an error: a `status` field, `HTTP 429`, or a leading `decision backend 503`. */
function statusOf(err: unknown, message: string): number | undefined {
  const field = (err as { status?: unknown })?.status;
  if (typeof field === "number" && field >= 100 && field <= 599) return field;
  const m =
    /\b(?:HTTP|decision backend)\s+(\d{3})\b/i.exec(message) ?? /^\s*(\d{3})\b/.exec(message);
  return m ? Number(m[1]) : undefined;
}

/** A status that passes on its own: 408, 425, 429, 5xx. */
const transientStatus = (s: number) => s === 408 || s === 425 || s === 429 || s >= 500;

/** Bun's and Node's fetch transport failures that carry no recognisable message. */
const TRANSPORT =
  /unable to connect|connection ?refused|ConnectionRefused|ConnectionClosed|socket (?:closed|connection)|typo in the url or port/i;

/** Classify a writer or judge failure. */
export function classifyUnavailable(err: unknown): Unavailable {
  const message = clip(String((err as Error)?.message ?? err), 160);
  if (isSpendRefusal(message)) return { kind: "spend_cap", transient: true, message };
  if (err instanceof DecisionError) {
    // `upstream_error` covers transport failures and statuses statusError did
    // not map: a 4xx other than throttling is a refusal that repeats.
    if (err.code === "upstream_error") {
      const status = statusOf(undefined, message);
      return {
        kind: err.code,
        transient: status === undefined || transientStatus(status),
        message,
      };
    }
    return { kind: err.code, transient: TRANSIENT_DECISION_CODES.has(err.code), message };
  }
  const name = (err as Error)?.name;
  if (name === "TimeoutError") return { kind: "timeout", transient: true, message };
  if (name === "AbortError") return { kind: "cancelled", transient: true, message };
  const status = statusOf(err, message);
  if (status !== undefined) {
    if (status === 429) return { kind: "rate_limited", transient: true, message };
    if (transientStatus(status)) return { kind: "upstream_error", transient: true, message };
    return { kind: `http_${status}`, transient: false, message };
  }
  const code = (err as { code?: unknown })?.code;
  if (TRANSPORT.test(message) || (typeof code === "string" && TRANSPORT.test(code)))
    return { kind: "transport", transient: true, message };
  const kind = failureKind(message);
  switch (kind) {
    case "rate_limit":
      return { kind: "rate_limited", transient: true, message };
    case "provider":
      return { kind: "upstream_error", transient: true, message };
    case "network":
      return { kind: "transport", transient: true, message };
    case "quota":
    case "timeout":
    case "cancelled":
      return { kind, transient: true, message };
    default:
      return { kind, transient: false, message };
  }
}

/**
 * Whether a `failed` delivery's recorded reason names a transient cause, for
 * re-opening deliveries a pass ended `failed` before outages waited. Reads the
 * legacy reasons, which carried no kind: `decision backend unavailable` (the
 * judge's cause was not kept: treated as transient once — a reply that is
 * really malformed fails again with its kind recorded, and is not re-opened)
 * and `writer unavailable: <message>` (classified by its message).
 */
export function transientFailureReason(reason: string | null): boolean {
  if (!reason) return false;
  if (/no verdict: decision backend unavailable$/.test(reason)) return true;
  const writer = /writer unavailable: (.*?)\)?$/.exec(reason);
  if (writer) return classifyUnavailable(new Error(writer[1] ?? "")).transient;
  return false;
}
