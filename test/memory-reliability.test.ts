// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DurableResidentMemory } from "../src/agent/durable-memory";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { snapshotMemoryDatabase } from "../src/persistence/db-memory-maintenance";
import { BASE_SCHEMA, MIGRATIONS } from "../src/persistence/schema";
import type { MarinaClient } from "../src/sdk/client";
import { MarinaMemoryClient, MemoryClientError } from "../src/sdk/memory-client";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";
import { retryMemoryOperation } from "../src/sdk/memory-retry";

function rows(path: string, sql: string) {
  const read = new Database(path, { readonly: true });
  try {
    return read.query(sql).all();
  } finally {
    read.close();
  }
}

let directory: string,
  db: MarinaDB,
  service: MemoryService,
  client: MarinaMemoryClient,
  space: string,
  token: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marina-reliability-"));
  db = new MarinaDB(join(directory, "memory.db"), { durability: "full" });
  service = new MemoryService(db);
  token = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "owner" }).principal_id,
  ).token;
  client = new MarinaMemoryClient("http://memory.test", token, 35000, (request) =>
    handleMemoryServiceApi(request, service),
  );
  space = (await client.createSpace("reliability")).id;
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});

it("captures atomically, preserving per-source receipts across regrouped retries", async () => {
  const first = await client.capture(space, "first", "session", "existing");
  const before = await client.space(space);
  await expect(
    client.captureBatch(
      space,
      [
        { content: "must rollback", key: "rolled-back" },
        { content: "conflict", key: "existing" },
      ],
      "batch",
    ),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(await client.space(space)).toEqual(before);
  expect((await client.sources(space)).sources).toHaveLength(1);
  const items = [
    { content: "first", session_id: "session", key: "existing" },
    { content: "second", key: "second" },
  ];
  const saved = await client.captureBatch(space, items, "batch");
  expect(saved.receipts[0]).toEqual(first);
  expect(await client.captureBatch(space, items, "batch")).toEqual(saved);
  const regrouped = await client.captureBatch(space, items.slice(1), "regrouped");
  expect(regrouped.receipts).toEqual(saved.receipts.slice(1));
  expect((await client.sources(space)).sources).toHaveLength(2);
  await expect(client.captureBatch(space, [])).rejects.toMatchObject({ code: "invalid_batch" });
  await expect(
    client.captureBatch(
      space,
      Array.from({ length: 65 }, (_, n) => ({ content: n, key: String(n) })),
    ),
  ).rejects.toMatchObject({ code: "invalid_batch" });
});

it("archives 160 messages byte-exactly despite lost batch and checkpoint acknowledgements", async () => {
  db.createUser({ id: crypto.randomUUID(), name: "Resident" });
  const losses = new Set(["capture_batch", "save_checkpoint"]);
  let batches = 0;
  const durable = new DurableResidentMemory({
    memoryService: async (request) => {
      if (request.operation === "capture_batch") batches++;
      const response = await residentMemoryOperation(db, "Resident", request);
      if (losses.delete(request.operation))
        throw new MemoryClientError(503, "lost_ack", "Committed response lost");
      return response;
    },
  });
  const messages = Array.from({ length: 160 }, (_, n) => ({
    role: "user",
    content: `original ${n}: αβ🙂 ${"detail ".repeat(30)}`,
  }));
  await durable.archive(messages, "deliberately incomplete summary");
  const checkpoint = (await durable.checkpoint())!;
  const archive = checkpoint.data.archive as {
    source_ids: string[];
    sha256: string;
    message_count: number;
  };
  const actor = db.verifyMemoryCredential(token)!;
  const owner = db.getPrincipal("human", "Resident")!;
  const residentToken = db.issueMemoryCredential(owner.principal_id).token;
  const reader = new MarinaMemoryClient("http://memory.test", residentToken, 35000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  const residentSpace = (await reader.spaces()).spaces[0]!.id;
  // Reconstruct directly through the same authorized source-range API; no DB content read.
  let reconstructed = "";
  for (const id of archive.source_ids)
    reconstructed += (await retryMemoryOperation(() => reader.sourceRange(residentSpace, id))).text;
  expect(reconstructed).toBe(JSON.stringify(messages));
  expect(archive.sha256).toBe(createHash("sha256").update(reconstructed).digest("hex"));
  expect(archive.message_count).toBe(160);
  expect(checkpoint.version).toBe(1);
  expect(losses.size).toBe(0);
  expect(batches).toBe(4); // Three bounded batches plus exactly one lost-ack retry.
  expect(() =>
    service.repository.sourceRange(actor, residentSpace, archive.source_ids[0]!),
  ).toThrow("not found");
  await durable.archive(messages, "same originals");
  expect((await durable.checkpoint())!.version).toBe(1);
  await reader.forget(residentSpace, { source_ids: [archive.source_ids[1]!] });
  await expect(
    durable.journal({ role: "user", content: "local memory must not resurrect" }),
  ).rejects.toMatchObject({ code: "checkpoint_invalidated" });
}, 15000);

it("propagates corrections transitively and requires explicit revision-aware review", async () => {
  const premise = await client.remember(space, { content: "route /v1" });
  const derived = await client.remember(space, {
    content: "call route /v1",
    depends_on: [premise.id],
    dependency_versions: { [premise.id]: 1 },
    claim: { subject: "client", predicate: "calls", object: { kind: "entity", id: "endpoint" } },
  });
  const further = await client.remember(space, {
    content: "deploy /v1 client",
    depends_on: [derived.id],
  });
  await client.revise(space, premise.id, 1, { content: "route /v2" });
  expect((await client.query(space)).results.map((r) => r.id)).toEqual([premise.id]);
  expect((await client.search(space, { query: "call" })).results).toHaveLength(0);
  expect((await client.graph(space, { subject: "client" })).edges).toHaveLength(0);
  expect(
    (await client.graph(space, { subject: "client", include_stale: true })).edges[0]?.record
      .freshness,
  ).toBe("stale");
  expect((await client.query(space, { include_stale: true })).results).toHaveLength(3);
  expect((await client.search(space, { query: "call", include_stale: true })).results[0]?.id).toBe(
    derived.id,
  );
  expect(await client.get(space, derived.id)).toMatchObject({
    content: "call route /v1",
    version: 1,
    freshness: "stale",
    dependency_versions: { [premise.id]: 1 },
  });
  expect((await client.get(space, further.id)).freshness).toBe("stale");
  await expect(
    client.remember(space, { content: "unreviewed", depends_on: [derived.id] }),
  ).rejects.toMatchObject({ code: "stale_dependency" });
  await client.revise(space, derived.id, 1, { content: "editorial change" });
  expect((await client.get(space, derived.id)).freshness).toBe("stale");
  await expect(
    client.revise(space, derived.id, 2, { content: "wrong review", depends_on: [premise.id] }),
  ).rejects.toMatchObject({ code: "dependency_review_required" });
  await expect(
    client.revise(space, derived.id, 2, {
      content: "racing review",
      dependency_versions: { [premise.id]: 1 },
    }),
  ).rejects.toMatchObject({ code: "dependency_changed" });
  await client.revise(space, derived.id, 2, {
    content: "call route /v2",
    dependency_versions: { [premise.id]: 2 },
  });
  expect((await client.get(space, derived.id)).freshness).toBe("current");
  expect((await client.get(space, derived.id, 1)).content).toBe("call route /v1");
  expect((await client.get(space, further.id)).freshness).toBe("stale");
  await client.revise(space, further.id, 1, { content: "independently verified", depends_on: [] });
  await client.revise(space, derived.id, 3, { content: "new editorial change" });
  expect((await client.get(space, further.id)).freshness).toBe("current"); // Only current dependency edges invalidate.
  await client.forget(space, { record_ids: [premise.id] });
  await expect(client.get(space, further.id)).rejects.toMatchObject({ status: 404 }); // Historical lineage still controls forgetting.
  expect(
    rows(join(directory, "memory.db"), "SELECT * FROM memory_revision_dependencies"),
  ).toHaveLength(0);
});

it("does not let stale cardinality claims veto a corrected premise", async () => {
  await client.saveVocabulary(space, 0, {
    closed: true,
    predicates: { status: { object: "string", cardinality: "one" } },
  });
  const claim = {
    subject: "deployment",
    predicate: "status",
    object: { kind: "literal" as const, value: "ready" },
  };
  const first = await client.remember(space, { content: "ready", claim });
  await client.remember(space, { content: "ready derived", claim, depends_on: [first.id] });
  await client.revise(space, first.id, 1, {
    content: "blocked",
    claim: { ...claim, object: { kind: "literal", value: "blocked" } },
  });
  expect((await client.query(space)).results.map((r) => r.content)).toEqual(["blocked"]);
});

it("keeps plans and pagination valid after checkpoint writes, but rejects data and access changes", async () => {
  await client.remember(space, { content: "needle first" });
  await client.remember(space, { content: "needle second" });
  const page = await client.query(space, { limit: 1 });
  const plan = await client.plan(space, { task: "needle" });
  await client.saveCheckpoint(space, "work", 0, { phase: 1 });
  expect(
    (await client.query(space, { limit: 1, cursor: page.next_cursor! })).results[0]?.id,
  ).not.toBe(page.results[0]?.id);
  expect((await client.executePlan(space, plan)).trace).not.toHaveLength(0);
  await client.capture(space, "new evidence");
  await expect(client.executePlan(space, plan)).rejects.toMatchObject({ code: "plan_changed" });
  await expect(client.query(space, { cursor: page.next_cursor! })).rejects.toMatchObject({
    code: "query_changed",
  });
  const other = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "reader" }).principal_id,
  );
  const reader = new MarinaMemoryClient("http://memory.test", other.token, 35000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  await client.grant(space, other.principalId, "reader");
  const sharedPlan = await reader.plan(space, { task: "needle" });
  await expect(reader.remember(space, { content: "no write authority" })).rejects.toMatchObject({
    status: 404,
  });
  await client.grant(space, other.principalId, null);
  await expect(reader.executePlan(space, sharedPlan)).rejects.toMatchObject({ status: 404 });
});

it("migrates populated legacy dependencies without inventing historical premise versions", () => {
  const path = join(directory, "legacy.db");
  const legacy = new Database(path);
  legacy.exec(BASE_SCHEMA);
  for (const migration of MIGRATIONS.filter((m) => m.version <= 103)) {
    legacy.exec(migration.sql);
    legacy.run("INSERT INTO schema_version VALUES (?)", [migration.version]);
  }
  legacy.run(
    "INSERT INTO principals(principal_id,principal_type,display_name,created_at) VALUES ('owner','service','legacy',0)",
  );
  legacy.run(
    "INSERT INTO memory_spaces(id,owner_id,name,generation,created_at) VALUES ('space','owner','legacy',4,0)",
  );
  legacy.run(
    "INSERT INTO notes(id,entity_name,content,created_at) VALUES (1,'legacy','premise revised',0),(2,'legacy','conclusion',0)",
  );
  legacy.run(
    "INSERT INTO memory_records(id,space_id,version,current_note_id,created_at) VALUES ('p','space',2,1,0),('d','space',1,2,0)",
  );
  legacy.run(
    "INSERT INTO memory_record_versions(record_id,version,note_id,attributes) VALUES ('p',2,1,'{}'),('d',1,2,?)",
    [JSON.stringify({ depends_on: ["p", "p"], source_ids: [] })],
  );
  legacy.run("INSERT INTO memory_dependencies VALUES ('d','p')");
  legacy.close();
  const upgraded = new MarinaDB(path);
  try {
    const actor = upgraded.verifyMemoryCredential(upgraded.issueMemoryCredential("owner").token)!;
    const repo = upgraded.memoryRepository();
    expect(repo.read(actor, "space", "d")).toMatchObject({
      freshness: "stale",
      content: "conclusion",
      stale_reason: { kind: "unversioned_dependency" },
    });
    expect(rows(path, "SELECT depends_on_version FROM memory_revision_dependencies")[0]).toEqual({
      depends_on_version: null,
    });
    expect(repo.authorize(actor, "space").retrieval_generation).toBe(4);
  } finally {
    upgraded.close();
  }
});

it("publishes a verified private WAL snapshot and restores content, credentials and stale state", async () => {
  const source = await client.capture(space, "original before backup", undefined, "original");
  const premise = await client.remember(space, { content: "before", source_ids: [source.id] });
  const derived = await client.remember(space, { content: "derived", depends_on: [premise.id] });
  await client.revise(space, premise.id, 1, { content: "after" });
  await client.saveCheckpoint(space, "work", 0, { next: "review" }, source.seq!, undefined, [
    source.id,
  ]);
  const backup = join(directory, "backup.db");
  const receipt = await snapshotMemoryDatabase(join(directory, "memory.db"), backup);
  expect(receipt.verified).toBe(true);
  expect(receipt.sha256).toBe(createHash("sha256").update(readFileSync(backup)).digest("hex"));
  expect(statSync(backup).mode & 0o777).toBe(0o600);
  await expect(snapshotMemoryDatabase(join(directory, "memory.db"), backup)).rejects.toThrow(
    "new database path",
  );
  const restoredPath = join(directory, "restored.db");
  await snapshotMemoryDatabase(backup, restoredPath);
  const restored = new MarinaDB(restoredPath, { durability: "full" });
  try {
    const restoredService = new MemoryService(restored);
    const fresh = new MarinaMemoryClient("http://memory.test", token, 35000, (req) =>
      handleMemoryServiceApi(req, restoredService),
    );
    expect((await fresh.sourceRange(space, source.id)).text).toBe("original before backup");
    expect((await fresh.get(space, premise.id)).content).toBe("after");
    expect((await fresh.get(space, derived.id)).freshness).toBe("stale");
    expect((await fresh.checkpoint(space, "work")).data).toEqual({ next: "review" });
    expect(await fresh.capture(space, "original before backup", undefined, "original")).toEqual(
      source,
    );
    expect((await fresh.query(space)).results).toHaveLength(1);
  } finally {
    restored.close();
  }
  const corrupt = join(directory, "corrupt.db");
  writeFileSync(corrupt, "not SQLite");
  await expect(snapshotMemoryDatabase(corrupt, join(directory, "invalid.db"))).rejects.toThrow();
});

it("reports unavailable storage and bounds opt-in retry without retrying denial or conflicts", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  expect(
    await retryMemoryOperation(
      async () => {
        calls++;
        if (calls < 3) throw new MemoryClientError(429, "rate_limited", "retry", 1000);
        return "ok";
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    ),
  ).toBe("ok");
  expect(sleeps).toEqual([1000, 1000]);
  let timedOut = false;
  expect(
    await retryMemoryOperation(
      async () => {
        if (!timedOut) {
          timedOut = true;
          throw new MemoryClientError(408, "memory_timeout", "receipt lost");
        }
        return "recovered";
      },
      { sleep: async () => {} },
    ),
  ).toBe("recovered");
  for (const status of [401, 403, 409]) {
    let deniedCalls = 0;
    await expect(
      retryMemoryOperation(async () => {
        deniedCalls++;
        throw new MemoryClientError(status, "denied", "stop");
      }),
    ).rejects.toMatchObject({ status });
    expect(deniedCalls).toBe(1);
  }
  await expect(retryMemoryOperation(async () => "bad", { attempts: Infinity })).rejects.toThrow(
    "Retry attempts",
  );
  db.close();
  expect(
    (await handleMemoryServiceApi(new Request("http://memory.test/v1/memory/health"), service))
      .status,
  ).toBe(503);
});

it("awaits the actual resident adapter's completed-message journal before the next model call and idle", async () => {
  db.createUser({ id: crypto.randomUUID(), name: "Resident" });
  let fail = false,
    calls = 0;
  const residentClient = {
    memoryService: async (request: MemoryOperationRequest) => {
      if (fail && request.operation === "capture_batch") throw new Error("storage unavailable");
      return residentMemoryOperation(db, "Resident", request);
    },
  };
  const backend = new PlatformMemoryBackend(residentClient as MarinaClient);
  const adapter = new LeanAgentAdapter({ name: "Resident" }, "ws://127.0.0.1:3300", null);
  const internals = adapter as unknown as {
    agent: Agent;
    platformMemory: PlatformMemoryBackend;
    setupActionTracking(): void;
  };
  internals.platformMemory = backend;
  internals.setupActionTracking();
  const agent = internals.agent;
  agent.transformContext = undefined;
  agent.getApiKey = () => undefined;
  agent.streamFunction = async (model) => {
    calls++;
    const checkpoint = await new DurableResidentMemory(residentClient).checkpoint();
    expect(checkpoint?.version).toBe(1); // User message is committed before model invocation.
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "preserved answer" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "stop",
      timestamp: 1,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  };
  await agent.prompt("preserve this original");
  await agent.waitForIdle();
  const checkpoint = (await new DurableResidentMemory(residentClient).checkpoint())!;
  expect(checkpoint.version).toBe(2);
  expect(checkpoint.source_cursor).toBe(0); // Journal must remain replayable after the last archive cursor.
  const journal = checkpoint.data.journal as { source_ids: string[] };
  let original = "";
  for (const id of journal.source_ids)
    original += (
      (await residentMemoryOperation(db, "Resident", { operation: "source_range", id })).result as {
        text: string;
      }
    ).text;
  expect(JSON.parse(original)[0].content[0].text).toBe("preserved answer");
  fail = true;
  await agent.prompt("must not reach the model");
  expect(calls).toBe(1);
  expect(agent.state.errorMessage).toContain("storage unavailable");
  expect((await new DurableResidentMemory(residentClient).checkpoint())!.version).toBe(2);
});

it("recovers a committed write through a non-JSON gateway failure using the same receipt key", async () => {
  let attempts = 0;
  const gateway = new MarinaMemoryClient("http://memory.test", token, 35000, async (request) => {
    const response = await handleMemoryServiceApi(request, service);
    if (attempts++ === 0)
      return new Response("Upstream response lost", {
        status: 503,
        headers: { "Retry-After": "1" },
      });
    return response;
  });
  const waits: number[] = [];
  const receipt = await retryMemoryOperation(
    () => gateway.capture(space, "committed behind gateway", undefined, "gateway-write"),
    {
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  expect(waits).toEqual([1000]);
  expect((await client.sources(space)).sources.map((source) => source.id)).toEqual([receipt.id]);
  const denied = new MarinaMemoryClient(
    "http://memory.test",
    token,
    35000,
    async () => new Response("denied", { status: 403 }),
  );
  await expect(denied.query(space)).rejects.toMatchObject({ status: 403 });
});
