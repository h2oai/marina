// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Evidence you can check. `evolve evaluate <exp> <run> | <evidence>` may cite
 * `benchmark:<run id>`; every cited run must exist, be completed and have
 * answered something, or the evaluation is refused — a claim of "it scored
 * 93%" is replaced by the run it came from. The verified summary (score,
 * answered/total, model, and the agents/role/prompt version behind it) is
 * stored with the evidence, so a reviewer sees what was measured, not what
 * was said about it.
 */

import type { MarinaDB } from "../persistence/database";
import type { BenchmarkSubject } from "./benchmark-runner";

const BENCHMARK_REF = /\bbenchmark:(br_[A-Za-z0-9_]+)\b/g;
const MAX_REFS = 8;

export interface ResolvedEvolutionEvidence {
  /** One line per verified ref, e.g. `benchmark:br_x smoke 93.3% (14/15) · marina:scout-v2 · Scout2 role scout-v2 prompt ab12…`. */
  verified: string[];
  /** Refs that do not resolve, with why. Non-empty ⇒ the evaluation must be refused. */
  missing: string[];
}

export function resolveEvolutionEvidence(
  db: Pick<MarinaDB, "getBenchmarkRun">,
  text: string,
): ResolvedEvolutionEvidence {
  const out: ResolvedEvolutionEvidence = { verified: [], missing: [] };
  const seen = new Set<string>();
  for (const m of text.matchAll(BENCHMARK_REF)) {
    const id = m[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > MAX_REFS) break;
    const row = db.getBenchmarkRun(id);
    if (!row) {
      out.missing.push(`benchmark:${id} (no such run)`);
      continue;
    }
    if (row.status !== "completed" || row.score === null || row.answered <= 0) {
      out.missing.push(
        `benchmark:${id} (${row.status === "running" ? "still running" : row.status === "completed" ? "answered nothing" : row.status})`,
      );
      continue;
    }
    let model = "";
    let subjects: BenchmarkSubject[] = [];
    try {
      const config = JSON.parse(row.config_json) as {
        model?: string;
        subjects?: BenchmarkSubject[];
      };
      model = config.model ?? "";
      subjects = Array.isArray(config.subjects) ? config.subjects : [];
    } catch {
      // A run without a readable config still has its score.
    }
    const who = subjects
      .map(
        (s) =>
          `${s.agent}${s.role ? ` role ${s.role}` : ""}${s.promptVersion ? ` prompt ${s.promptVersion}` : ""}`,
      )
      .join(", ");
    out.verified.push(
      `benchmark:${id} ${row.benchmark} ${(row.score * 100).toFixed(1)}% (${row.answered}/${row.total})` +
        `${model ? ` · ${model}` : ""}${who ? ` · ${who}` : ""}`,
    );
  }
  return out;
}
