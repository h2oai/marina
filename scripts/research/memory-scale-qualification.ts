// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Exact synthetic corpus qualification; no models, no production data. */
import type { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../../src/memory/service";
import { MarinaDB } from "../../src/persistence/database";
import { configureMemoryStorage } from "../../src/persistence/db-memory-storage";

const count = Number(Bun.argv[2] ?? 100000),
  output = Bun.argv[3];
if (!Number.isInteger(count) || count < 10010 || count > 1000000 || !output)
  throw new Error(
    "Usage: bun run scripts/research/memory-scale-qualification.ts RECORDS(10010..1000000) OUTPUT_JSON",
  );
const directory = mkdtempSync(join(tmpdir(), "marina-scale-")),
  path = join(directory, "memory.db");
const db = new MarinaDB(path),
  raw = (db as unknown as { db: Database }).db;
configureMemoryStorage(raw, { revisions: count + 100, logical_bytes: 8 * 1024 ** 3 });
const service = new MemoryService(db),
  repo = service.repository;
const codeHashes = Object.fromEntries(
  [
    "src/memory/service.ts",
    "src/persistence/db-memory-service.ts",
    "src/persistence/db-memory-ranking.ts",
  ].map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
);
const started = performance.now();
try {
  const credential = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "scale" }).principal_id,
  );
  const actor = db.verifyMemoryCredential(credential.token)!;
  const space = repo.createSpace(actor, "scale", "space").id;
  let target = "";
  const needles: { query: string; id: string }[] = [];
  for (let offset = 0; offset < count; offset += 1000) {
    raw.transaction(() => {
      for (let i = offset; i < Math.min(count, offset + 1000); i++) {
        const unique = i % Math.floor(count / 20) === 0 || i === count - 1;
        const query = `needle${i}`;
        const receipt = repo.remember(
          actor,
          space,
          {
            content: `${unique ? query : "background"} evidence ${["coding", "research", "planning", "personal"][i % 4]} ${"Context and decision rationale. ".repeat((i % 7) + 1)} ${i}`,
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
        if (unique) needles.push({ query, id: receipt.id });
        if (i === count - 1) target = receipt.id;
      }
    })();
    if (offset % 100000 === 0) console.error(`Seeded ${offset + 1000}/${count}`);
  }
  const seedMs = performance.now() - started;
  const source = repo.capture(
    actor,
    space,
    "sourceonlyneedle original evidence α🙂",
    undefined,
    "source",
  );
  const cases: Record<string, () => unknown | Promise<unknown>> = {
    subject: () =>
      assert.equal(
        repo.query(actor, space, { subject: `node:${count - 1}` }).results[0]?.id,
        target,
      ),
    predicate_object: () =>
      assert.equal(
        repo.query(actor, space, {
          predicate: "status",
          object: { kind: "literal", value: "target" },
        }).results[0]?.id,
        target,
      ),
    page_100: () => assert.equal(repo.query(actor, space, { limit: 100 }).results.length, 100),
    graph_5: () =>
      assert.equal(
        repo.graph(actor, space, { subject: "node:0", predicates: ["depends"], max_depth: 5 }).edges
          .length,
        5,
      ),
    lexical_rare: async () =>
      assert.equal(
        (await service.search(actor, space, { query: `needle${count - 1}` })).results[0]?.id,
        target,
      ),
    lexical_common: async () =>
      assert.equal(
        (await service.search(actor, space, { query: "background" })).results.length,
        10,
      ),
    source_rare: () =>
      assert.equal(
        repo.sourceSearch(actor, space, { query: "sourceonlyneedle" }).results[0]?.id,
        source.id,
      ),
  };
  const timings: Record<string, { median_ms: number; p95_ms: number }> = {};
  const memoryBefore = process.memoryUsage();
  for (const [name, run] of Object.entries(cases)) {
    for (let i = 0; i < 3; i++) await run();
    const values: number[] = [];
    for (let i = 0; i < 25; i++) {
      const start = performance.now();
      await run();
      values.push(performance.now() - start);
    }
    values.sort((a, b) => a - b);
    timings[name] = { median_ms: values[12]!, p95_ms: values[23]! };
  }
  for (const needle of needles)
    assert.equal(
      (await service.search(actor, space, { query: needle.query })).results[0]?.id,
      needle.id,
    );
  const derived = repo.remember(
    actor,
    space,
    { content: "derivedneedle", depends_on: [target] },
    "derived",
  );
  repo.revise(actor, space, target, 1, { content: "correctedneedle" }, "correct");
  assert.equal((await service.search(actor, space, { query: "derivedneedle" })).results.length, 0);
  assert.equal(repo.read(actor, space, derived.id).freshness, "stale");
  assert.equal(
    (await service.search(actor, space, { query: `needle${count - 1}` })).results.length,
    0,
  );
  const outsider = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "outsider" }).principal_id,
  );
  await assert.rejects(
    () =>
      service.search(db.verifyMemoryCredential(outsider.token)!, space, { query: "background" }),
    { code: "space_not_found" },
  );
  const artifact = {
    schema: "marina.memory.scale.v1",
    observed_at: new Date().toISOString(),
    bun: Bun.version,
    records: count,
    seed_ms: seedMs,
    samples: 25,
    warmups: 3,
    timings,
    exact_needle_recall: { found: needles.length, total: needles.length },
    correction_and_stale_exclusion: true,
    outsider_denied: true,
    embedding_calls: 0,
    source_hashes: codeHashes,
    memory_before: memoryBefore,
    memory_after: process.memoryUsage(),
    peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    database_bytes: statSync(path).size,
    limits:
      "Synthetic indexed corpus, single process and owner, warm page cache. Exact needles measure known-answer retrieval, not semantic task utility. Optional vector ranking is separately qualified.",
  };
  await Bun.write(output, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify(artifact));
} finally {
  await service.close();
  db.close();
  rmSync(directory, { recursive: true });
}
