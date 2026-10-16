// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { WorkBudget } from "../coordination/work-budget";
import { maskSensitiveText } from "../decisions/gate";
import { getErrorMessage } from "../engine/errors";
import { dailyCapRefusal } from "../engine/spend-ledger";
import type { ForecastScale } from "../forecast/service";
import type { ModelPart, TypedForecastDeps } from "../forecast/typed";
import type { MarinaDB } from "../persistence/database";
import type { InvestigationAttempt, InvestigationEvent } from "../sdk/investigation-types";
import type { InvestigationCapacity } from "./capacity";
import { InvestigationError } from "./validation";

/** Detach locally on cancellation without claiming the upstream operation stopped. */
async function awaitStage<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
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

/** Keep secrets out of persisted input/output/error payloads, with an explicit capture gap. */
export function redactInvestigationValue(value: unknown, onRedaction: () => void): unknown {
  if (typeof value === "string") {
    const masked = maskSensitiveText(value, Number.MAX_SAFE_INTEGER);
    if (masked !== value) onRedaction();
    return masked;
  }
  if (Array.isArray(value)) return value.map((v) => redactInvestigationValue(v, onRedaction));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, redactInvestigationValue(v, onRedaction)]),
    );
  }
  return value;
}

export class InvestigationObservation {
  readonly gaps = new Set<string>();
  readonly controller = new AbortController();
  outstanding = 0;
  costUsd: () => number = () => 0;

  constructor(
    readonly db: MarinaDB,
    readonly attempt: InvestigationAttempt,
    readonly generation: string,
    readonly budget: WorkBudget,
    private readonly capacity?: InvestigationCapacity,
    private readonly canSettle: () => boolean = () => true,
  ) {}

  settle(knownUsd = this.costUsd()): void {
    if (this.canSettle())
      this.db.settleInvestigation(this.attempt.id, this.generation, {
        knownUsd,
        complete: false,
        outstanding: this.outstanding,
      });
  }

  check(): void {
    this.controller.signal.throwIfAborted();
    this.budget.signal.throwIfAborted();
    const snapshot = this.db.getInvestigation(
      this.attempt.actor.key,
      this.attempt.caseId,
      this.attempt.id,
    );
    if (snapshot.case.access === "read" || snapshot.attempt.state !== "running") {
      throw new InvestigationError(
        "inactive_attempt",
        "Work is no longer authorized or running",
        409,
      );
    }
  }

  capture(label: string, value: unknown): string {
    try {
      return this.db.storeInvestigationContent(
        this.attempt.id,
        this.generation,
        label,
        redactInvestigationValue(value, () =>
          this.gaps.add("Secret-shaped text was redacted from captured content"),
        ),
      );
    } catch (error) {
      this.controller.abort(error);
      throw error;
    }
  }

  event(event: Omit<InvestigationEvent, "attemptId" | "sequence" | "at">): void {
    try {
      this.db.appendInvestigationEvent(this.attempt.id, this.generation, event);
    } catch (error) {
      this.controller.abort(error);
      throw error;
    }
  }

  async stage<T>(
    label: string,
    actor: string,
    input: unknown,
    work: (signal: AbortSignal) => Promise<T>,
    consumesWork = true,
  ): Promise<T> {
    this.check();
    const capped = dailyCapRefusal();
    if (capped && consumesWork) throw new InvestigationError("spend_cap", capped, 429);
    const stageId = randomUUID();
    const inputId = this.capture(`${label}:input`, input);
    this.event({ kind: "stage_started", actor, stageId, inputId, message: label });
    const execute = async (signal: AbortSignal) => {
      this.check();
      signal.throwIfAborted();
      this.outstanding++;
      try {
        this.settle();
        return await work(signal);
      } finally {
        this.outstanding--;
        this.settle();
      }
    };
    try {
      const signal = AbortSignal.any([this.controller.signal, this.budget.signal]);
      const value = consumesWork
        ? await this.budget.run(
            (signal) => (this.capacity ? this.capacity.run(execute, signal) : execute(signal)),
            this.controller.signal,
          )
        : await awaitStage(execute(signal), signal);
      this.check();
      const outputId = this.capture(`${label}:output`, value ?? null);
      this.event({ kind: "stage_completed", actor, stageId, inputId, outputId, message: label });
      return value;
    } catch (error) {
      this.gaps.add(`Stage did not complete: ${label}`);
      // A stopped/deleted attempt must not be resurrected by late provider responses.
      if (!this.controller.signal.aborted && !this.budget.signal.aborted) {
        this.event({
          kind: "stage_failed",
          actor,
          stageId,
          inputId,
          message: maskSensitiveText(getErrorMessage(error), 600),
        });
      }
      throw error;
    }
  }

  instrument(
    deps: TypedForecastDeps,
    scale: ForecastScale,
    costUsd: () => number,
  ): TypedForecastDeps {
    this.costUsd = costUsd;
    this.capture("configuration", { scale, options: deps.options });
    const model = (part: ModelPart): ModelPart => {
      if (part.name.startsWith("marina:")) {
        throw new InvestigationError(
          "unsupported_private_crew",
          "Private investigation crew transport needs scoped evidence access and accounting; use a configured direct model for now",
          503,
        );
      }
      return {
        ...part,
        complete: (system, user) =>
          this.stage("model", part.name, { system, user }, () => part.complete(system, user)),
      };
    };
    const retriever = Object.assign(
      (brief: Parameters<TypedForecastDeps["retriever"]>[0]) =>
        this.stage("research", scale.retriever, brief, () => deps.retriever(brief)),
      deps.retriever,
    );
    const pageText = deps.pageText
      ? Object.assign(
          (url: string) =>
            this.stage("source_read", "retrieval", { url }, () => deps.pageText!(url), false),
          deps.pageText,
        )
      : undefined;
    // Adapter-internal calls/hidden reasoning are never inferred from returned text.
    this.gaps.add("Retriever-internal calls and provider-hidden reasoning are not captured");
    this.gaps.add(
      "Original source bytes may be unavailable; exact supplied model inputs are retained",
    );
    return {
      ...deps,
      retriever,
      analysts: deps.analysts.map(model),
      ...(deps.planner ? { planner: model(deps.planner) } : {}),
      ...(deps.critic ? { critic: model(deps.critic) } : {}),
      ...(deps.verifier ? { verifier: model(deps.verifier) } : {}),
      ...(pageText ? { pageText } : {}),
      ...(deps.judge
        ? {
            judge: {
              ...deps.judge,
              kind: deps.judge.kind,
              model: deps.judge.model,
              calibrated: deps.judge.calibrated,
              ask: (request, signal) =>
                this.stage("judge", deps.judge!.model, request, (stageSignal) =>
                  deps.judge!.ask(
                    request,
                    signal ? AbortSignal.any([stageSignal, signal]) : stageSignal,
                  ),
                ),
            },
          }
        : {}),
      ...(deps.lookups
        ? {
            lookups: deps.lookups.map((lookup) => ({
              ...lookup,
              lookup: (...args: Parameters<typeof lookup.lookup>) =>
                this.stage("lookup", lookup.name, args, () => lookup.lookup(...args), false),
            })),
          }
        : {}),
      ...(deps.lessons
        ? {
            lessons: {
              recall: (...args: Parameters<NonNullable<TypedForecastDeps["lessons"]>["recall"]>) =>
                this.stage("lessons", "memory", args, () => deps.lessons!.recall(...args), false),
            },
          }
        : {}),
    };
  }
}
