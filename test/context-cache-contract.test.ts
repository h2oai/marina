// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  CONTEXT_CACHE_LIMIT,
  CONTEXT_CACHE_TTL_MS,
  cachedContext,
  contextCacheStats,
} from "../src/memory/context-cache";
import { MarinaDB } from "../src/persistence/database";
import type { UnifiedContextOptions, UnifiedContextResult } from "../src/sdk/memory-context";

let db: MarinaDB;
let now: number;
let clock: ReturnType<typeof spyOn>;
let calls: number;
const result = (): UnifiedContextResult => ({
  schema: "marina.memory.context.v1",
  entity: "Ada",
  query: "port",
  scope: "all",
  budgetBytes: 2048,
  usedBytes: 0,
  truncated: false,
  tiers: [],
  degraded: [],
});
const fresh = async () => {
  calls++;
  return result();
};
const read = (query = "port", options: UnifiedContextOptions = {}, retrieve = fresh) =>
  cachedContext(db, "Ada", query, options, retrieve);
const change = () => db.memoryRepository().raw.run("UPDATE principals SET status='active'");
beforeEach(() => {
  db = new MarinaDB(":memory:");
  db.ensurePrincipal({ type: "service", displayName: "CacheContract" });
  calls = 0;
  now = 10000;
  clock = spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  clock.mockRestore();
  db.close();
});

test("cache metrics start empty; normalized reads share retrieval but never mutable objects", async () => {
  expect(contextCacheStats(db)).toEqual({
    entries: 0,
    hits: 0,
    misses: 0,
    invalidations: 0,
    limit: 128,
    maxAgeMs: 5000,
  });
  const first = await read();
  first.degraded.push({ tier: "evidence", code: "caller", message: "caller mutation" });
  const second = await read(" port ", { creditReflections: true });
  second.degraded.push({ tier: "evidence", code: "caller", message: "caller mutation" });
  expect(await read()).toEqual(result());
  expect(calls).toBe(1);
  expect(contextCacheStats(db)).toMatchObject({ entries: 1, hits: 2, misses: 1, invalidations: 0 });
  await read("port", { budgetBytes: 256 });
  expect(calls).toBe(2);
});

test("TTL includes creation time and excludes its exact deadline; clocks cannot travel backwards", async () => {
  await read();
  await read();
  expect(calls).toBe(1);
  now += CONTEXT_CACHE_TTL_MS;
  await read();
  expect(calls).toBe(2);
  now--;
  await read();
  expect(calls).toBe(3);
  expect(contextCacheStats(db)).toMatchObject({ entries: 1, invalidations: 2 });
});

test("invalidated content is evicted even when the replacement retrieval fails", async () => {
  await read();
  change();
  await expect(
    read("port", {}, async () => {
      throw new Error("upstream unavailable");
    }),
  ).rejects.toThrow("upstream unavailable");
  expect(contextCacheStats(db)).toMatchObject({ entries: 0, invalidations: 1 });
});

test("LRU retains a recently read entry at capacity and evicts the oldest unused one", async () => {
  for (let i = 0; i < CONTEXT_CACHE_LIMIT; i++) await read(`q${i}`);
  expect(contextCacheStats(db).entries).toBe(CONTEXT_CACHE_LIMIT);
  await read("q0");
  await read("overflow");
  await read("q0");
  expect(calls).toBe(CONTEXT_CACHE_LIMIT + 1);
  await read("q1");
  expect(calls).toBe(CONTEXT_CACHE_LIMIT + 2);
  expect(contextCacheStats(db).entries).toBe(CONTEXT_CACHE_LIMIT);
});

test("pruning removes expired entries at the boundary while retaining younger entries", async () => {
  await read("old");
  now += 1000;
  await read("young");
  now += CONTEXT_CACHE_TTL_MS - 1000;
  await read("new");
  expect(contextCacheStats(db).entries).toBe(2);
  await read("young");
  expect(calls).toBe(3);
  change();
  await read("after-write");
  expect(contextCacheStats(db).entries).toBe(1);
});

test("degraded results and snapshots from transactions are never retained", async () => {
  const raw = db.memoryRepository().raw;
  raw.exec("BEGIN");
  await read();
  await read();
  expect(calls).toBe(2);
  expect(contextCacheStats(db).entries).toBe(0);
  raw.exec("ROLLBACK");
  await read("degraded", {}, async () => ({
    ...result(),
    degraded: [{ tier: "evidence", code: "unavailable", message: "offline" }],
  }));
  expect(contextCacheStats(db).entries).toBe(0);
  await read("starts-transaction", {}, async () => {
    raw.exec("BEGIN");
    return result();
  });
  expect(contextCacheStats(db).entries).toBe(0);
  raw.exec("ROLLBACK");
});

test.each(["write", "rollback-clock", "expired"] as const)(
  "retrieval retries %s races exactly three times before refusing stale context",
  async (race) => {
    let attempts = 0;
    await expect(
      read("port", {}, async () => {
        attempts++;
        // Fail promptly if mutation testing removes the retry bound.
        if (attempts > 4) throw new Error("retry limit lost");
        if (race === "write") change();
        else if (race === "rollback-clock") now--;
        else now += CONTEXT_CACHE_TTL_MS;
        return result();
      }),
    ).rejects.toThrow("Memory changed during retrieval; retry context when writes settle.");
    expect(attempts).toBe(3);
    expect(contextCacheStats(db).entries).toBe(0);
  },
);

test("a racing retrieval that settles can return and cache its final snapshot", async () => {
  let attempts = 0;
  await read("port", {}, async () => {
    if (++attempts < 3) change();
    return result();
  });
  expect(attempts).toBe(3);
  await read();
  expect(calls).toBe(0);
});
