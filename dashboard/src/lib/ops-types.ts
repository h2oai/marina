// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard view of the ops contract served by `GET /api/ops/overview` and
 * `POST /api/ops/agents/:name/stop`.
 *
 * The wire contract is NOT mirrored here — it is re-exported (type-only) from
 * the backend's single source of truth, `src/net/ops-types.ts`, so a field
 * added or renamed on the server is the same field here. `export type … from`
 * is erased by Vite (`isolatedModules`) and the backend file is
 * dependency-free, so the bundle never pulls in anything else from `src/`.
 *
 * What IS declared locally is dashboard-only: the named aliases the components
 * key on (derived by indexed access, so they follow the contract).
 * `src/__tests__/ops-contract.test.tsx` pins these to the backend shapes.
 */

export type {
  AgentOperatorRow,
  OpsAgentPauseKind,
  OpsAgentStopResponse,
  OpsLimiter,
  OpsOverview,
  OpsPrompt,
  OpsPromptSection,
  OpsRetention,
  OpsRetentionPolicy,
  OpsRetentionReport,
  OpsSecurity,
  OpsSpend,
  OpsToolProfile,
  ProviderProbeSummary,
} from "../../../src/net/ops-types";

import type { AgentOperatorRow, OpsOverview, OpsRetentionPolicy } from "../../../src/net/ops-types";

// ── Named aliases (derived — never restate the union) ───────────────────────

export type OpsScope = OpsOverview["scope"];
export type OpsRetentionKind = OpsRetentionPolicy["kind"];
/** The active pause on a row; `AgentOperatorRow.paused` itself is `… | null`. */
export type AgentPause = NonNullable<AgentOperatorRow["paused"]>;
