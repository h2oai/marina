// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { WorkBudget } from "../coordination/work-budget";
import { maskSensitiveText } from "../decisions/gate";
import { getErrorMessage, tryLog } from "../engine/errors";
import { Logger } from "../engine/logger";
import type { MarinaDB } from "../persistence/database";
import type { InvestigationCompletion } from "../persistence/db-investigation-lifecycle";
import type {
  InvestigationActor,
  InvestigationAttempt,
  InvestigationRequest,
} from "../sdk/investigation-types";
import { InvestigationCapacity } from "./capacity";
import { executeInvestigation } from "./executor";
import { InvestigationObservation } from "./observe";
import { InvestigationError, investigationLimits } from "./validation";

export interface InvestigationExecutionContext {
  db: MarinaDB;
  attempt: InvestigationAttempt;
  observation: InvestigationObservation;
  /** Orchestration is outside a leaf capacity slot: a parent may await its child at concurrency one. */
  child(request: InvestigationRequest, key: string): Promise<InvestigationAttempt>;
}
export type InvestigationExecutor = (context: InvestigationExecutionContext) => Promise<
  Omit<InvestigationCompletion, "state" | "error"> & {
    result: NonNullable<InvestigationCompletion["result"]>;
  }
>;

const logger = new Logger();

export class InvestigationService {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly observations = new Map<string, InvestigationObservation>();
  private readonly budgets = new Map<string, WorkBudget>();
  private readonly roots = new Map<string, string>();
  private readonly capacity = new InvestigationCapacity();
  private closed = false;

  constructor(
    readonly db: MarinaDB,
    private readonly executor: InvestigationExecutor = executeInvestigation,
  ) {
    db.recoverInvestigations();
  }

  start(
    actor: InvestigationActor,
    request: InvestigationRequest,
    key: string,
  ): { attempt: InvestigationAttempt; created: boolean } {
    if (this.closed)
      throw new InvestigationError("stopped", "Investigation service is stopping", 503);
    const admitted = this.db.createInvestigation(actor, request, key);
    if (admitted.created) {
      const root = admitted.attempt.rootAttemptId;
      this.roots.set(admitted.attempt.id, root);
      if (!this.budgets.has(root))
        this.budgets.set(
          root,
          new WorkBudget(investigationLimits(admitted.attempt.request.limits)),
        );
      // Defer execution until the caller has its durable ID; no command slot waits on a model.
      const work = Promise.resolve().then(() => this.run(admitted.attempt));
      this.pending.set(admitted.attempt.id, work);
      void work
        .finally(() => {
          this.pending.delete(admitted.attempt.id);
          this.observations.delete(admitted.attempt.id);
          this.roots.delete(admitted.attempt.id);
          if (![...this.roots.values()].includes(root)) this.budgets.delete(root);
        })
        .catch((error) =>
          logger.error("main", "Investigation executor failed", {
            id: admitted.attempt.id,
            error: getErrorMessage(error),
          }),
        );
    }
    return admitted;
  }

  private async run(attempt: InvestigationAttempt): Promise<void> {
    if (this.closed) return;
    const generation = this.db.claimInvestigation(attempt.id);
    if (!generation) return;
    const budget = this.budgets.get(attempt.rootAttemptId);
    if (!budget) throw new InvestigationError("missing_budget", "Execution budget missing", 500);
    const observation = new InvestigationObservation(
      this.db,
      attempt,
      generation,
      budget,
      this.capacity,
      () => !this.closed,
    );
    this.observations.set(attempt.id, observation);
    try {
      observation.capture("admission", {
        request: attempt.request,
        actor: attempt.actor,
        limits: budget.limits,
      });
      const completion = await observation.observe(() =>
        this.executor({
          db: this.db,
          attempt,
          observation,
          child: async (request, key) => {
            observation.check();
            const child = this.start(
              attempt.actor,
              { ...request, parentAttemptId: attempt.id },
              key,
            ).attempt;
            await this.wait(child.id);
            return this.db.getInvestigationAttempt(attempt.actor.key, child.id);
          },
        }),
      );
      observation.check();
      const result = completion.result;
      result.capture = {
        status: observation.gaps.size ? "partial" : result.capture.status,
        gaps: [...new Set([...result.capture.gaps, ...observation.gaps])],
      };
      result.accounting = observation.accounting(
        Math.max(result.accounting.knownUsd, observation.costUsd()),
      );
      observation.settle(result.accounting.reportedUsd ?? result.accounting.knownUsd);
      this.db.finishInvestigation(attempt.id, generation, {
        ...completion,
        result,
        state: "completed",
      });
    } catch (error) {
      observation.controller.abort(error);
      if (!this.closed)
        tryLog(logger, "main", "Could not persist investigation failure", () => {
          this.db.finishInvestigation(attempt.id, generation, {
            state: "failed",
            error: maskSensitiveText(getErrorMessage(error), 1000),
          });
        });
    }
  }

  async wait(id: string): Promise<void> {
    await this.pending.get(id);
  }

  cancel(principal: string, id: string): string[] {
    const cancelled = this.db.cancelInvestigation(principal, id);
    for (const attemptId of cancelled)
      this.observations.get(attemptId)?.controller.abort(new Error("Investigation cancelled"));
    return cancelled;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const observation of this.observations.values())
      observation.controller.abort(new Error("Executor stopped"));
    for (const budget of this.budgets.values()) budget.cancel(new Error("Executor stopped"));
    this.db.recoverInvestigations();
  }
}

const services = new WeakMap<MarinaDB, InvestigationService>();

export function investigationService(db: MarinaDB): InvestigationService {
  let service = services.get(db);
  if (!service) {
    service = new InvestigationService(db);
    services.set(db, service);
  }
  return service;
}

export function closeInvestigationService(db: MarinaDB | undefined): void {
  if (db) services.get(db)?.close();
}
