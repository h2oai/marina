// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Rule-based self-probes (MemDream): for every record a dream would take out
 * of the active set, a query built from its most distinctive words whose
 * expected answer is a verbatim span of the record. `before` runs against the
 * live store; `after` runs against the applied view inside the apply
 * transaction (`apply.ts`) — a record a merge folds away passes when its
 * keeper is retrieved instead. Only ids and hashes are stored, so a replay
 * can rebuild the set without text.
 */

import { createHash } from "node:crypto";
import type { MarinaDB } from "../../persistence/database";
import { normalizedWords } from "../near-duplicate";
import { leavingIds } from "./check";
import type { DreamOp, DreamProbe, DreamRegion } from "./types";

export const PROBE_QUERY_WORDS = 4;
export const PROBE_SPAN_WORDS = 12;
export const PROBE_RECALL_LIMIT = 10;

const h = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

/** The probe query: the record's longest distinct words (ties by first appearance). */
export function probeQuery(content: string): string {
  const words = [...new Set(normalizedWords(content).filter((w) => w.length >= 4))];
  return words
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w.length - a.w.length || a.i - b.i)
    .slice(0, PROBE_QUERY_WORDS)
    .map((x) => x.w)
    .join(" ");
}

export function probeSpan(content: string): string {
  return normalizedWords(content).slice(0, PROBE_SPAN_WORDS).join(" ");
}

/**
 * The probe set plus what the record carries only in memory during the pass:
 * each probe's query text and the record that would carry its span after the
 * op (a merge's keeper, else itself). Only the probes are stored.
 */
export interface ProbePlan {
  probes: DreamProbe[];
  queries: Map<number, { query: string; successor?: number }>;
}

/** Whether a recall's top hits carry the probed record: itself, or its successor. */
export function probeHit(hits: readonly { id: number }[], itemId: number, successor?: number) {
  return hits
    .slice(0, PROBE_RECALL_LIMIT)
    .some((n) => n.id === itemId || (successor !== undefined && n.id === successor));
}

/** Probes for every record the accepted ops would take out, run `before` against the live store. */
export function probePlan(
  db: MarinaDB,
  region: DreamRegion,
  accepted: readonly DreamOp[],
): ProbePlan {
  const byId = new Map(region.records.map((r) => [r.id, r]));
  const targets = new Map<number, number | undefined>();
  for (const op of accepted)
    for (const id of leavingIds(op)) targets.set(id, op.op === "merge" ? op.keep : undefined);
  const probes: DreamProbe[] = [];
  const queries: ProbePlan["queries"] = new Map();
  for (const [id, successor] of targets) {
    const record = byId.get(id);
    if (!record) continue;
    const query = probeQuery(record.content);
    const hits = query ? db.recallNotes(region.entityName, query) : [];
    queries.set(id, { query, successor });
    probes.push({
      itemId: id,
      queryHash: h(query),
      spanHash: h(probeSpan(record.content)),
      before: probeHit(hits, id) ? "pass" : "fail",
      after: null,
    });
  }
  return { probes, queries };
}

export function probesBefore(
  db: MarinaDB,
  region: DreamRegion,
  accepted: readonly DreamOp[],
): DreamProbe[] {
  return probePlan(db, region, accepted).probes;
}
