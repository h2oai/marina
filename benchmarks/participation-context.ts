// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { scopeProperty } from "../test/process-state";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: "string", default: "." },
    output: { type: "string" },
    samples: { type: "string", default: "250" },
    "match-every": { type: "string", default: "100" },
    records: { type: "string", default: "1000,10000" },
  },
  strict: true,
});
assert(values.output, "--output is required (keep measurements outside the source tree)");
const samples = Number(values.samples);
const matchEvery = Number(values["match-every"]);
assert(
  Number.isInteger(matchEvery) && matchEvery >= 1 && matchEvery <= 1000,
  "match-every must be 1..1000",
);
const scales = values.records!.split(",").map(Number);
assert(
  Number.isInteger(samples) && samples >= 100 && samples <= 10000,
  "samples must be 100..10000",
);
assert(
  scales.length && scales.every((n) => Number.isInteger(n) && n >= 100 && n <= 100000),
  "records must be 100..100000",
);
// The same workload imports either checkout, so a PR cannot obtain a speedup by
// changing only its own benchmark fixture. No network or model providers.
const load = (file: string) => import(pathToFileURL(resolve(values.root!, file)).href);
const { createTestEngine } = await load("test/engine-fixture.ts");
const { seedUnifiedFixture, FIXTURE_QUERY } = await load("test/fixtures/unified-memory-fixture.ts");
const { buildUnifiedContext } = await load("src/memory/unified-context.ts");
const { contextCacheStats } = await load("src/memory/context-cache.ts");
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;
// Isolated benchmark process: measure retrieval, not the token-rate rejection path.
const { RateLimiter } = await load("src/auth/rate-limiter.ts");
using _rateLimits = scopeProperty(RateLimiter, "bypass", true);
const rows = [];
for (const records of scales) {
  const world = createTestEngine({ storage: "disk" });
  try {
    const fixture = await seedUnifiedFixture(world.engine, world.db);
    const residents = [fixture.owner, ...Array.from({ length: 7 }, (_, i) => `ContextTenant${i}`)];
    for (const name of residents.slice(1)) world.login(name);
    world.db.transaction(() => {
      for (let i = 0; i < records; i++) {
        const owner = residents[i % residents.length];
        world.db.createNote(
          owner,
          `${owner === fixture.owner ? "Observation" : "FOREIGN_ONLY"} ${i % matchEvery === 0 ? "Amber deployment port" : "Background unrelated observation"} history entry ${i}; verify the current evidence before use.`,
          undefined,
          { importance: 3, noteType: "observation", skipDedup: true },
        );
      }
    });
    console.log(`Seeded ${records} records across ${residents.length} tenants`);
    const raw = world.db.memoryRepository().raw;
    const options = { budgetBytes: 4096, creditReflections: false };
    const query = () => buildUnifiedContext(world.db, fixture.owner, FIXTURE_QUERY, options);
    const check = (result: Awaited<ReturnType<typeof query>>) => {
      assert.deepEqual(result.degraded, []);
      assert(result.usedBytes <= options.budgetBytes);
      const items = result.tiers.flatMap(
        (tier: { items: { id: string; content: string }[] }) => tier.items,
      );
      assert(
        items.some((item: { id: string }) => item.id === fixture.recordId),
        "expected durable evidence",
      );
      assert(
        items.every((item: { content: string }) => !item.content.includes("FOREIGN_ONLY")),
        "cross-tenant disclosure",
      );
    };
    const cold: number[] = [],
      warm: number[] = [];
    for (let i = 0; i < samples + 20; i++) {
      // Real SQLite invalidation, outside the timed section. The query remains
      // identical so tokenization/query quality cannot make cold and warm differ.
      raw.run("UPDATE memory_records SET status=status WHERE id=?", [fixture.recordId]);
      let before = contextCacheStats(world.db);
      let start = performance.now();
      let result = await query();
      const coldMs = performance.now() - start;
      assert.equal(contextCacheStats(world.db).misses, before.misses + 1);
      check(result);
      for (let hit = 0; hit < 4; hit++) {
        before = contextCacheStats(world.db);
        start = performance.now();
        result = await query();
        const warmMs = performance.now() - start;
        assert.equal(contextCacheStats(world.db).hits, before.hits + 1);
        check(result);
        if (i >= 20) warm.push(warmMs);
      }
      if (i >= 20) cold.push(coldMs);
      if (i % 50 === 0)
        console.log(`${records} records: sample ${i}, cold ${coldMs.toFixed(2)} ms`);
    }
    // Speed must never come from serving withdrawn evidence.
    raw.run("UPDATE memory_records SET status='forgotten' WHERE id=?", [fixture.recordId]);
    const withdrawn = await query();
    assert(
      !withdrawn.tiers
        .flatMap((tier: { items: { id: string }[] }) => tier.items)
        .some((item: { id: string }) => item.id === fixture.recordId),
    );
    for (const [mode, measurements] of [
      ["cold", cold],
      ["warm", warm],
    ] as const) {
      rows.push({
        records,
        tenants: residents.length,
        matchEvery,
        mode,
        samples: measurements.length,
        p50Ms: percentile(measurements, 0.5),
        p95Ms: percentile(measurements, 0.95),
        p99Ms: percentile(measurements, 0.99),
      });
    }
  } finally {
    await world.dispose();
  }
}
const output = resolve(values.output!);
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify({ schema: "marina.context.benchmark.v1", bun: Bun.version, rows }, null, 2),
);
console.log(JSON.stringify(rows));
