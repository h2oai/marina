// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { MarinaMemoryClient } from "../src/sdk/memory-client";

let directory: string, db: MarinaDB, client: MarinaMemoryClient, space: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marina-store-"));
  db = new MarinaDB(join(directory, "memory.db"));
  const service = new MemoryService(db),
    token = db.issueMemoryCredential(
      db.ensurePrincipal({ type: "service", displayName: "store" }).principal_id,
    ).token;
  client = new MarinaMemoryClient("http://memory.test", token, 30000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  space = (await client.createSpace("store")).id;
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});
const batch = (operations: unknown[], key?: string) =>
  client.request<{ results: unknown[] }>(
    `/spaces/${space}/json_store`,
    "POST",
    { operations },
    key,
  );
it("stores JSON as original evidence, updates atomically and forgets the captured lineage", async () => {
  const ns = ["project", "one"],
    put = { namespace: ns, key: "handoff", value: { task: "review", count: 1 } };
  const first = await batch([put, { namespace: ns, key: "handoff" }], "put");
  expect((first.results[1] as { value: unknown }).value).toEqual(put.value);
  expect(await batch([put, { namespace: ns, key: "handoff" }], "put")).toEqual(first);
  const record = (await client.query(space)).results[0]!;
  expect((await client.sourceRange(space, record.source_ids[0]!)).text).toContain("review");
  await batch([{ ...put, value: { task: "done", count: 2 } }]);
  expect((await client.get(space, record.id)).version).toBe(2);
  expect((await client.get(space, record.id, 1)).content).toContain("review");
  await batch([{ namespace: ns, key: "handoff", value: null }]);
  expect((await batch([{ namespace: ns, key: "handoff" }])).results).toEqual([null]);
  expect((await client.sources(space)).sources).toEqual([]);
});
it("rolls back mixed batches, scopes namespaces and validates filters and unsupported options", async () => {
  await batch([
    { namespace: ["a", "one"], key: "x", value: { score: 3 } },
    { namespace: ["b", "one"], key: "x", value: { score: 8 } },
  ]);
  expect(
    (await batch([{ namespacePrefix: ["a"], filter: { score: { $gte: 3 } } }])).results[0],
  ).toHaveLength(1);
  expect(
    (
      await batch([
        {
          matchConditions: [{ matchType: "suffix", path: ["one"] }],
          limit: 20,
          offset: 0,
          maxDepth: 1,
        },
      ])
    ).results[0],
  ).toEqual([["a"], ["b"]]);
  await expect(
    batch([
      { namespace: ["a"], key: "bad", value: { ok: true } },
      { namespace: ["a"], key: "bad", value: {}, ttl: 5 },
    ]),
  ).rejects.toMatchObject({ code: "invalid_store" });
  expect((await batch([{ namespace: ["a"], key: "bad" }])).results[0]).toBeNull();
  await expect(batch([{ namespacePrefix: [], query: "semantic" }])).rejects.toMatchObject({
    code: "invalid_store",
  });
  await expect(
    batch([{ namespacePrefix: [], filter: { score: { $mystery: 1 } } }]),
  ).rejects.toMatchObject({ code: "invalid_store" });
  const other = (await client.createSpace("other")).id;
  expect(
    (
      await client.request<{ results: unknown[] }>(`/spaces/${other}/json_store`, "POST", {
        operations: [{ namespace: ["a", "one"], key: "x" }],
      })
    ).results,
  ).toEqual([null]);
});

it("rejects unsupported empty queries and identity changes made through native writes", async () => {
  await expect(
    batch([{ namespacePrefix: [], filter: { absent: { $unknown: 1 } } }]),
  ).rejects.toMatchObject({ code: "invalid_store" });
  await batch([{ namespace: ["native"], key: "item", value: { status: "active" } }]);
  const record = (await client.query(space)).results[0]!;
  await client.revise(space, record.id, 1, {
    content: record.content,
    subject: record.subject!,
    metadata: { ...record.metadata, key: "renamed" },
  });
  await expect(batch([{ namespace: ["native"], key: "item" }])).rejects.toMatchObject({
    code: "store_requires_review",
  });
});
