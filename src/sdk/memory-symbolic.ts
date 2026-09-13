// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MemoryClaim, MemoryTerm, MemoryValidity } from "./memory-types";

export type MemoryVariable = {
  variable: string;
  type: "entity" | "symbol" | "string" | "number" | "boolean" | "null";
};
export interface MemoryPattern {
  subject: string | MemoryVariable;
  predicate: string | MemoryVariable;
  object: MemoryTerm | MemoryVariable;
}
export interface MemoryJoin {
  patterns: MemoryPattern[];
  select?: string[];
  valid_at?: number;
  limit?: number;
}
export type MemoryBinding = MemoryTerm | { kind: "symbol"; value: string };
export interface MemoryMatch {
  bindings: Record<string, MemoryBinding>;
  witnesses: { id: string; version: number }[];
  valid_time: MemoryValidity;
}
export interface MemoryJoinResult {
  space_id: string;
  generation: number;
  results: MemoryMatch[];
  truncated: boolean;
  trace: { pattern: number; candidates: number; matches: number }[];
  semantics: "asserted-nonrecursive";
}
export interface MemoryRule {
  schema: "marina.memory.rule.v1";
  name: string;
  query: MemoryJoin;
  conclusion: MemoryPattern;
}
export interface MemoryRuleResult extends MemoryJoinResult {
  rule: { id: string; version: number };
  results: (MemoryMatch & { claim: MemoryClaim })[];
}
