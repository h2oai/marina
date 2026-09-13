// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryService } from "../src/memory/service";
import { createMemoryMcpServer } from "../src/net/mcp-server";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { MEMORY_GRAPH_ACTIONS } from "../src/sdk/memory-knowledge-graph";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "marina-graph-tools-"));
  const db = new MarinaDB(join(dir, "memory.db")),
    service = new MemoryService(db);
  const owner = db.ensurePrincipal({ type: "service", displayName: "owner" }).principal_id;
  const token = db.issueMemoryCredential(owner).token;
  const http = new MarinaMemoryClient("http://memory.test", token, 35000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  const space = (await http.createSpace("graph")).id;
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true });
  });
  return { db, http, space, owner, token, raw: (db as unknown as { db: Database }).db };
}
const alice = { name: "Alice", entityType: "person", observations: ["Speaks Spanish α🙂"] };
const marina = { name: "Marina", entityType: "project", observations: ["Portable memory"] };
const works = { from: "Alice", to: "Marina", relationType: "works_on" };

it("implements all nine reference tools through authenticated MCP and exposes native asserted relations", async () => {
  const { http, space } = await fixture();
  const server = createMemoryMcpServer(http, space, "knowledge-graph");
  const client = new Client({ name: "graph-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return result.structuredContent;
  };
  try {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(
      [...MEMORY_GRAPH_ACTIONS].sort(),
    );
    expect(await call("create_entities", { entities: [alice, marina, alice] })).toEqual({
      entities: [alice, marina],
    });
    expect(await call("create_relations", { relations: [works, works] })).toEqual({
      relations: [works],
    });
    expect(await call("open_nodes", { names: ["Alice"] })).toEqual({
      entities: [alice],
      relations: [works],
    });
    expect(await call("search_nodes", { query: "SPANISH" })).toEqual({
      entities: [alice],
      relations: [works],
    });
    expect(
      (await http.graph(space, { subject: "Alice" })).edges.some(
        (e) => e.record.claim?.predicate === "works_on",
      ),
    ).toBe(true);
    expect(
      await call("add_observations", {
        observations: [{ entityName: "Alice", contents: ["Writes code", "Writes code"] }],
      }),
    ).toEqual({
      results: [{ entityName: "Alice", addedObservations: ["Writes code", "Writes code"] }],
    });
    expect(
      await call("delete_observations", {
        deletions: [
          { entityName: "Alice", observations: ["Writes code"] },
          { entityName: "missing", observations: ["x"] },
        ],
      }),
    ).toEqual({ deletedCount: 2, missingEntities: ["missing"] });
    expect(await call("read_graph")).toEqual({ entities: [alice, marina], relations: [works] });
    expect(await call("delete_relations", { relations: [works] })).toEqual({ deletedCount: 1 });
    expect(await call("delete_entities", { entityNames: ["Alice", "unknown"] })).toEqual({
      deleted: ["Alice"],
      notFound: ["unknown"],
    });
    expect(await call("read_graph")).toEqual({ entities: [marina], relations: [] });
  } finally {
    await client.close();
    await server.close();
  }
});

it("rolls back an entire batch, handles concurrent writes and does not expose another space", async () => {
  const { http, space } = await fixture();
  await http.knowledgeGraph(space, "create_entities", { entities: [alice] }, "create");
  const before = await http.knowledgeGraph(space, "read_graph");
  await expect(
    http.knowledgeGraph(space, "add_observations", {
      observations: [
        { entityName: "Alice", contents: ["must roll back"] },
        { entityName: "missing", contents: ["no"] },
      ],
    }),
  ).rejects.toMatchObject({ code: "entity_not_found" });
  expect(await http.knowledgeGraph(space, "read_graph")).toEqual(before);
  expect((await http.sourceSearch(space, { query: "must roll back" })).results).toEqual([]);
  await Promise.all(
    ["one", "two"].map((text) =>
      http.knowledgeGraph(space, "add_observations", {
        observations: [{ entityName: "Alice", contents: [text] }],
      }),
    ),
  );
  expect(await http.knowledgeGraph(space, "read_graph")).toEqual({
    entities: [{ ...alice, observations: [...alice.observations, "one", "two"] }],
    relations: [],
  });
  expect(
    await http.knowledgeGraph(space, "create_entities", { entities: [alice] }, "create"),
  ).toEqual({ entities: [alice] });
  const other = (await http.createSpace("other")).id;
  expect(await http.knowledgeGraph(other, "read_graph")).toEqual({ entities: [], relations: [] });
});

it("forgets observation sources and histories and retires receipts that copied the removed content", async () => {
  const { http, space, raw } = await fixture();
  const value = { ...alice, observations: ["secretneedle27"] };
  await http.knowledgeGraph(space, "create_entities", { entities: [value, marina] }, "create");
  await http.knowledgeGraph(space, "create_relations", { relations: [works] }, "relation");
  const removed = await http.knowledgeGraph(
    space,
    "delete_observations",
    { deletions: [{ entityName: "Alice", observations: ["secretneedle27"] }] },
    "remove",
  );
  expect(removed).toEqual({ deletedCount: 1, missingEntities: [] });
  expect(
    await http.knowledgeGraph(
      space,
      "delete_observations",
      { deletions: [{ entityName: "Alice", observations: ["secretneedle27"] }] },
      "remove",
    ),
  ).toEqual(removed);
  await expect(
    http.knowledgeGraph(space, "create_entities", { entities: [value, marina] }, "create"),
  ).rejects.toMatchObject({ code: "receipt_retired" });
  expect((await http.sourceSearch(space, { query: "secretneedle27" })).results).toEqual([]);
  expect((await http.search(space, { query: "secretneedle27" })).results).toEqual([]);
  expect(
    raw
      .query("SELECT count(*) n FROM memory_requests WHERE response LIKE '%secretneedle27%'")
      .get(),
  ).toEqual({ n: 0 });
  expect((await http.knowledgeGraph(space, "read_graph")).relations).toEqual([works]);
  await http.knowledgeGraph(space, "delete_entities", { entityNames: ["Alice"] });
  expect((await http.knowledgeGraph(space, "read_graph")).relations).toEqual([]);
  expect((await http.graph(space, { subject: "Alice" })).edges).toEqual([]);
});

it("preserves profile data through native transfer and requires explicit review after native premise changes", async () => {
  const { http, space } = await fixture();
  await http.knowledgeGraph(space, "create_entities", { entities: [alice, marina] });
  await http.knowledgeGraph(space, "create_relations", { relations: [works] });
  const destination = await fixture();
  const target = destination.space;
  const page = await http.exportTransferPage(space);
  expect(page.done).toBe(true);
  const transfer = await destination.http.beginTransfer(target, page.header);
  await destination.http.appendTransfer(target, transfer.id, page);
  await destination.http.commitTransfer(target, transfer.id, page.sha256);
  expect(await destination.http.knowledgeGraph(target, "read_graph")).toEqual(
    await http.knowledgeGraph(space, "read_graph"),
  );
  const premise = await http.remember(space, { content: "Authored premise" });
  const observation = (await http.search(space, { query: "Spanish" })).results[0]!;
  await http.revise(space, observation.id, observation.version, {
    content: observation.content,
    depends_on: [premise.id],
  });
  await http.revise(space, premise.id, 1, { content: "Corrected premise" });
  await expect(http.knowledgeGraph(space, "read_graph")).rejects.toMatchObject({
    code: "compat_review_required",
  });
  await http.reaffirm(space, observation.id, 2, { [premise.id]: 2 });
  expect(await http.knowledgeGraph(space, "read_graph")).toEqual({
    entities: [alice, marina],
    relations: [works],
  });
  const entity = (await http.query(space, { predicate: "mcp:entity_type" })).results[0]!;
  await http.revise(space, entity.id, entity.version, { content: "malformed profile JSON" });
  await expect(http.knowledgeGraph(space, "read_graph")).rejects.toMatchObject({
    code: "invalid_compat_record",
  });
});
