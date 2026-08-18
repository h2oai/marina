// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Mirror of src/net/entity-api.ts EntityProfile shape. Kept in sync manually
// (no codegen yet) — backend changes that touch the response shape should
// update this file too. Treated as the contract surface for the /who pages.

export type ChronicleKind = "event" | "narrative" | "digest" | "correction";

export interface ChronicleEntry {
  id: number;
  created_at: number;
  kind: ChronicleKind;
  source: string;
  title: string;
  body: string;
  participants: string[];
  refs: string[];
  period: string | null;
  supersedes: number | null;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  achieved_at: number;
  evidence_ref?: string;
}

export interface EntityProfile {
  identity: {
    name: string;
    kind: string;
    role: string | null;
    rank: number;
    standing: number;
    first_seen: number | null;
    last_active: number | null;
    online: boolean;
  };
  bio: {
    goal: string | null;
    model: string | null;
    traits: string[];
    operator_bio: string | null;
  };
  narratives: ChronicleEntry[];
  achievements: Achievement[];
  stats: {
    chronicle_citations: Record<ChronicleKind, number>;
    chronicle_citations_total: number;
    rooms_visited: number;
    unique_commands: number;
    entities_interacted: number;
    total_actions: number;
    competence_gates_passed: number;
    days_active: number;
  };
  connections: { name: string; co_chronicles: number }[];
}
