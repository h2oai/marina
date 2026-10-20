// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a model call is FOR. Every `src/model` call carries one; the spend
 * ledger records the dollar under the coarse `source` below (the
 * `spend_daily` CHECK allows six) and under a `purpose:<name>` breakdown row
 * (`recordPurposeSpend`), and the trace span carries it as `purpose`.
 */

import type { SpendSource } from "../engine/spend-ledger";

export const MODEL_PURPOSES = [
  "forecast",
  "arena",
  "research",
  "lessons",
  "outcomes",
  "swarm",
  "judge",
  "benchmark",
  "agent",
  "other",
] as const;

export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

/**
 * The ledger source of each purpose. Forecast, arena and research (retrieval
 * for a forecast) stay `forecast`; a judge is a `decision`; a tool-using turn
 * outside the world is `agent`; everything else made in-process (lessons,
 * outcome extraction, the web swarm, benchmark checkers) is `model_api`.
 * Before 2026-10-20 every `modelComplete` dollar was `forecast`.
 */
const SPEND_SOURCE: Record<ModelPurpose, SpendSource> = {
  forecast: "forecast",
  arena: "forecast",
  research: "forecast",
  lessons: "model_api",
  outcomes: "model_api",
  swarm: "model_api",
  judge: "decision",
  benchmark: "model_api",
  agent: "agent",
  other: "model_api",
};

export function spendSourceFor(purpose: ModelPurpose): SpendSource {
  return SPEND_SOURCE[purpose];
}
