// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export type MemoryTerm =
  | { kind: "entity"; id: string }
  | { kind: "literal"; value: string | number | boolean | null };
export interface MemoryClaim {
  subject: string;
  predicate: string;
  object: MemoryTerm;
}
export interface MemoryQuery {
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
  operation: "query" | "graph" | "search" | "source_search";
  input: Record<string, unknown>;
}
export interface MemoryPlan {
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
export interface MemorySpace {
  id: string;
  owner_id: string;
  name: string;
  generation: number;
  status: "active" | "forgotten";
  created_at: number;
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
  space_id: string;
  generation: number;
  results: {
    id: string;
    seq: number;
    session_id: string | null;
    content_hash: string;
    excerpt: string;
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
  subject?: string;
  type?: string;
  tier?: string;
}
export interface MemorySearchInput extends MemoryFilter {
  query: string;
  limit?: number;
  mode?: "lexical" | "hybrid";
  allow_degraded?: boolean;
}
export interface MemorySearchResult {
  space_id: string;
  generation: number;
  mode: "lexical" | "hybrid";
  model: string | null;
  degraded: string[];
  results: (MemoryRecord & { score: number; ranks: { lexical?: number; semantic?: number } })[];
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
