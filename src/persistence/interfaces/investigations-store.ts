// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as investigationCollaborationDb from "../db-investigation-collaboration";
import type * as investigationJournalDb from "../db-investigation-journal";
import type * as investigationLifecycleDb from "../db-investigation-lifecycle";
import type * as investigationSpendDb from "../db-investigation-spend";
import type * as investigationsDb from "../db-investigations";
import type { ExactKeys } from "./exact-keys";

export type StoreArguments<T extends (...args: never[]) => unknown> =
  Parameters<T> extends [unknown, ...infer A] ? A : never;

/** Scoped prediction/research records. Query functions are the single signature authority. */
export interface InvestigationsStore {
  recordInvestigationSpend(
    ...args: StoreArguments<typeof investigationSpendDb.recordInvestigationSpend>
  ): void;
  investigationSpendAccounting(
    ...args: StoreArguments<typeof investigationSpendDb.investigationSpendAccounting>
  ): ReturnType<typeof investigationSpendDb.investigationSpendAccounting>;
  reviewInvestigation(
    ...args: StoreArguments<typeof investigationCollaborationDb.reviewInvestigation>
  ): ReturnType<typeof investigationCollaborationDb.reviewInvestigation>;
  investigationResolutionTarget(
    ...args: StoreArguments<typeof investigationCollaborationDb.investigationResolutionTarget>
  ): ReturnType<typeof investigationCollaborationDb.investigationResolutionTarget>;
  recordInvestigationResolution(
    ...args: StoreArguments<typeof investigationCollaborationDb.recordInvestigationResolution>
  ): ReturnType<typeof investigationCollaborationDb.recordInvestigationResolution>;
  settleInvestigation(
    ...args: StoreArguments<typeof investigationLifecycleDb.settleInvestigation>
  ): ReturnType<typeof investigationLifecycleDb.settleInvestigation>;
  createInvestigation(
    ...args: StoreArguments<typeof investigationsDb.createInvestigation>
  ): ReturnType<typeof investigationsDb.createInvestigation>;
  getInvestigation(
    ...args: StoreArguments<typeof investigationsDb.getInvestigation>
  ): ReturnType<typeof investigationsDb.getInvestigation>;
  getInvestigationAttempt(
    ...args: StoreArguments<typeof investigationsDb.getInvestigationAttempt>
  ): ReturnType<typeof investigationsDb.getInvestigationAttempt>;
  listInvestigations(
    ...args: StoreArguments<typeof investigationsDb.listInvestigations>
  ): ReturnType<typeof investigationsDb.listInvestigations>;
  grantInvestigation(
    ...args: StoreArguments<typeof investigationsDb.grantInvestigation>
  ): ReturnType<typeof investigationsDb.grantInvestigation>;
  selectInvestigationAttempt(
    ...args: StoreArguments<typeof investigationsDb.selectInvestigationAttempt>
  ): ReturnType<typeof investigationsDb.selectInvestigationAttempt>;
  appendInvestigationEvent(
    ...args: StoreArguments<typeof investigationJournalDb.appendInvestigationEvent>
  ): ReturnType<typeof investigationJournalDb.appendInvestigationEvent>;
  storeInvestigationContent(
    ...args: StoreArguments<typeof investigationJournalDb.storeInvestigationContent>
  ): ReturnType<typeof investigationJournalDb.storeInvestigationContent>;
  getInvestigationContent(
    ...args: StoreArguments<typeof investigationJournalDb.getInvestigationContent>
  ): ReturnType<typeof investigationJournalDb.getInvestigationContent>;
  readInvestigationEvents(
    ...args: StoreArguments<typeof investigationJournalDb.readInvestigationEvents>
  ): ReturnType<typeof investigationJournalDb.readInvestigationEvents>;
  claimInvestigation(
    ...args: StoreArguments<typeof investigationLifecycleDb.claimInvestigation>
  ): ReturnType<typeof investigationLifecycleDb.claimInvestigation>;
  finishInvestigation(
    ...args: StoreArguments<typeof investigationLifecycleDb.finishInvestigation>
  ): ReturnType<typeof investigationLifecycleDb.finishInvestigation>;
  cancelInvestigation(
    ...args: StoreArguments<typeof investigationLifecycleDb.cancelInvestigation>
  ): ReturnType<typeof investigationLifecycleDb.cancelInvestigation>;
  recoverInvestigations(
    ...args: StoreArguments<typeof investigationLifecycleDb.recoverInvestigations>
  ): ReturnType<typeof investigationLifecycleDb.recoverInvestigations>;
  isPrivateForecast(
    ...args: StoreArguments<typeof investigationLifecycleDb.isPrivateForecast>
  ): ReturnType<typeof investigationLifecycleDb.isPrivateForecast>;
  eraseInvestigation(
    ...args: StoreArguments<typeof investigationLifecycleDb.eraseInvestigation>
  ): ReturnType<typeof investigationLifecycleDb.eraseInvestigation>;
}

export const INVESTIGATIONS_STORE_METHODS = [
  "recordInvestigationSpend",
  "investigationSpendAccounting",
  "reviewInvestigation",
  "investigationResolutionTarget",
  "recordInvestigationResolution",
  "settleInvestigation",
  "createInvestigation",
  "getInvestigation",
  "getInvestigationAttempt",
  "listInvestigations",
  "grantInvestigation",
  "selectInvestigationAttempt",
  "appendInvestigationEvent",
  "storeInvestigationContent",
  "getInvestigationContent",
  "readInvestigationEvents",
  "claimInvestigation",
  "finishInvestigation",
  "cancelInvestigation",
  "recoverInvestigations",
  "isPrivateForecast",
  "eraseInvestigation",
] as const satisfies readonly (keyof InvestigationsStore)[];
export const INVESTIGATIONS_STORE_COMPLETE: ExactKeys<
  InvestigationsStore,
  typeof INVESTIGATIONS_STORE_METHODS
> = true;
