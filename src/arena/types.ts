// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Shapes read from the arena's public repository (Social-Atoms/social-sim-arena). */

export type ArenaTargetType = "continuous_normal" | "profile_energy" | "ranking_list";

export interface ArenaRound {
  round_id: string;
  tracker: string;
  series?: string;
  question: string;
  unit?: string;
  target_type: ArenaTargetType;
  lock_at: string;
  release_at: string;
  release_estimated?: boolean;
  /** Profile rounds: every cell the answer must carry. */
  cells?: string[];
  /** Ranking rounds: `length` and (for a fixed basket) the allowed items. */
  ranking?: { length: number; kind?: string; items?: string[] };
}

export interface ArenaPoint {
  date: string;
  value: number;
}

/** `locks/<round_id>.json` — the input history the arena froze for the round. */
export interface ArenaLock {
  round_id: string;
  lock_at?: string;
  answer_frozen_at?: string;
  history?: ArenaPoint[];
  answer_history?: ArenaPoint[];
  answer_history_by_cell?: Record<string, ArenaPoint[]>;
  /** Wikipedia ranking rounds: recent daily top lists. */
  answer_obs?: Array<{ date: string; items: string[]; views?: Record<string, number> }>;
}

export interface ArenaResolution {
  value?: number;
  observed_date?: string;
  resolved_at?: string;
  [key: string]: unknown;
}

export interface Distribution {
  mean: number;
  sd: number;
}

/** The forecast record the arena accepts (`schema/forecast.schema.json`). */
export interface ArenaForecastBody {
  round_id: string;
  entrant: string;
  topline?: Distribution;
  profile?: Record<string, Distribution>;
  ranking?: string[];
  notes?: string;
}
