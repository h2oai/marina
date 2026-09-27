// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
export type UnifiedTier = "skill" | "trusted" | "evidence" | "proposal" | "unverified";
export interface UnifiedContextItem {
  tier: UnifiedTier;
  /** Legacy note id (`"12"`), durable record/source id, or assistance job id. */
  id: string;
  /** Rendered content — already truncated (with a visible marker) when `truncated`. */
  content: string;
  /** Human-readable origin: `#12 imp=6 verified`, `record r_1 v1`, `source s_1 sha256:…`. */
  provenance: string;
  /** UTF-8 bytes of `content` after truncation — what counted against the budget. */
  bytes: number;
  /** Ranking key within the tier (score desc, then id asc). */
  score: number;
  truncated?: boolean;
  /** Structured origin details for machine consumers (record version, hash, citations…). */
  meta?: Record<string, unknown>;
}

export interface UnifiedTierResult {
  tier: UnifiedTier;
  label: string;
  items: UnifiedContextItem[];
  /** Items that matched but were dropped for budget — the header still renders. */
  omitted: number;
}

export interface UnifiedDegraded {
  tier: UnifiedTier;
  code: string;
  message: string;
}

export interface UnifiedContextResult {
  schema: "marina.memory.context.v1";
  entity: string;
  query: string;
  scope: UnifiedScope;
  budgetBytes: number;
  usedBytes: number;
  /** True when any item was cut or dropped for budget. Headers are never dropped silently. */
  truncated: boolean;
  /** All five tiers, in render order; empty tiers have `items: []`. */
  tiers: UnifiedTierResult[];
  degraded: UnifiedDegraded[];
}

export type UnifiedScope = "all" | "evidence" | "legacy";

export interface UnifiedContextOptions {
  /** Total content-byte budget across tiers. Default 2048 (prompt use). */
  budgetBytes?: number;
  /** Per-item cap before the global budget applies. Default 600. */
  itemMaxBytes?: number;
  /** `all` (default) · `evidence` (durable tiers only) · `legacy` (notes only). */
  scope?: UnifiedScope;
  /** Max items fetched per tier before budgeting. */
  perTier?: Partial<Record<UnifiedTier, number>>;
  /** Legacy recall weights (the `recall` command passes its intent-detected weights). */
  weights?: { weightImportance: number; weightRecency: number; weightRelevance: number };
  /** Restrict legacy note tiers to one note_type (mirrors `recall … type <t>`). */
  noteType?: string;
  /** Pay authors of cross-author reflection hits in the legacy tiers (default true). */
  creditReflections?: boolean;
}
