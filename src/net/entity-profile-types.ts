// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire contract of `GET /api/entity/:name/profile` — the single source of truth
 * for the `/who/<name>` pages. Deliberately dependency-free (no Bun, engine or
 * persistence imports) so the dashboard can re-export it type-only
 * (`dashboard/src/lib/entity-profile-types.ts`) without dragging the backend
 * into its `tsc` pass. `entity-api.ts` re-exports these and `buildEntityProfile`
 * assigns the persistence-layer `ChronicleEntry` rows into `narratives`, so a
 * drift between this shape and `db-chronicle.ts` fails the backend typecheck.
 */

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
    local_id: string;
    id_stability: "durable" | "runtime" | "name_record";
    name: string;
    kind: string;
    role: string | null;
    rank: number;
    standing: number;
    first_seen: number | null;
    last_active: number | null;
    online: boolean;
    spawned_by: string | null;
    identity_assurance: "verified_human" | "internal_agent" | "session_only" | "record_only";
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
