// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Reproducible local retrieval microbenchmark, including result checks. No models. */
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../../src/memory/service";
import { MarinaDB } from "../../src/persistence/database";
import { memoryRepository } from "../../src/persistence/db-memory-service";

const directory = mkdtempSync(join(tmpdir(), "marina-retrieval-bench-"));
const path = join(directory, "bench.db");
const db = new MarinaDB(path);
const raw = new Database(path);
const repo = memoryRepository(raw);
const service = new MemoryService(db);
const count = 6000;
const samples = 25;
try {
  const credential = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "benchmark" }).principal_id,
  );
  const actor = db.verifyMemoryCredential(credential.token)!;
  const space = repo.createSpace(actor, "benchmark", "space").id;
  let target = "";
  raw.transaction(() => {
    for (let i = 0; i < count; i++) {
      const receipt = repo.remember(
        actor,
        space,
        {
          content: `${i === count - 1 ? "uniqueneedle" : "background"} ${"evidence ".repeat(100)}${i}`,
          claim: {
            subject: `node:${i}`,
            predicate: i < 5 ? "depends" : "status",
            object:
              i < 5
                ? { kind: "entity", id: `node:${i + 1}` }
                : { kind: "literal", value: i === count - 1 ? "target" : "background" },
          },
          metadata: { ordinal: i },
        },
        `record-${i}`,
      );
      if (i === count - 1) target = receipt.id;
    }
  })();
  const cases = {
    subject: () => {
      const result = repo.query(actor, space, { subject: `node:${count - 1}` });
      assert.equal(result.results[0]?.id, target);
      assert.equal(result.results.length, 1);
    },
    predicate_object: () => {
      const result = repo.query(actor, space, {
        predicate: "status",
        object: { kind: "literal", value: "target" },
      });
      assert.equal(result.results[0]?.id, target);
      assert.equal(result.results.length, 1);
    },
    page_100: () => {
      assert.equal(repo.query(actor, space, { limit: 100 }).results.length, 100);
    },
    graph_5: () => {
      const result = repo.graph(actor, space, {
        subject: "node:0",
        predicates: ["depends"],
        max_depth: 5,
      });
      assert.equal(result.edges.length, 5);
    },
    lexical: async () => {
      const result = await service.search(actor, space, { query: "uniqueneedle", mode: "lexical" });
      assert.equal(result.results[0]?.id, target);
      assert.equal(result.results.length, 1);
    },
  };
  const timings: Record<string, { median_ms: number; p95_ms: number }> = {};
  for (const [name, run] of Object.entries(cases)) {
    for (let i = 0; i < 5; i++) await run();
    const values: number[] = [];
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      await run();
      values.push(performance.now() - start);
    }
    values.sort((a, b) => a - b);
    timings[name] = {
      median_ms: values[Math.floor(samples / 2)]!,
      p95_ms: values[Math.floor(samples * 0.95)]!,
    };
  }
  console.log(
    JSON.stringify(
      {
        schema: "marina.memory.benchmark.v1",
        bun: Bun.version,
        records: count,
        content_bytes_approx: 910,
        warmup_iterations: 5,
        samples,
        embedding_calls: 0,
        timings,
      },
      null,
      2,
    ),
  );
} finally {
  raw.close();
  db.close();
  rmSync(directory, { recursive: true });
}
