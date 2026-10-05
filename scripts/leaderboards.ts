// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `bun run leaderboards` — a markdown snapshot of Marina's public-competition
 * record, read from the same append-only tables the adapters write:
 *
 *   external_submissions  FutureX / Metaculus / ForecastBench filings (migration 152)
 *   arena_submissions     Social Simulation Arena signed filings
 *   benchmark_runs        the in-world benchmark ledger (HLE-Verified, AIME, GPQA)
 *
 * It never invents a placement: it reports what is recorded, with the fields
 * that make a claim auditable (file, items, cost, N, seed, interval). Paste the
 * output into your private evidence record; local scores are not public placements.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { listArenaSubmissions } from "../src/persistence/db-arena";
import { leaderboardBenchmark, listExternalSubmissions } from "../src/persistence/db-benchmarks";

const dbPath = process.env.DB_PATH || "marina.db";

/** `external_submissions.benchmark` values the adapters write (see each script). */
const EXTERNAL_BENCHMARKS = [
  "futurex-online",
  "futurex-past",
  "futurex-past-clean",
  "forecastbench",
  "forecastbench-outcome",
  "metaculus",
  "metaculus-outcome",
  "metaculus-attempt",
] as const;

/** In-world benchmark slugs surfaced by `benchmark leaderboard` (competitive set). */
const LEDGER_BENCHMARKS = ["hle-verified-gold", "hle-verified-gold-mm", "aime", "gpqa"] as const;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);

function main(): void {
  if (!existsSync(dbPath)) {
    console.log(
      "No ledger yet — run a competition adapter first (see docs/guides/leaderboards.md).",
    );
    return;
  }
  // Inspection must never migrate or mutate the operator's database.
  const db = new Database(dbPath, { readonly: true });
  try {
    console.log("## Current status\n");

    // ── External submissions ──────────────────────────────────────────────────
    console.log("### External submissions\n");
    let anyExternal = false;
    for (const benchmark of EXTERNAL_BENCHMARKS) {
      const rows = listExternalSubmissions(db, benchmark, 20);
      if (rows.length === 0) continue;
      anyExternal = true;
      console.log(`**${benchmark}** — latest ${rows.length} recorded`);
      for (const r of rows) {
        console.log(
          `- \`${r.file_name}\` · ${r.answered}/${r.items} answered · ${usd(r.cost_usd)} · ${day(r.created_at)}`,
        );
      }
      console.log("");
    }
    if (!anyExternal) console.log("_None recorded._\n");

    // ── Arena filings ─────────────────────────────────────────────────────────
    console.log("### Social Simulation Arena\n");
    const arena = listArenaSubmissions(db, { limit: 20 });
    if (arena.length === 0) {
      console.log("_None recorded._\n");
    } else {
      const entrants = new Set(arena.map((r) => r.entrant));
      console.log(`Latest ${arena.length} filing(s) · entrant(s): ${[...entrants].join(", ")}`);
      for (const r of arena.slice(0, 10)) {
        console.log(`- round \`${r.round_id}\` · ${r.status} · ${day(r.created_at)}`);
      }
      console.log("");
    }

    // ── Benchmark ledger ──────────────────────────────────────────────────────
    console.log("### Benchmark ledger (in-world)\n");
    let anyLedger = false;
    for (const benchmark of LEDGER_BENCHMARKS) {
      const rows = leaderboardBenchmark(db, benchmark, 5);
      if (rows.length === 0) continue;
      anyLedger = true;
      console.log(`**${benchmark}** — top runs`);
      for (const r of rows) {
        const score = r.score == null ? "—" : `${(r.score * 100).toFixed(1)}%`;
        const n = r.n == null ? "" : ` · n=${r.n}`;
        const ci =
          r.ci_low == null || r.ci_high == null
            ? ""
            : ` · [${(r.ci_low * 100).toFixed(1)}–${(r.ci_high * 100).toFixed(1)}%]`;
        const label = r.label ? ` · ${r.label}` : "";
        console.log(`- ${score}${n}${ci}${label} · ${day(r.started_at)}`);
      }
      console.log("");
    }
    if (!anyLedger) console.log("_None recorded._\n");
  } finally {
    db.close();
  }
}

main();
