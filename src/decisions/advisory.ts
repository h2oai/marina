// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Bounded, opt-in judgments. This fallback policy never changes safety gates. */
import { createHash, randomUUID } from "node:crypto";
import { tryLog } from "../engine/errors";
import { Logger } from "../engine/logger";
import { dailyCapRefusal } from "../engine/spend-ledger";
import type { DecisionsStore } from "../persistence/interfaces/decisions-store";
import type { AdvisoryFamily, AdvisoryMode, DecisionReceipt } from "../sdk/decision-receipt";
import { normalizeAnswers } from "./answers";
import { classifierEngine, type EngineDeps, harnessDecisionProvider } from "./engines";
import {
  DecisionError,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
} from "./types";

const logger = new Logger();
export const ADVISORY_VERSION = "1";
export const DEFAULT_ADVISORY_TIMEOUT_MS = 4_000;

export function advisoryMode(raw: string | undefined): AdvisoryMode {
  const mode = raw?.trim().toLowerCase();
  return mode === "on" || mode === "observe" ? mode : "off";
}

export function advisoryTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MARINA_ADVISORY_TIMEOUT_MS);
  return Number.isSafeInteger(n) && n >= 1 && n <= 60_000 ? n : DEFAULT_ADVISORY_TIMEOUT_MS;
}

export interface AdvisoryOptions {
  env?: NodeJS.ProcessEnv;
  /** Explicit providers replace environment resolution (including [] for no backend). */
  providers?: readonly DecisionProvider[];
  /** Standalone callers may use their own model instead of the self HTTP endpoint. */
  localFallback?: DecisionProvider;
  engineDeps?: EngineDeps;
  timeoutMs?: number;
  signal?: AbortSignal;
  spendCheck?: () => string | undefined;
  /** Standalone run budgets may require ending the run even for optional judgments. */
  isFatal?: (error: unknown) => boolean;
  /** Run-budget accounting in addition to provider-owned ledger accounting.
   * The caller's localFallback already meters its own model turns. */
  onCost?: (usd: number) => void;
}

export function advisoryProviders(options: AdvisoryOptions = {}): readonly DecisionProvider[] {
  if (options.providers) return options.providers.slice(0, 2);
  const env = options.env ?? process.env;
  const deps = options.engineDeps ?? {};
  const primary = harnessDecisionProvider(env, deps);
  const model = env.MARINA_ADVISORY_FALLBACK_MODEL?.trim() || "marina/default";
  if (["none", "off"].includes(model.toLowerCase())) return primary ? [primary] : [];
  const fallback =
    model === "marina/default" && options.localFallback
      ? options.localFallback
      : classifierEngine(model, env, deps, "verbalized", {
          timeoutMs: advisoryTimeoutMs(env),
          reasoning: "off",
        });
  if (!primary) return [fallback];
  return primary.kind === fallback.kind && primary.model === fallback.model
    ? [primary]
    : [primary, fallback];
}

/** Cache identity includes the chain, method configuration and bound, never credentials. */
export function advisoryIdentity(options: AdvisoryOptions = {}): string {
  const env = options.env ?? process.env;
  let chain: string[][] = [];
  try {
    chain = advisoryProviders(options).map((p) => [p.kind, p.model]);
  } catch {
    chain = [["configuration_unavailable"]];
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        ADVISORY_VERSION,
        chain,
        env.MARINA_DECISION_METHOD,
        env.MARINA_DECISION_ENSEMBLE,
        env.MARINA_DECISION_BASE_URL,
        env.MARINA_DECISION_PATH,
        options.timeoutMs ?? advisoryTimeoutMs(env),
      ]),
    )
    .digest("hex");
}

function failureReason(error: unknown): NonNullable<DecisionReceipt["reason"]> {
  if (error instanceof DecisionError) {
    if (error.code === "spend_cap" || error.code === "timeout" || error.code === "invalid_response")
      return error.code;
  }
  return "backend_unavailable";
}

/**
 * One overall deadline, with half reserved for a fallback when there are two
 * providers. Race the signal as well: even a provider ignoring abort cannot
 * hold a user operation open. A spend stop or caller cancellation never falls
 * through to another billed backend.
 */
export async function askAdvisory(
  family: AdvisoryFamily,
  mode: Exclude<AdvisoryMode, "off">,
  request: DecisionRequest,
  options: AdvisoryOptions = {},
): Promise<{ receipt: DecisionReceipt; result?: DecisionResult }> {
  const started = performance.now();
  const receipt: DecisionReceipt = {
    id: randomUUID(),
    family,
    version: ADVISORY_VERSION,
    questionsHash: createHash("sha256").update(JSON.stringify(request.questions)).digest("hex"),
    mode,
    status: "unavailable",
    calibration: "unmeasured",
    fallback: false,
    attempts: 0,
    latencyMs: 0,
    costComplete: false,
    signals: {},
    action: "baseline",
    applied: false,
    createdAt: Date.now(),
  };
  let knownCosts = 0;
  const finish = (result?: DecisionResult) => {
    receipt.latencyMs = Math.round(performance.now() - started);
    receipt.costComplete = receipt.attempts > 0 && receipt.attempts === knownCosts;
    return { receipt, ...(result ? { result } : {}) };
  };
  const cap = options.spendCheck ?? (() => dailyCapRefusal(options.env));
  const timeout = options.timeoutMs ?? advisoryTimeoutMs(options.env);
  let providers: readonly DecisionProvider[];
  try {
    providers = advisoryProviders(options);
  } catch {
    receipt.reason = "backend_unavailable";
    return finish();
  }
  for (const [index, provider] of providers.entries()) {
    if (options.signal?.aborted) {
      receipt.reason = "aborted";
      break;
    }
    if (cap()) {
      receipt.reason = "spend_cap";
      break;
    }
    const remaining = timeout - (performance.now() - started);
    if (remaining <= 0) {
      receipt.reason = "timeout";
      break;
    }
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const timer = setTimeout(
      () => controller.abort(new DecisionError("Advisory deadline", "timeout")),
      index === 0 && providers.length > 1 ? remaining / 2 : remaining,
    );
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(signal.reason);
      signal.addEventListener("abort", rejectAbort, { once: true });
      if (signal.aborted) rejectAbort();
    });
    receipt.attempts++;
    receipt.fallback = index > 0;
    try {
      const reply = await Promise.race([
        Promise.resolve().then(() => provider.ask(request, signal)),
        aborted,
      ]);
      signal.throwIfAborted();
      if (Number.isFinite(reply.costUsd) && reply.costUsd! >= 0) {
        receipt.costUsd = (receipt.costUsd ?? 0) + reply.costUsd!;
        knownCosts++;
        if (provider !== options.localFallback) options.onCost?.(reply.costUsd!);
      }
      // Test/custom providers have the same contract as hosted backends.
      const result = { ...reply, answers: normalizeAnswers(request.questions, reply.answers) };
      receipt.status = "answered";
      delete receipt.reason;
      receipt.provider = result.provider;
      receipt.model = result.model;
      receipt.providerCalibrated = result.calibrated ?? provider.calibrated ?? false;
      for (const [key, answer] of Object.entries(result.answers)) {
        receipt.signals[key] =
          answer.type === "choice"
            ? answer.choice
            : answer.type === "score"
              ? answer.score
              : answer.noul;
      }
      return finish(result);
    } catch (error) {
      if (options.isFatal?.(error)) throw error;
      receipt.reason = options.signal?.aborted ? "aborted" : failureReason(error);
      if (receipt.reason === "spend_cap" || receipt.reason === "aborted") break;
    } finally {
      clearTimeout(timer);
      if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
      controller.abort();
    }
  }
  receipt.reason ??= "backend_unavailable";
  return finish();
}

/** Receipt writes are optional observability; their failure never fails the work. */
export function persistDecisionReceipt(
  db: Pick<DecisionsStore, "recordDecisionReceipt">,
  owner: string,
  subject: string,
  receipt: DecisionReceipt,
): void {
  tryLog(logger, "decisions", "Could not record advisory decision", () => {
    db.recordDecisionReceipt(owner, subject, receipt);
  });
}
