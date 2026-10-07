// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One-time backfill for lessons from work (`./work.ts`): scan what a database
 * already recorded — agent tool results, gate holds, argument-check flags,
 * verifier bounces and task verdicts in `event_log`; answered challenges in
 * `challenge_outcomes`; exec denials in `coding_events` — through the SAME
 * tracker and aggregation the live collector uses, and report the patterns
 * per source. Read-only: it takes a plain SQLite handle (open it with
 * `{ readonly: true }`) and never writes. Learning the patterns it finds is
 * `learnPatterns` (the operator script's paid path, behind `--yes`).
 *
 * Rows written before `errorClass` existed carry only `isError`: their class
 * is `other`. Soft failures (a command answered "Unknown command" as text)
 * were never recorded and are not recoverable.
 */

import type { Database } from "bun:sqlite";
import type { EngineEvent } from "../types";
import {
  candidateCounts,
  MIN_OCCURRENCES,
  type ScopeReader,
  WorkAggregator,
  WorkEventTracker,
  type WorkPattern,
  type WorkScope,
  type WorkSource,
  workScopeFor,
} from "./work";

/** Principal reads over a raw handle (the `ScopeReader` the live path gets from `MarinaDB`). */
export function sqliteScopeReader(db: Database): ScopeReader {
  type Row = {
    principal_id: string;
    principal_type: string;
    display_name: string;
    owner_principal_id: string | null;
    status: string;
  };
  const all = db
    .query<Row, []>(
      "SELECT principal_id, principal_type, display_name, owner_principal_id, status FROM principals",
    )
    .all();
  return {
    getPrincipal: (type, name) =>
      all.find(
        (p) => p.principal_type === type && p.display_name.toLowerCase() === name.toLowerCase(),
      ),
    listPrincipals: () => all,
    getUserByName: (name) =>
      db.query<{ id: string }, [string]>("SELECT id FROM users WHERE name = ?").get(name) ??
      undefined,
  };
}

export interface WorkScanReport {
  /** Rows read per table. */
  rows: Record<string, number>;
  /** Signals per source (before the occurrence floor). */
  signals: Record<string, number>;
  /** Signals whose actor's scope could not be resolved (never learned). */
  unscoped: number;
  patterns: WorkPattern[];
  /** Patterns at or above their floor: the candidate outcomes, per source. */
  candidates: Record<string, number>;
  /** Candidate outcomes by scope kind. */
  byScope: { shared: number; owner: number };
}

function hasTable(db: Database, name: string): boolean {
  return !!db
    .query<{ n: string }, [string]>(
      "SELECT name AS n FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(name);
}

/** Scan `db` (read-only) for work outcomes since `sinceMs` (default: all history). */
export function scanWorkHistory(db: Database, opts: { sinceMs?: number } = {}): WorkScanReport {
  const since = opts.sinceMs ?? 0;
  const reader = sqliteScopeReader(db);
  const scopes = new Map<string, WorkScope | undefined>();
  let unscoped = 0;
  const scopeOf = (actor: string) => {
    if (!scopes.has(actor)) scopes.set(actor, workScopeFor(reader, actor));
    const s = scopes.get(actor);
    if (!s) unscoped++;
    return s;
  };
  const aggregator = new WorkAggregator();
  const signals: Record<string, number> = {};
  const emit = (s: Parameters<WorkAggregator["add"]>[0]) => {
    signals[s.source] = (signals[s.source] ?? 0) + 1;
    aggregator.add(s);
  };
  const tracker = new WorkEventTracker(scopeOf, emit);
  const rows: Record<string, number> = {};

  if (hasTable(db, "event_log")) {
    const stmt = db.query<{ data: string }, [number]>(
      `SELECT data FROM event_log
        WHERE type IN ('agent_tool_result','agent_decision','task_approved','task_rejected')
          AND timestamp >= ?
        ORDER BY id`,
    );
    let n = 0;
    for (const row of stmt.iterate(since)) {
      n++;
      try {
        tracker.onEvent(JSON.parse(row.data) as EngineEvent);
      } catch {
        // allow-empty-catch: an unreadable row teaches nothing
      }
    }
    rows.event_log = n;
  }

  if (hasTable(db, "challenge_outcomes")) {
    const list = db
      .query<
        {
          token: string;
          kind: string;
          class: string;
          requester_name: string;
          answer: string;
          summary: string;
          reason: string;
          answered_at: number;
        },
        [number]
      >(
        `SELECT token, kind, class, requester_name, answer, summary, reason, answered_at
           FROM challenge_outcomes WHERE answered_at >= ? ORDER BY id`,
      )
      .all(since);
    rows.challenge_outcomes = list.length;
    for (const c of list) {
      const scope = scopeOf(c.requester_name);
      if (!scope) continue;
      emit({
        source: "challenge",
        tool: c.class,
        errorClass: c.answer,
        succeeded: c.answer === "once" || c.answer === "always",
        scope,
        at: c.answered_at,
        ref: `challenge:${c.token}`,
        privateText: `${c.summary.slice(0, 240)}\n${c.reason}`,
      });
    }
  }

  if (hasTable(db, "coding_events") && hasTable(db, "coding_sessions")) {
    const list = db
      .query<{ payload_json: string; created_by: string; created_at: number }, [number]>(
        `SELECT e.payload_json, s.created_by, e.created_at
           FROM coding_events e JOIN coding_sessions s ON s.id = e.session_id
          WHERE e.kind = 'exec_decision' AND e.created_at >= ? ORDER BY e.created_at`,
      )
      .all(since);
    rows.coding_events = list.length;
    for (const e of list) {
      let p: { approved?: boolean; argv?: unknown; outcome?: string; reason?: string; id?: string };
      try {
        p = JSON.parse(e.payload_json);
      } catch {
        continue;
      }
      if (p.approved !== false) continue;
      const scope = scopeOf(e.created_by);
      if (!scope) continue;
      emit({
        source: "code-exec-denied",
        tool: Array.isArray(p.argv) && typeof p.argv[0] === "string" ? p.argv[0] : "exec",
        errorClass: p.outcome ?? "denied",
        succeeded: false,
        scope,
        at: e.created_at,
        ...(p.id ? { ref: `artifact:${p.id}` } : {}),
        ...(p.reason ? { privateText: p.reason } : {}),
      });
    }
  }

  const patterns = aggregator.take();
  const ready = patterns.filter((p) => p.count >= MIN_OCCURRENCES[p.source as WorkSource]);
  return {
    rows,
    signals,
    unscoped,
    patterns,
    candidates: candidateCounts(ready),
    byScope: {
      shared: ready.filter((p) => p.scope.kind === "shared").length,
      owner: ready.filter((p) => p.scope.kind === "owner").length,
    },
  };
}

/** Model calls a learned outcome costs: the writer, the judge (admission adds up to one more). */
export const CALLS_PER_OUTCOME = { writer: 1, judge: 1, admissionMax: 1 } as const;
