// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory admission ranking: one general step that compares a curated write
 * with its nearest existing records and ranks it, so duplicates merge,
 * refinements supersede, contradictions open a resolve case, and recall can
 * prefer the records with the highest expected value.
 *
 *   MARINA_MEMORY_RANKING=off|observe|on   (default off)
 *     off      today's behaviour: the write is not compared or ranked
 *     observe  rank and the PROPOSED action are computed and stored with the
 *              record; writes and serving are unchanged (the measurement arm)
 *     on       the action is applied (merge / supersede / contest / new) and
 *              recall orders served records by trust, then rank, then recency
 *
 * Steps per write (`admitMemoryWrite`):
 *   1. neighbours — the caller's top-k (8) valid records, found through the
 *      memory service `search` (`searchNeighbourRecords`): lexical by default,
 *      hybrid when `MARINA_MEMORY_EMBEDDINGS` is configured, falling back to
 *      lexical with the degradation labelled, never an error;
 *   2. the mechanical pre-screen (`admission-policy.ts`): duplicates merge with
 *      no model call; no relevant neighbour ⇒ novel by construction;
 *   3. ONE numbers-only decision request (`relation`, `novelty`, `generality`,
 *      `evidence_fit`, `value`); evidence strength is mechanical (`E_m`);
 *   4. the pure policy and the `v1` rank formula, weights read through
 *      `resolveDefault` (slot `memory-ranking:weights`; built-in `v1`).
 *
 * Degraded modes: no decision backend ⇒ behaves as off; a backend outage or
 * the daily spend cap ⇒ the write proceeds as off would (labelled, never
 * blocked); an uncalibrated backend (a chat model as classifier) gets one cut
 * at 0.5, merges also need mechanical similarity, and contradictions are never
 * auto-resolved. The decision call's spend is recorded where it leaves Marina
 * (the metered decision provider, or this Marina's `/v1` passthru for a
 * classifier engine); hybrid search records its query embedding through the
 * embedding provider's `recordSpend("search")`. Admission checks
 * `dailyCapRefusal` before asking.
 *
 * Admission never writes SQL: it returns an action and a rank; the caller
 * applies it through the memory service (`remember` / `revise` / `resolve`).
 */

import type { DecisionProvider } from "../decisions/types";
import { type DefaultSlotReader, resolveDefault } from "../engine/default-resolution";
import { dailyCapRefusal } from "../engine/spend-ledger";
import type { MemoryOperationRequest } from "../sdk/memory-operations";
import {
  type AdmissionAction,
  type AdmissionCandidate,
  type AdmissionNeighbour,
  admissionQuestions,
  admissionState,
  decideAdmission,
  levelExpectation,
  type MemoryRankingMode,
  NEIGHBOUR_K,
  neighbourLabel,
  prescreen,
  RANK_METHOD,
  RANK_WEIGHTS_V1,
  type RankComponents,
  type RankWeights,
  type RelationVerdict,
  rankScore,
  readRankWeights,
  readRelation,
  trustAbove,
} from "./admission-policy";
import { relevantToQuery } from "./unified-context";

export type { MemoryRankingMode } from "./admission-policy";

/** `MARINA_MEMORY_RANKING` (default off; anything unrecognised is off). */
export function memoryRankingMode(env: NodeJS.ProcessEnv = process.env): MemoryRankingMode {
  const v = env.MARINA_MEMORY_RANKING?.trim().toLowerCase();
  if (v === "on" || v === "true") return "on";
  if (v === "observe") return "observe";
  return "off";
}

/** Ranked serving: recall orders by trust, then rank, then recency. */
export function rankedServing(env: NodeJS.ProcessEnv = process.env): boolean {
  return memoryRankingMode(env) === "on";
}

/** Hybrid neighbour search is configured (`MARINA_MEMORY_EMBEDDINGS` names a provider). */
export function hybridNeighbours(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.MARINA_MEMORY_EMBEDDINGS?.trim().toLowerCase();
  return !!v && v !== "none";
}

export const RANK_WEIGHTS_SLOT = "memory-ranking:weights";

/** The rank weights: a promoted slot value when one was earned, else `v1`. */
export function rankWeights(db?: DefaultSlotReader): { weights: RankWeights; source: string } {
  const r = resolveDefault<RankWeights>({
    slot: RANK_WEIGHTS_SLOT,
    read: readRankWeights,
    builtIn: RANK_WEIGHTS_V1,
    builtInLabel: `rank ${RANK_METHOD}`,
    ...(db ? { db } : {}),
    surface: "memory-admission",
  });
  return { weights: r.value, source: r.source };
}

// ─── Neighbour search ───────────────────────────────────────────────────────

type MemoryRun = (request: MemoryOperationRequest) => Promise<{ ok: true; result: unknown }>;

export interface NeighbourRecords<R> {
  records: R[];
  /** The space generation the search saw (stale-rank detection). */
  generation?: number;
  mode: "lexical" | "hybrid";
  /** Why a hybrid search answered lexically (`semantic_not_configured`, …). */
  degraded: string[];
}

/**
 * Valid records of `space` nearest `query`, through the memory service
 * `search` (the validity filter excludes retired records). Hybrid when asked
 * for, with degradation allowed and labelled; a failing hybrid search retries
 * lexically, labelled `degraded`. Never throws for a search outage of the
 * hybrid half; a failing lexical search is the caller's error.
 */
export async function searchNeighbourRecords<R = Record<string, unknown>>(
  run: MemoryRun,
  space: string,
  query: string,
  opts: { limit?: number; hybrid?: boolean; subject?: string } = {},
): Promise<NeighbourRecords<R>> {
  const base = {
    query,
    limit: opts.limit ?? 50,
    ...(opts.subject ? { subject: opts.subject } : {}),
  };
  const read = (result: unknown, mode: "lexical" | "hybrid", extra: string[] = []) => {
    const r = (result ?? {}) as { results?: R[]; generation?: unknown; degraded?: unknown };
    const degraded = [
      ...extra,
      ...(Array.isArray(r.degraded) ? r.degraded.filter((x) => typeof x === "string") : []),
    ];
    return {
      records: r.results ?? [],
      ...(typeof r.generation === "number" ? { generation: r.generation } : {}),
      mode: mode === "hybrid" && degraded.length ? ("lexical" as const) : mode,
      degraded,
    };
  };
  if (opts.hybrid) {
    try {
      const reply = await run({
        operation: "search",
        space_id: space,
        input: { ...base, mode: "hybrid", allow_degraded: true },
      });
      return read(reply.result, "hybrid");
    } catch {
      const reply = await run({
        operation: "search",
        space_id: space,
        input: { ...base, mode: "lexical" },
      });
      return read(reply.result, "lexical", ["hybrid_search_failed"]);
    }
  }
  const reply = await run({
    operation: "search",
    space_id: space,
    input: { ...base, mode: "lexical" },
  });
  return read(reply.result, "lexical");
}

// ─── Admission ──────────────────────────────────────────────────────────────

export interface NeighbourSet {
  /** Nearest first; only the first `NEIGHBOUR_K` are shown to the judge. */
  neighbours: AdmissionNeighbour[];
  generation?: number;
  mode: "lexical" | "hybrid";
  degraded: string[];
}

/** The rank and provenance stored with a record (metadata `rank`). */
export interface StoredRank {
  score: number;
  components: RankComponents;
  method: string;
  /** `kind:model` of the decision backend that answered. */
  judge: string;
  calibrated: boolean;
  /** `id@version` of every neighbour the judge saw. */
  neighbours: string[];
  space_generation?: number;
  ranked_at: string;
  /** Where the weights came from (`builtin`, `slot`, …). */
  weights: string;
  search: "lexical" | "hybrid";
  degraded?: string[];
}

export interface AdmissionResult {
  action: AdmissionAction;
  target?: AdmissionNeighbour;
  autoResolve?: boolean;
  reason: string;
  similarity?: number;
  /** Decided by the pre-screen, with no model call. */
  mechanical: boolean;
  /** The judge's relation pick, when it was asked. */
  relation?: RelationVerdict;
  rank?: StoredRank;
  /**
   * The write was not ranked and proceeds as `off` would: no decision backend,
   * a backend outage, or the daily spend cap.
   */
  skipped?: "no_backend" | "judge_unavailable" | "spend_cap";
  costUsd?: number;
}

export interface AdmitOptions {
  neighbours: NeighbourSet;
  provider?: DecisionProvider;
  weights?: { weights: RankWeights; source: string };
  /** The daily-cap check (default `dailyCapRefusal`). */
  spendCheck?: () => string | undefined;
  now?: () => number;
  signal?: AbortSignal;
}

/**
 * Admit one candidate against its neighbours: pre-screen, at most one
 * decision call, the pure policy, and the rank. Never throws: every failure is
 * a `skipped` result the caller treats as off.
 */
export async function admitMemoryWrite(
  candidate: AdmissionCandidate,
  opts: AdmitOptions,
): Promise<AdmissionResult> {
  const neighbours = opts.neighbours.neighbours.slice(0, NEIGHBOUR_K);
  const screen = prescreen(candidate, neighbours, (n) => relevantToQuery(n.text, candidate.text));
  if (screen.kind === "duplicate") {
    const target = screen.neighbour;
    // A duplicate with higher trust replaces the record instead of merging into it.
    return {
      action: trustAbove(candidate.trust, target.trust) ? "supersede" : "merge",
      target,
      reason: screen.exact ? "exact duplicate" : "near duplicate",
      similarity: Math.round(screen.similarity * 1000) / 1000,
      mechanical: true,
    };
  }
  if (!opts.provider)
    return {
      action: "new",
      reason: "no decision backend",
      mechanical: false,
      skipped: "no_backend",
    };
  const capped = (opts.spendCheck ?? dailyCapRefusal)();
  if (capped) return { action: "new", reason: capped, mechanical: false, skipped: "spend_cap" };
  const shown = screen.kind === "novel" ? [] : neighbours;
  let result: Awaited<ReturnType<DecisionProvider["ask"]>>;
  try {
    result = await opts.provider.ask(
      { state: admissionState(candidate, shown), questions: admissionQuestions(shown.length) },
      opts.signal,
    );
  } catch {
    return {
      action: "new",
      reason: "decision backend unavailable",
      mechanical: false,
      skipped: "judge_unavailable",
    };
  }
  const calibrated = opts.provider.calibrated !== false && result.calibrated !== false;
  const relation = shown.length ? readRelation(result.answers.relation) : undefined;
  const value = levelExpectation(result.answers.value, 5);
  const generality = levelExpectation(result.answers.generality, 4);
  const evidenceFit = levelExpectation(result.answers.evidence_fit, 3);
  const novelty = shown.length ? levelExpectation(result.answers.novelty, 4) : { e: 1 };
  if (!value || !generality || !evidenceFit || !novelty || (shown.length && !relation)) {
    return {
      action: "new",
      reason: "decision backend answered incompletely",
      mechanical: false,
      skipped: "judge_unavailable",
    };
  }
  const components: RankComponents = {
    value,
    generality,
    novelty,
    evidence_fit: evidenceFit,
    evidence: candidate.evidence,
  };
  const weights = opts.weights ?? { weights: RANK_WEIGHTS_V1, source: "builtin" };
  const verdict = decideAdmission({
    candidate,
    neighbours: shown,
    ...(relation ? { relation } : {}),
    calibrated,
  });
  const rank: StoredRank = {
    score: rankScore(components, candidate.trust, weights.weights),
    components,
    method: RANK_METHOD,
    judge: `${result.provider || opts.provider.kind}:${result.model || opts.provider.model}`,
    calibrated,
    neighbours: shown.map((n) => `${n.id}@${n.version ?? "?"}`),
    ...(opts.neighbours.generation === undefined
      ? {}
      : { space_generation: opts.neighbours.generation }),
    ranked_at: new Date((opts.now ?? Date.now)()).toISOString(),
    weights: weights.source,
    search: opts.neighbours.mode,
    ...(opts.neighbours.degraded.length ? { degraded: opts.neighbours.degraded } : {}),
  };
  return {
    action: verdict.action,
    ...(verdict.target ? { target: verdict.target } : {}),
    ...(verdict.autoResolve ? { autoResolve: true } : {}),
    reason: verdict.reason,
    ...(verdict.similarity === undefined ? {} : { similarity: verdict.similarity }),
    mechanical: false,
    ...(relation ? { relation } : {}),
    rank,
    ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
  };
}

/** A short label for a relation verdict (`same_as_N2 p0.81`), for stored provenance. */
export function relationLabel(r: RelationVerdict | undefined): string | undefined {
  if (!r) return undefined;
  const name = r.index === undefined ? r.kind : `${r.kind}_${neighbourLabel(r.index)}`;
  return `${name} p${Math.round(r.p * 100) / 100}`;
}
