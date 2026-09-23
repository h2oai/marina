// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as evidenceDb from "../db-evidence";
import type { ExactKeys } from "./exact-keys";

/** Evidence receipt chain (`db-evidence.ts`). */
export interface EvidenceStore {
  appendEvidenceReceipt(
    input: Parameters<typeof evidenceDb.appendEvidenceReceipt>[1],
  ): evidenceDb.EvidenceReceiptRow;
  listEvidenceReceipts(limit?: number): evidenceDb.EvidenceReceiptRow[];
  verifyEvidenceChain(): evidenceDb.EvidenceVerification;
}

/** Runtime mirror of `EvidenceStore`'s method names — the drift test compares it to the facade. */
export const EVIDENCE_STORE_METHODS = [
  "appendEvidenceReceipt",
  "listEvidenceReceipts",
  "verifyEvidenceChain",
] as const satisfies readonly (keyof EvidenceStore)[];

export const EVIDENCE_STORE_COMPLETE: ExactKeys<EvidenceStore, typeof EVIDENCE_STORE_METHODS> =
  true;
