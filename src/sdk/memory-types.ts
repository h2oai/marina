// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MemoryExpansionCoverage, MemoryQueryExpansion } from "./memory-expansion";

export type MemoryTerm =
  | { kind: "entity"; id: string }
  | { kind: "literal"; value: string | number | boolean | null };
export interface MemoryClaim {
  subject: string;
  predicate: string;
  object: MemoryTerm;
}
export interface MemoryQuery {
  include_stale?: boolean;
  valid_at?: number;
  subject?: string;
  predicate?: string;
  object?: MemoryTerm;
  type?: string;
  tier?: string;
  limit?: number;
  cursor?: string;
}
export interface MemoryQueryResult {
  space_id: string;
  generation: number;
  mode: "symbolic";
  results: MemoryRecord[];
  next_cursor: string | null;
}
export interface MemoryGraphQuery {
  include_stale?: boolean;
  valid_at?: number;
  subject: string;
  predicates?: string[];
  direction?: "out" | "in" | "both";
  max_depth?: number;
  limit?: number;
}
export interface MemoryGraphResult {
  space_id: string;
  generation: number;
  root: string;
  edges: { record: MemoryRecord; path: string[] }[];
  truncated: boolean;
}
export interface MemoryRecordInput {
  dependency_versions?: Record<string, number>;
  valid_time?: MemoryValidity | null;
  expected_vocabulary_version?: number;
  content: string;
  type?: "fact" | "observation" | "decision" | "inference" | "skill" | "episode";
  tier?: "fact" | "reflection" | "skill";
  importance?: number;
  subject?: string;
  metadata?: Record<string, unknown>;
  source_ids?: string[];
  depends_on?: string[];
  claim?: MemoryClaim | null;
}
export interface MemoryRecord {
  freshness?: "current" | "stale" | "historical";
  stale_reason?: { kind: string; record_id?: string; observed_version?: number } | null;
  dependency_versions?: Record<string, number | null>;
  valid_time?: MemoryValidity | null;
  vocabulary_version?: number;
  id: string;
  space_id: string;
  version: number;
  content: string;
  type: string;
  tier: string;
  importance: number;
  subject: string | null;
  metadata: Record<string, unknown>;
  source_ids: string[];
  depends_on: string[];
  created_at: number;
  claim?: MemoryClaim | null;
}
export interface MemoryValidity {
  from: number | null;
  until: number | null;
}
export interface MemoryVocabularyDefinition {
  closed: boolean;
  predicates: Record<
    string,
    {
      object: "entity" | "string" | "number" | "boolean" | "null";
      cardinality: "one" | "many";
      description?: string;
    }
  >;
}
export interface MemoryVocabulary {
  version: number;
  definition: MemoryVocabularyDefinition;
}
export interface MemoryPlanStep {
  operation: "query" | "graph" | "search" | "source_search" | "join";
  input: Record<string, unknown>;
}
export interface MemoryPlan {
  retrieval_generation?: number;
  schema: "marina.memory.plan.v1";
  space_id: string;
  generation: number;
  vocabulary_version: number;
  task: string;
  planner: string;
  assumptions: string[];
  steps: MemoryPlanStep[];
  budget: { max_results: number; max_bytes: number };
}
export interface MemoryPlanResult {
  space_id: string;
  generation: number;
  trace: {
    operation: MemoryPlanStep["operation"];
    input: Record<string, unknown>;
    evidence: unknown[];
    truncated: boolean;
  }[];
  bytes: number;
  truncated: boolean;
  answer_sufficiency: "not_assessed";
}

/** One bounded retrieval, including witnessed original-source reads. */
export interface MemoryRetrievalInput {
  task: string;
  selection?: import("./memory-recipes").MemorySelection;
  expansion?: MemoryQueryExpansion;
  requirements?: (
    | { kind: "claim"; subject: string; predicate: string }
    | { kind: "source"; id: string; start?: number; end?: number }
  )[];
  /** Include a bounded candidate pool for explicit episode capture and offline comparison. */
  observe?: boolean;
  steps?: MemoryPlanStep[];
  use_model?: boolean;
  broaden?: boolean;
  valid_at?: number;
  max_results?: number;
  /** Serialized evidence-array budget; plan and diagnostic metadata are separate. */
  max_bytes?: number;
  /** Maximum UTF-8 text bytes read per original source. */
  source_bytes?: number;
}
export type MemoryRetrievedEvidence =
  | (MemoryRecord & { kind: "record" })
  | (MemorySourceRange & { kind: "source"; space_id: string });
export interface MemoryRetrievalResult {
  schema: "marina.memory.retrieval.v1";
  space_id: string;
  generation: number;
  retrieval_generation: number;
  vocabulary_version: number;
  valid_at: number;
  status: "evidence" | "empty" | "budget_exhausted";
  plan: MemoryPlan;
  evidence: MemoryRetrievedEvidence[];
  trace: {
    operation: MemoryPlanStep["operation"] | "source_range";
    input: Record<string, unknown>;
    returned: number;
    truncated: boolean;
    reason: "planned" | "empty_source_search" | "sparse_source_search" | "read_original";
  }[];
  budget: { max_results: number; max_bytes: number; source_bytes: number };
  bytes: number;
  truncated: boolean;
  answer_sufficiency: "not_assessed";
  selection?: import("./memory-recipes").MemorySelection;
  selection_contract?: "marina-evidence-selection-v1";
  selected_recipe?: { space_id: string; id: string; version: number };
  observed_candidates?: MemoryRetrievedEvidence[];
  coverage?: {
    requirement: NonNullable<MemoryRetrievalInput["requirements"]>[number];
    covered: boolean;
  }[];
  known_conflicts?: { subject: string; predicate: string; records: string[] }[];
  diagnostics: {
    broadened: boolean;
    discovery_truncated: boolean;
    budget_limited: boolean;
    filtered_records: number;
    partial_sources: number;
    next_actions: string[];
  };
  limitations: string[];
}
export interface MemorySpace {
  retrieval_generation: number;
  id: string;
  owner_id: string;
  name: string;
  generation: number;
  status: "active" | "forgotten";
  created_at: number;
  /** Operator-set flags (migration 114). `institutional: true` makes `adopt`
   * a standing-gated ratification; `read_public: true` grants every active
   * credential read access. Never settable over HTTP. */
  metadata: Record<string, unknown>;
}
export interface MemorySource {
  id: string;
  space_id: string;
  seq: number;
  session_id: string | null;
  body: unknown;
  content_hash: string;
  created_at: number;
}
export interface MemorySourceSearch {
  query: string;
  expansion?: MemoryQueryExpansion;
  match?: "all" | "any" | "phrase";
  session_id?: string;
  limit?: number;
}
export interface MemorySourceRange {
  id: string;
  session_id: string | null;
  content_hash: string;
  text_hash: string;
  representation: "utf8-source-text-v1";
  start: number;
  end: number;
  total_bytes: number;
  next_start: number | null;
  text: string;
}
export interface MemorySourceSearchResult {
  expansion?: MemoryExpansionCoverage;
  space_id: string;
  generation: number;
  results: {
    id: string;
    seq: number;
    session_id: string | null;
    content_hash: string;
    excerpt: string;
    score?: number;
    ranks?: { lexical?: number; expansion?: (number | null)[] };
  }[];
  truncated: boolean;
}
export interface MemoryCheckpoint {
  name: string;
  version: number;
  source_cursor: number;
  data: Record<string, unknown>;
  updated_at: number;
}
export interface MemoryReceipt {
  id: string;
  version?: number;
  job_id?: string;
  seq?: number;
  generation?: number;
}

export interface MemoryFilter {
  include_stale?: boolean;
  subject?: string;
  type?: string;
  tier?: string;
}
export interface MemorySearchInput extends MemoryFilter {
  query: string;
  expansion?: MemoryQueryExpansion;
  limit?: number;
  mode?: "lexical" | "hybrid";
  allow_degraded?: boolean;
}
/** Reputation-weighted re-rank applied to SHARED-space search results (records the
 *  actor does not own). Bounded, inspectable, deterministic — see db-memory-ranking.ts. */
export interface MemoryReputationRanking {
  weight: number;
  standing_ceiling: number;
  applied: number;
  considered: number;
  authors: Record<string, { author: string | null; standing: number; term: number }>;
}

export interface MemorySearchResult {
  /** Present only when the actor is not the space owner and ≥1 record was considered. */
  ranking?: MemoryReputationRanking;
  expansion?: MemoryExpansionCoverage;
  coverage?: {
    candidate_limit: number;
    lexical_candidates: number;
    semantic: { scored: number; missing: number; invalid: number } | null;
  };
  space_id: string;
  generation: number;
  mode: "lexical" | "hybrid";
  model: string | null;
  degraded: string[];
  results: (MemoryRecord & {
    score: number;
    ranks: { lexical?: number; semantic?: number; expansion?: (number | null)[] };
  })[];
}
export interface ForgetMemoryInput {
  record_ids?: string[];
  source_ids?: string[];
  all?: boolean;
  expected_generation?: number;
}
export interface MemoryJobStatus {
  id: string;
  space_id: string;
  record_id: string;
  note_id: number;
  model: string;
  state: string;
  attempts: number;
  lease_until: number | null;
  error: string | null;
  created_at: number;
}

export interface MemoryStorageAmounts {
  logical_bytes: number;
  sources: number;
  revisions: number;
  spaces: number;
}
export interface MemoryStorageUsage {
  owner_id: string;
  usage: MemoryStorageAmounts;
  limits: Readonly<MemoryStorageAmounts>;
  over_limit: (keyof MemoryStorageAmounts)[];
}

export interface MemoryReviewResult {
  space_id: string;
  retrieval_generation: number;
  items: {
    record: MemoryRecord;
    premises: {
      id: string;
      pinned_version: number | null;
      current_version: number | null;
      state: string;
    }[];
    competing_records: MemoryRecord[];
    competing_truncated: boolean;
    /** The record's live resolution membership, when one exists. */
    resolution?: MemoryResolutionMembership;
  }[];
  next_cursor: string | null;
}

/** Typed write-time operators over the review queue. Every policy writes an
 * append-only audit row; none deletes history. */
export type MemoryResolvePolicy =
  | "last_writer_wins"
  | "evidence_weighted"
  | "await_confirmation"
  | "keep_both";
export type MemoryResolutionStatus = "applied" | "pending" | "confirmed" | "superseded" | "retired";
export type MemoryResolutionRole = "winner" | "superseded" | "peer" | "pending";
export interface MemoryResolveInput {
  policy: MemoryResolvePolicy;
  /** Competing record IDs (1–32); the head record is the operation target. */
  competing: string[];
  rationale: string;
  /** Explicit cutoff for closing losers; `from` overrides the winner's `valid_from`. */
  valid_time?: MemoryValidity | null;
  /** await_confirmation only: relative deadline in milliseconds. */
  deadline_ms?: number;
}
export interface MemoryResolutionMembership {
  id: string;
  policy: MemoryResolvePolicy;
  status: MemoryResolutionStatus;
  role: MemoryResolutionRole;
  rationale: string;
  deadline: number | null;
  created_at: number;
}
export interface MemoryResolveResult extends MemoryReceipt {
  /** Resolution (audit row) ID. */
  id: string;
  record_id: string;
  policy: MemoryResolvePolicy;
  status: MemoryResolutionStatus;
  winner: string | null;
  superseded: { id: string; version: number; valid_time: MemoryValidity | null }[];
  peers: string[];
  pending: string[];
  evidence_counts: Record<string, number> | null;
  deadline: number | null;
}
/** Why a record lives in a shared (institutional) space. Stamped by `adopt`
 * and `pool <name> ratify`; every institutional record answers "why is this
 * shared?" from its own metadata. */
export interface MemoryRatifiedBy {
  principal_id: string;
  name: string;
  standing: number;
  at: number;
  rationale: string | null;
  /** Which rule admitted the ratifier. */
  basis: "standing" | "sovereign" | "local-ungated";
}
export interface MemoryAdoptInput {
  job_id: string;
  /** Defaults to the job's own space. */
  target_space_id?: string;
  rationale?: string;
  valid_time?: MemoryValidity | null;
  /** Explicit `assistance_abstained_confirmed` credit for an abstained job;
   * writes no record. */
  confirm_abstention?: boolean;
}
export interface MemoryStandingCredit {
  principal_id: string;
  kind: string;
  ref: string;
  amount: number;
}
export interface MemoryAdoptResult extends MemoryReceipt {
  job_id: string;
  space_id: string;
  state: "adopted" | "abstention_confirmed";
  /** True when this call returned an adoption that already existed. */
  existing: boolean;
  ratified_by: MemoryRatifiedBy | null;
  credited: MemoryStandingCredit[];
}
export interface MemoryCacheInput {
  inputs: unknown;
  model: string;
  policy: string;
}
export interface MemoryCacheWrite extends MemoryCacheInput {
  value: unknown;
  records?: { id: string; version: number }[];
  sources?: { id: string; content_hash: string }[];
  federated?: MemoryFederatedPin[];
  expires_at: number;
}
export type MemoryCacheResult =
  | { hit: false; reason: string }
  | {
      hit: true;
      value: unknown;
      records: { id: string; version: number }[];
      sources: { id: string; content_hash: string }[];
      federated?: MemoryFederatedPin[];
      expires_at: number;
    };

/** Explicit remote provenance; mounts are configured by the operator, never URLs. */
export type MemoryFederatedPin = { mount: string; space_id: string; id: string } & (
  | { kind: "record"; version: number }
  | { kind: "source"; content_hash: string }
);

/** Portable history envelope. Authorization and indexes are deliberately excluded. */
export interface MemoryBundle {
  schema: "marina.memory.bundle.v2";
  sha256: string;
  payload: {
    origin_space: string;
    sources: (MemorySource & { body_sha256: string })[];
    records: {
      id: string;
      version: number;
      created_at: number;
      stale: number;
      stale_reason: string | null;
      versions: { record: MemoryRecord; attributes: Record<string, unknown> | null }[];
    }[];
    vocabularies: { version: number; definition: string; created_at: number }[];
    checkpoints: {
      name: string;
      version: number;
      source_cursor: number;
      data: string;
      updated_at: number;
    }[];
  };
  excluded: string[];
}
export interface MemoryFederatedSearch {
  mounts: string[];
  query: string;
  kind?: "records" | "sources";
  mode?: "lexical" | "hybrid";
  limit?: number;
  max_bytes?: number;
  allow_partial?: boolean;
}
export type MemoryFederatedEntry = {
  origin: { mount: string; space_id: string; id: string; version?: number };
  score: number;
} & (
  | { kind: "record"; record: MemoryRecord }
  | { kind: "source"; source: MemorySourceSearchResult["results"][number] }
);
export interface MemoryFederatedResult {
  results: MemoryFederatedEntry[];
  failures: { mount: string; code: string }[];
  incomplete: boolean;
  bytes: number;
  truncated: boolean;
  consistency: "per-peer-read-snapshots";
  replicated: false;
}
export interface MemoryFederatedRead {
  mount: string;
  id: string;
  kind: "record" | "source";
  version?: number;
  start?: number;
  end?: number;
}

export interface MemoryFederatedRetrievalResult {
  schema: "marina.memory.federated-retrieval.v1";
  evidence: (MemoryRetrievedEvidence & { mount: string })[];
  peers: {
    mount: string;
    space_id?: string;
    status: "ok" | "truncated" | "unavailable" | "budget_exhausted";
    retrieval_generation?: number;
    vocabulary_version?: number;
    valid_at?: number;
    code?: string;
  }[];
  bytes: number;
  consistency: "per-peer";
  answer_sufficiency: "not_assessed";
  truncated: boolean;
}
export interface MemoryCachedRetrievalInput {
  retrieval: MemoryRetrievalInput & { valid_at: number };
  mounts?: string[];
  allow_partial?: boolean;
  cache?: "read" | "read_write" | "refresh";
  ttl_ms?: number;
}
export interface MemoryCachedRetrievalResult {
  retrieval: MemoryRetrievalResult | MemoryFederatedRetrievalResult;
  cache: { hit: boolean; reason: string; stored?: boolean };
}
