// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reproduction kit — shared types. A setup turns flags into a `Plan`: a list
 * of steps (isolated Marina servers, commands, ledger comparisons) plus a cost
 * estimate. `--dry-run` prints the plan; `run.ts` executes it. Plans are pure
 * data so they can be tested without a model call or a server.
 */

/** What intelligence is available — every setup must run at every tier. */
export type ModelTier = "frontier" | "single-provider" | "single-local" | "none";

export interface ReproFlags {
  /** Arms to run (default: every arm of the setup). */
  arms?: string[];
  replicates: number;
  /** Items per arm and replicate (default: the setup's smoke size). */
  limit?: number;
  budgetUsd: number;
  /** Answer model; defaults depend on the tier. */
  model?: string;
  /** Checker / reviewer model for verification arms (default: same as the answer model at single tiers). */
  checker?: string;
  /** Judge model for graded sets (always routed through a Marina server). */
  judge?: string;
  /** τ² domain, SWE-bench env-image mode, FutureX isolation … (setup-specific). */
  domain?: string;
  /** τ² task split (e.g. `test`); default: the domain's full task set, capped by `--limit`. */
  split?: string;
  /**
   * Agent reasoning effort (τ²). Sent in `extra_body`: LiteLLM's `drop_params` silently
   * strips a top-level `reasoning_effort` for model ids it does not know (every
   * Marina-routed id). Default `high`, as the τ² board runs agents.
   */
  effort?: string;
  /** User-simulator reasoning effort (τ²), stated explicitly; default `low`. */
  userEffort?: string;
  /**
   * τ³ `banking_knowledge` knowledge-base retrieval configuration (τ²'s `--retrieval-config`,
   * reported on the board as a badge). Default `alltools`, the configuration the board's
   * reference runs use. Refused for other domains.
   */
  retrievalConfig?: string;
  /** τ²: run only these task ids (τ²'s `--task-ids`); a pre-registered subset, never the board split. */
  taskIds?: string[];
  envImage?: boolean;
  seed: number;
  /** Where servers, databases, scratch and results live (on disk, never a tmpfs). */
  runDir: string;
  /** The ledger every run files into. */
  ledgerDb: string;
}

export interface ServerStep {
  kind: "server";
  /** Stable id other steps refer to. */
  id: string;
  port: number;
  /** Marina world (`empty` for a plain model server, `showcase` for crews). */
  world: string;
  /** Extra environment for this server (keys are never printed). */
  env: Record<string, string>;
  /** Operator commands run once the server is healthy (crew formation, dispatch …). */
  operator?: string[];
  /** A model id the server must list on `/v1/models` before the next step (a crew endpoint). */
  waitModel?: string;
}

export interface CommandStep {
  kind: "command";
  label: string;
  argv: string[];
  env?: Record<string, string>;
  /** Working directory (default: the Marina checkout). `$TAU2_HOME` is expanded. */
  cwd?: string;
  /** Servers that must be up while this runs. */
  needs?: string[];
  /**
   * Give the process the operator's provider keys from `.env` (never printed) and
   * drop any `OPENAI_BASE_URL` / `OPENAI_API_BASE` override, so a third-party
   * evaluator's own model calls (τ²'s NL-assertion judge) reach the provider it ships
   * with instead of failing as infrastructure errors.
   */
  providerEnv?: boolean;
}

export interface CompareStep {
  kind: "compare";
  benchmark: string;
  /** Replicate groups compared as A − B (pooled two-stage bootstrap). */
  a: string;
  b: string;
}

export interface StopStep {
  kind: "stop";
  id: string;
}

export type Step = ServerStep | CommandStep | CompareStep | StopStep;

export interface Plan {
  setup: string;
  tier: ModelTier;
  arms: string[];
  replicates: number;
  limit: number;
  /** Estimated total spend in USD (0 for keyless / local-only plans). */
  estimateUsd: number;
  /** One line per arm: what it is and the per-item estimate. */
  armNotes: string[];
  /** Doctor check ids this plan needs to pass. */
  requires: string[];
  /** Honest labels (e.g. "single local model: verification = self-check"). */
  labels: string[];
  steps: Step[];
}

export interface ArmSpec {
  name: string;
  describe: string;
  /** Rough USD per item at the frontier tier (0 when keyless or local). */
  usdPerItem: number;
  /** Runs only when named with `--arm` (never part of the default comparison). */
  optIn?: boolean;
}

export interface Setup {
  name: string;
  summary: string;
  /** Default items per arm and replicate — small and cheap. */
  smoke: number;
  /** The published full size, documented for a complete run. */
  full: number;
  arms: ArmSpec[];
  requires: string[];
  plan(flags: ReproFlags, tier: ModelTier): Plan;
}
