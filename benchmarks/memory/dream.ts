#!/usr/bin/env bun

// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * dream — the offline replay of recorded dreams (no model calls).
 *
 * A dream record keeps ids, hashes and counts, never text, so the replay
 * rebuilds what it can from the live store and says what still holds:
 *
 *   - probes: each probe's query is rebuilt from its record's current text
 *     and compared with the stored query hash (`intact` / `drifted` / `gone`),
 *     then run against the store as it is now — the pass rate today, next to
 *     the pass rate the dream recorded before and after.
 *   - ops: every stored merge, link and decay is re-checked (`checkOps`)
 *     against a region re-gathered over the dream's window, and the region's
 *     hash is compared with the recorded one (supersedes carry no text and
 *     are skipped).
 *   - effect: the held-out measurement (`dreamEffect`) the posture decision
 *     reads, for every owner.
 *
 *   bun run bench:dream -- --db path/to/marina.db [--limit 200] [--json]
 */

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { checkOps } from "../../src/memory/dream/check";
import { dreamEffect, renderDreamEffect } from "../../src/memory/dream/measure";
import { DREAM_FIRST_WINDOW_MS } from "../../src/memory/dream/pass";
import { probeHit, probeQuery } from "../../src/memory/dream/probe";
import { gatherRegion } from "../../src/memory/dream/region";
import { scopeRecall } from "../../src/memory/dream/scope";
import type { DreamChecks, DreamOp, DreamProbe, StoredDreamOp } from "../../src/memory/dream/types";
import { MarinaDB } from "../../src/persistence/database";
import { parseDreamJson } from "../../src/persistence/db-memory-dreams";

const h = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

export interface DreamReplay {
  id: number;
  entity: string;
  state: string;
  probes: { total: number; intact: number; drifted: number; gone: number; passNow: number };
  recorded: {
    before: { pass: number; fail: number };
    after: { pass: number; fail: number } | null;
  };
  ops: { stored: number; rechecked: number; stillAccepted: number; regionMatches: boolean };
}

/** Replay one dream against the store as it is now. */
export function replayDream(
  db: MarinaDB,
  row: ReturnType<MarinaDB["listDreams"]>[number],
  previousAt: number | undefined,
): DreamReplay {
  const probes = parseDreamJson<DreamProbe[]>(row.probes_json, []);
  const stored = parseDreamJson<StoredDreamOp[]>(row.ops_json, []);
  // A record a merge folded away is carried by its keeper (as in `probe-after`).
  const successor = new Map<number, number>();
  for (const op of stored)
    if (op.op === "merge" && op.applied) for (const id of op.into) successor.set(id, op.keep);
  const counts = { total: probes.length, intact: 0, drifted: 0, gone: 0, passNow: 0 };
  for (const probe of probes) {
    const note = db.getNote(probe.itemId);
    if (!note) {
      counts.gone++;
      continue;
    }
    const query = probeQuery(note.content);
    if (h(query) === probe.queryHash) counts.intact++;
    else counts.drifted++;
    const hits = query ? scopeRecall(db, row.entity_name, query) : [];
    if (probeHit(hits, probe.itemId, successor.get(probe.itemId))) counts.passNow++;
  }
  const checks = parseDreamJson<Partial<DreamChecks>>(row.checks_json, {});
  const since = previousAt ?? row.created_at - DREAM_FIRST_WINDOW_MS;
  const region = gatherRegion(db, row.entity_name, since, row.created_at);
  const replayable: DreamOp[] = [];
  for (const op of stored) {
    if (op.op === "merge")
      replayable.push({ op: "merge", keep: op.keep, into: op.into, reason: op.reason });
    else if (op.op === "link")
      replayable.push({
        op: "link",
        from: op.from,
        to: op.to,
        relation: op.relation,
        reason: op.reason,
      });
    else if (op.op === "decay") replayable.push({ op: "decay", id: op.id, reason: op.reason });
  }
  const rechecked = checkOps(replayable, region);
  return {
    id: row.id,
    entity: row.entity_name,
    state: row.state,
    probes: counts,
    recorded: {
      before: checks.probesBefore ?? { pass: 0, fail: 0 },
      after: checks.probesAfter ?? null,
    },
    ops: {
      stored: stored.length,
      rechecked: replayable.length,
      stillAccepted: rechecked.accepted.length,
      regionMatches: region.hash === row.region_hash,
    },
  };
}

/** Every entity's dreams, newest first, each replayed. */
export function replayDreams(db: MarinaDB, limit = 200): DreamReplay[] {
  const rows = db
    .memoryRepository()
    .raw.query<{ entity_name: string }, [number]>(
      "SELECT DISTINCT entity_name FROM memory_dreams ORDER BY entity_name LIMIT ?",
    )
    .all(limit)
    .map((r) => r.entity_name);
  const out: DreamReplay[] = [];
  for (const entity of rows) {
    const dreams = db.listDreams(entity, limit).sort((a, b) => a.id - b.id);
    let previousAt: number | undefined;
    for (const row of dreams) {
      out.push(replayDream(db, row, previousAt));
      previousAt = row.created_at;
    }
  }
  return out.sort((a, b) => b.id - a.id).slice(0, limit);
}

export function renderReplay(replays: DreamReplay[]): string[] {
  const lines = [
    "dream   entity          state        probes(intact/drifted/gone)  pass now  recorded before→after   ops rechecked/stored  region",
  ];
  for (const r of replays)
    lines.push(
      `#${String(r.id).padEnd(6)} ${r.entity.padEnd(15)} ${r.state.padEnd(12)} ${`${r.probes.intact}/${r.probes.drifted}/${r.probes.gone}`.padEnd(28)} ${`${r.probes.passNow}/${r.probes.total}`.padEnd(9)} ${`${r.recorded.before.pass}/${r.recorded.before.pass + r.recorded.before.fail}→${r.recorded.after ? `${r.recorded.after.pass}/${r.recorded.after.pass + r.recorded.after.fail}` : "—"}`.padEnd(23)} ${`${r.ops.stillAccepted}/${r.ops.rechecked}/${r.ops.stored}`.padEnd(21)} ${r.ops.regionMatches ? "match" : "differs"}`,
    );
  return lines;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      db: { type: "string" },
      limit: { type: "string", default: "200" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.db) {
    console.error("usage: bun run bench:dream -- --db <marina.db> [--limit N] [--json]");
    process.exit(2);
  }
  const db = new MarinaDB(values.db);
  try {
    const replays = replayDreams(db, Number(values.limit) || 200);
    const effect = dreamEffect(db);
    if (values.json) console.log(JSON.stringify({ replays, effect }, null, 2));
    else {
      console.log(renderReplay(replays).join("\n"));
      console.log("");
      console.log("Effect (every owner):");
      console.log(renderDreamEffect(effect).join("\n"));
    }
  } finally {
    db.close();
  }
}
