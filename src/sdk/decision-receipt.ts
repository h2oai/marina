// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export type AdvisoryMode = "off" | "observe" | "on";
export type AdvisoryFamily = "research" | "context" | "deliverable" | "routing";

/** Measurements of a judgment, never task text or proof of downstream success. */
export interface DecisionReceipt {
  id: string;
  family: AdvisoryFamily;
  version: string;
  questionsHash: string;
  mode: Exclude<AdvisoryMode, "off">;
  status: "answered" | "unavailable";
  reason?:
    | "timeout"
    | "aborted"
    | "spend_cap"
    | "invalid_response"
    | "backend_unavailable"
    | "no_evidence";
  /** The actual answering backend; purpose-built does not imply task calibration. */
  provider?: string;
  model?: string;
  providerCalibrated?: boolean;
  calibration: "unmeasured";
  fallback: boolean;
  attempts: number;
  latencyMs: number;
  costUsd?: number;
  /** False if any attempted backend did not report its cost (e.g. timeout). */
  costComplete: boolean;
  /** Only fixed question/option labels and numbers. No free-form model output. */
  signals: Record<string, string | number>;
  action: string;
  applied: boolean;
  createdAt: number;
}
