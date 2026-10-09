// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live evidence: what agents actually get done, per kind of work and per model
 * and role, read from the outcome path. The same statistic the benchmark
 * ledger's route evidence uses (a Wilson 95 % lower bound), kept separate from
 * the ledger so a reader always knows whether a number came from a board or
 * from real work.
 *
 * Only mechanical outcomes count unless asked (a judged outcome is an opinion
 * until its judge has earned agreement); measurement runs never count.
 */

import { wilsonInterval } from "../../benchmarks/stats";
import type { MarinaDB } from "../persistence/database";
import type { OutcomeBasis, OutcomeKind } from "../persistence/db-outcomes";

export interface EvidenceCell {
  source: string;
  model: string;
  role?: string;
  n: number;
  successes: number;
  rate: number;
  /** Wilson 95 % lower bound on the success rate. */
  lower: number;
}

interface Participant {
  agent?: string;
  model?: string;
  role?: string;
}

export function liveEvidence(
  db: Pick<MarinaDB, "listOutcomes">,
  opts: {
    kind?: OutcomeKind;
    /** A source, or a prefix ending in `:`. */
    source?: string;
    since?: number;
    basis?: OutcomeBasis;
    /** At least this many outcomes per cell (default 1). */
    minN?: number;
    limit?: number;
  } = {},
): EvidenceCell[] {
  const rows = db.listOutcomes({
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    basis: opts.basis ?? "mechanical",
    limit: opts.limit ?? 10_000,
  });
  const cells = new Map<
    string,
    { source: string; model: string; role?: string; n: number; s: number }
  >();
  for (const o of rows) {
    if (o.eval_mode === "measure" || !o.participants_json) continue;
    let participants: Participant[];
    try {
      participants = JSON.parse(o.participants_json) as Participant[];
    } catch {
      continue;
    }
    for (const p of Array.isArray(participants) ? participants : []) {
      if (!p?.model) continue;
      const key = `${o.source}\u0000${p.model}\u0000${p.role ?? ""}`;
      const c = cells.get(key) ?? {
        source: o.source,
        model: p.model,
        ...(p.role ? { role: p.role } : {}),
        n: 0,
        s: 0,
      };
      c.n++;
      c.s += o.succeeded;
      cells.set(key, c);
    }
  }
  return [...cells.values()]
    .filter((c) => c.n >= (opts.minN ?? 1))
    .map((c) => ({
      source: c.source,
      model: c.model,
      ...(c.role ? { role: c.role } : {}),
      n: c.n,
      successes: c.s,
      rate: c.s / c.n,
      lower: wilsonInterval(c.s, c.n).low,
    }))
    .sort((a, b) => a.source.localeCompare(b.source) || b.lower - a.lower);
}
