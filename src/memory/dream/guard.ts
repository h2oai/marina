// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The utility-curve guard (2605.12978's rise-then-fall): per agent, each
 * applied dream is assessed once enough work has resolved after it — the
 * success rate of the GUARD_K outcomes after the dream against the GUARD_K
 * before. A drop past GUARD_MARGIN on two consecutive assessed dreams trips
 * the guard: that agent's dreams fall back to `observe` (nothing applied,
 * everything still recorded) and ONE ops-inbox item names it. An operator
 * clears it (`memory dream guard clear <entity>`). State lives in
 * `core_memory` owner `memory:dream` (`guard:<entity>`, `assess:<dream>`),
 * numbers only.
 */

import type { MarinaDB } from "../../persistence/database";
import { parseDreamJson } from "../../persistence/db-memory-dreams";
import { PROPOSAL_OWNER } from "./apply";

/** Outcomes compared on each side of a dream. */
export const GUARD_K = 10;
/** A fall in success rate past this is a drop. */
export const GUARD_MARGIN = 0.1;
/** Consecutive drops that trip the guard. */
export const GUARD_TRIP_AFTER = 2;
/** Dreams assessed per hourly job, at most. */
export const GUARD_ASSESS_BATCH = 50;
export const GUARD_ALERT_CATEGORY = "memory-dream";

export interface DreamAssessment {
  dreamId: number;
  entityName: string;
  before: { n: number; rate: number };
  after: { n: number; rate: number };
  drop: boolean;
  assessedAt: number;
}

export interface GuardState {
  entityName: string;
  /** Consecutive assessed dreams with a drop. */
  consecutive: number;
  /** Set while tripped. */
  tripped?: { at: number; dreams: number[] };
  lastAssessedDreamId?: number;
}

const guardKey = (entityName: string) => `guard:${entityName}`;
const assessKey = (dreamId: number) => `assess:${dreamId}`;

export function guardState(db: MarinaDB, entityName: string): GuardState {
  const row = db.getCoreMemory(PROPOSAL_OWNER, guardKey(entityName));
  const value = row ? parseDreamJson<GuardState | null>(row.value, null) : null;
  return value?.entityName === entityName ? value : { entityName, consecutive: 0 };
}

export function guardTripped(db: MarinaDB, entityName: string): boolean {
  return guardState(db, entityName).tripped !== undefined;
}

export function assessmentOf(db: MarinaDB, dreamId: number): DreamAssessment | undefined {
  const row = db.getCoreMemory(PROPOSAL_OWNER, assessKey(dreamId));
  return row ? (parseDreamJson<DreamAssessment | null>(row.value, null) ?? undefined) : undefined;
}

function saveGuard(db: MarinaDB, state: GuardState): void {
  db.setCoreMemory(PROPOSAL_OWNER, guardKey(state.entityName), JSON.stringify(state));
}

const rate = (rows: { succeeded: 0 | 1 }[]) =>
  rows.length ? rows.filter((o) => o.succeeded === 1).length / rows.length : 0;

/**
 * Assess one applied dream when GUARD_K outcomes have resolved after it.
 * Returns the assessment, or undefined while too little has resolved.
 */
export function assessDream(
  db: MarinaDB,
  row: { id: number; entity_name: string; applied_at: number | null; created_at: number },
  now = Date.now(),
): DreamAssessment | undefined {
  const at = row.applied_at ?? row.created_at;
  const after = db
    .listOutcomes({ owner: row.entity_name, since: at, limit: 10_000 })
    .sort((a, b) => a.resolved_at - b.resolved_at)
    .slice(0, GUARD_K);
  if (after.length < GUARD_K) return undefined;
  const before = db
    .listOutcomes({ owner: row.entity_name, limit: 10_000 })
    .filter((o) => o.resolved_at < at)
    .sort((a, b) => b.resolved_at - a.resolved_at)
    .slice(0, GUARD_K);
  const assessment: DreamAssessment = {
    dreamId: row.id,
    entityName: row.entity_name,
    before: { n: before.length, rate: rate(before) },
    after: { n: after.length, rate: rate(after) },
    drop: before.length >= GUARD_K && rate(after) < rate(before) - GUARD_MARGIN,
    assessedAt: now,
  };
  db.setCoreMemory(PROPOSAL_OWNER, assessKey(row.id), JSON.stringify(assessment));
  const state = guardState(db, row.entity_name);
  state.consecutive = assessment.drop ? state.consecutive + 1 : 0;
  state.lastAssessedDreamId = row.id;
  if (assessment.drop && state.consecutive >= GUARD_TRIP_AFTER && !state.tripped) {
    state.tripped = { at: now, dreams: [row.id] };
    db.upsertOperationalAlert({
      key: `${GUARD_ALERT_CATEGORY}:guard:${row.entity_name}`,
      severity: "warning",
      category: GUARD_ALERT_CATEGORY,
      kind: "approval",
      title: `dreaming paused for ${row.entity_name}: task success fell after ${state.consecutive} dreams in a row`,
      detail: `the last ${GUARD_K} outcomes after dream #${row.id} succeeded at ${Math.round(assessment.after.rate * 100)}% against ${Math.round(assessment.before.rate * 100)}% before (margin ${GUARD_MARGIN}); the agent's dreams run in observe until cleared`,
      remedy: `memory dream guard clear ${row.entity_name} (an operator) after reading memory dream log as ${row.entity_name}; memory dream rollback <id> reverses a dream`,
      sourceEntity: row.entity_name,
      actionLabel: "Clear",
      actionRef: `memory dream guard clear ${row.entity_name}`,
      metadata: { dreamId: row.id, before: assessment.before, after: assessment.after },
    });
    db.appendChronicle({
      kind: "event",
      source: "memory",
      title: "memory.dream.guard",
      body: `${row.entity_name}: dreaming paused after ${state.consecutive} consecutive drops (dream #${row.id}: ${Math.round(assessment.after.rate * 100)}% after vs ${Math.round(assessment.before.rate * 100)}% before)`,
      participants: [row.entity_name],
      refs: [`dream:${row.id}`],
    });
  } else if (assessment.drop && state.tripped) state.tripped.dreams.push(row.id);
  saveGuard(db, state);
  return assessment;
}

/** The hourly sweep: every applied, unassessed dream with enough work after it. */
export function assessDreams(db: MarinaDB, now = Date.now()): DreamAssessment[] {
  const rows = db
    .memoryRepository()
    .raw.query<
      { id: number; entity_name: string; applied_at: number | null; created_at: number },
      []
    >(
      `SELECT id, entity_name, applied_at, created_at FROM memory_dreams
       WHERE state = 'applied' ORDER BY id DESC LIMIT 500`,
    )
    .all();
  const out: DreamAssessment[] = [];
  for (const row of rows) {
    if (out.length >= GUARD_ASSESS_BATCH) break;
    if (assessmentOf(db, row.id)) continue;
    const a = assessDream(db, row, now);
    if (a) out.push(a);
  }
  return out;
}

/** An operator's clear: the agent may apply dreams again; the alert resolves. */
export function clearGuard(db: MarinaDB, entityName: string): boolean {
  const state = guardState(db, entityName);
  if (!state.tripped) return false;
  saveGuard(db, { entityName, consecutive: 0, lastAssessedDreamId: state.lastAssessedDreamId });
  const key = `${GUARD_ALERT_CATEGORY}:guard:${entityName}`;
  for (const status of ["open", "acknowledged"] as const)
    for (const alert of db.listOperationalAlerts(status))
      if (alert.alert_key === key) db.setOperationalAlertStatus(alert.id, "resolved");
  return true;
}
