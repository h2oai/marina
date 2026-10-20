// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared in-process model backend every library pipeline uses (forecast,
 * arena, research, lessons, outcomes, the web swarm, benchmarks): one call
 * core (`call.ts`) for spend, tracing, retries and route fallback.
 */

export { callCost, isLoopbackMarinaSpec, modelAccess, PROVIDER_KEYS, type Usage } from "./access";
export { type ModelCallOptions, modelCall, modelRouteFallbackEnabled } from "./call";
export { type ModelCompleteOptions, modelComplete } from "./complete";
export { MODEL_PURPOSES, type ModelPurpose, spendSourceFor } from "./purpose";
export { type Complete, parseReply } from "./reply";
export {
  attachModelTraceSink,
  type ModelLifecycleEvent,
  type ModelTraceContext,
} from "./trace";
export {
  type ModelTurns,
  type ModelTurnsOptions,
  messageText,
  modelTurns,
  type TurnFn,
} from "./turns";
