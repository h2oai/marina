// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { expandMemoryQuery, normalizeMemoryExpansion } from "../src/sdk/memory-expansion";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "marina-expansion-"));
  const db = new MarinaDB(join(directory, "memory.db"));
  cleanup.push(() => {
    db.close();
    rmSync(directory, { recursive: true });
  });
  const service = new MemoryService(db);
  const token = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "owner" }).principal_id,
  ).token;
  const client = new MarinaMemoryClient("http://memory.test", token, 35000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  const space = (await client.createSpace("expansion")).id;
  return { client, space };
}

it("expands literal Unicode terms without recursion, substring accidents or replacement interpolation", () => {
  const result = expandMemoryQuery("C++ café shipping shippingagent", {
    policy: "glossary:v1",
    rules: [
      { term: "C++", alternatives: ["$&lang"] },
      { term: "café", alternatives: ["coffee"] },
      { term: "shipping", alternatives: ["dispatch", "dispatch"] },
      { term: "dispatch", alternatives: ["recursive"] },
    ],
  });
  expect(result.expansion.queries).toEqual([
    "$&lang café shipping shippingagent",
    "C++ coffee shipping shippingagent",
    "C++ café dispatch shippingagent",
  ]);
  expect(result.applied).toHaveLength(3);
  expect(result.truncated).toBe(false);
  const bounded = expandMemoryQuery("ship", {
    policy: "v2",
    rules: [{ term: "ship", alternatives: ["a", "b", "c", "d", "e"] }],
  });
  expect(bounded.expansion.queries).toHaveLength(4);
  expect(bounded.truncated).toBe(true);
  expect(
    normalizeMemoryExpansion("ship", { policy: "v2", queries: [" ship ", "cargo", "CARGO"] })
      ?.queries,
  ).toEqual(["cargo"]);
  expect(() =>
    normalizeMemoryExpansion("ship", { policy: "v2", queries: ["a", "b", "c", "d", "e"] }),
  ).toThrow(RangeError);
});

it("retrieves original sources and records with inspectable bounded ranks while keeping filters and stale exclusion", async () => {
  const { client, space } = await fixture();
  const source = await client.capture(space, "Cargo dispatch code is AX7", "run");
  const record = await client.remember(space, {
    content: "Cargo dispatch code AX7",
    source_ids: [source.id],
    subject: "cargo",
  });
  const other = await client.createSpace("other");
  await client.remember(other.id, { content: "Cargo dispatch code hidden" });
  const query = expandMemoryQuery("shipping", {
    policy: "logistics:v1",
    rules: [{ term: "shipping", alternatives: ["dispatch"] }],
  });
  expect((await client.search(space, { query: query.query })).results).toHaveLength(0);
  const result = await client.search(space, {
    query: query.query,
    expansion: query.expansion,
    subject: "cargo",
  });
  expect(result.results.map((r) => r.id)).toEqual([record.id]);
  expect(result.results[0]?.ranks).toEqual({ expansion: [1] });
  expect(result.expansion).toMatchObject({
    policy: "logistics:v1",
    queries: ["dispatch"],
    candidates: [1],
    candidate_limit: 200,
  });
  expect((await client.search(space, { ...query, subject: "wrong" })).results).toEqual([]);
  const sources = await client.sourceSearch(space, { ...query, session_id: "run" });
  expect(sources.results.map((s) => s.id)).toEqual([source.id]);
  expect((await client.sourceRange(space, source.id)).text).toBe("Cargo dispatch code is AX7");
  const plan = await client.plan(space, {
    task: "shipping",
    steps: [
      { operation: "source_search", input: { query: query.query, expansion: query.expansion } },
    ],
  });
  expect(plan.steps[0]?.input.expansion).toEqual(query.expansion);
  expect(JSON.stringify(await client.executePlan(space, plan))).toContain(source.id);
  expect((await client.sourceSearch(space, { ...query, session_id: "wrong" })).results).toEqual([]);
  const premise = await client.remember(space, { content: "premise" });
  const stale = await client.remember(space, {
    content: "Cargo dispatch code stale",
    depends_on: [premise.id],
  });
  await client.revise(space, premise.id, 1, { content: "correction" });
  expect((await client.search(space, query)).results.some((r) => r.id === stale.id)).toBe(false);
  expect(
    (await client.search(space, { ...query, include_stale: true })).results.some(
      (r) => r.id === stale.id,
    ),
  ).toBe(true);
  const single = await client.search(space, query);
  const duplicate = await client.search(space, {
    ...query,
    expansion: { policy: "duplicates", queries: ["dispatch", "DISPATCH", "shipping"] },
  });
  expect(duplicate.results).toEqual(single.results);
  await expect(
    client.search(space, {
      query: "code",
      expansion: { policy: "x", queries: ["a", "b", "c", "d", "e"] },
    }),
  ).rejects.toMatchObject({ code: "invalid_expansion" });
  await expect(
    client.sourceSearch(space, { query: "code", expansion: { policy: "x", queries: [""] } }),
  ).rejects.toMatchObject({ code: "invalid_expansion" });
});
