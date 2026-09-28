// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distinctiveTerms } from "../src/memory/unified-context";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";

// Offline comparison of context's term-statistics stage, not whole-request throughput.
const directory = mkdtempSync(join(tmpdir(), "marina-context-statistics-"));
const db = new MarinaDB(join(directory, "stats.db"));
const terms = ["common", "quartz", "owner", "memory", "distinct", "missing", "%", "_"];
try {
  db.transaction(() => {
    for (let i = 0; i < 1000; i++)
      db.createNote(
        "Owner",
        `common owner memory ${i % 100 ? "ordinary" : "quartz distinct"} observation ${i}`,
        roomId("benchmark/stats"),
      );
  });
  const raw = db.memoryRepository().raw;
  const previous = () => {
    const { n: total } = raw
      .query(
        "SELECT count(*) AS n FROM numeric_notes WHERE entity_name=? COLLATE NOCASE AND pool_id IS NULL AND tier IN ('fact','reflection','skill')",
      )
      .get("Owner") as { n: number };
    const cap = Math.max(3, Math.floor(total * 0.2));
    const count = raw.query(
      "SELECT count(*) AS n FROM numeric_notes WHERE entity_name=? COLLATE NOCASE AND pool_id IS NULL AND tier IN ('fact','reflection','skill') AND lower(content) LIKE ? ESCAPE '\\'",
    );
    return new Set(
      terms.filter(
        (term) =>
          (count.get("Owner", `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`) as { n: number })
            .n <= cap,
      ),
    );
  };
  const current = () => distinctiveTerms(db, "Owner", terms);
  assert.deepEqual(current(), previous());
  const results = { previous: [] as number[], current: [] as number[] };
  for (let i = 0; i < 25; i++) {
    // Alternate order to avoid always assigning cold-cache work to one implementation.
    for (const name of i % 2
      ? (["current", "previous"] as const)
      : (["previous", "current"] as const)) {
      const start = performance.now();
      const result = name === "current" ? current() : previous();
      if (i > 4) results[name].push(performance.now() - start);
      assert.deepEqual(result, new Set(["quartz", "distinct", "missing", "%", "_"]));
    }
  }
  const summary = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    };
  };
  console.log(
    JSON.stringify(
      {
        stage: "context-term-statistics",
        records: 1000,
        terms: terms.length,
        samples: 20,
        previous: summary(results.previous),
        current: summary(results.current),
        equalResults: true,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
