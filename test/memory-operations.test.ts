// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createContextManager } from "../src/agent/context-manager";
import { DurableResidentMemory } from "../src/agent/durable-memory";
import { LeanAgentAdapter, resolveModel } from "../src/agent/lean-agent-adapter";
import { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { parseMemoryServiceCommand } from "../src/memory/human-interface";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MemoryService } from "../src/memory/service";
import { createMemoryMcpServer } from "../src/net/mcp-server";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { configureMemoryStorage, memoryLimitsFromEnv } from "../src/persistence/db-memory-storage";
import { exportState, importState } from "../src/persistence/export-import";
import { BASE_SCHEMA, MIGRATIONS } from "../src/persistence/schema";
import { MarinaClient } from "../src/sdk/client";
import { MarinaMemoryClient, MemoryClientError } from "../src/sdk/memory-client";
import { runMemoryOperation } from "../src/sdk/memory-operations";
import { retryMemoryOperation } from "../src/sdk/memory-retry";

const deferred = <T = void>() => Promise.withResolvers<T>();
let directory: string,
  path: string,
  db: MarinaDB,
  raw: Database,
  service: MemoryService,
  client: MarinaMemoryClient,
  token: string,
  owner: string,
  space: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marina-operations-"));
  path = join(directory, "memory.db");
  db = new MarinaDB(path, { durability: "full" });
  raw = (db as unknown as { db: Database }).db;
  owner = db.ensurePrincipal({ type: "service", displayName: "owner" }).principal_id;
  token = db.issueMemoryCredential(owner).token;
  service = new MemoryService(db);
  client = new MarinaMemoryClient("http://memory.test", token, 35000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  space = (await client.createSpace("operations", "space")).id;
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});
function projectionMatches() {
  expect(
    raw
      .query("SELECT * FROM memory_storage_items EXCEPT SELECT * FROM memory_storage_projection")
      .all(),
  ).toEqual([]);
  expect(
    raw
      .query("SELECT * FROM memory_storage_projection EXCEPT SELECT * FROM memory_storage_items")
      .all(),
  ).toEqual([]);
  expect(
    raw
      .query(`SELECT u.* FROM memory_storage_usage u WHERE
    u.logical_bytes!=(SELECT coalesce(sum(bytes),0) FROM memory_storage_items WHERE space_id=u.space_id)
    OR u.sources!=(SELECT count(*) FROM memory_storage_items WHERE space_id=u.space_id AND kind='source')
    OR u.revisions!=(SELECT count(*) FROM memory_storage_items WHERE space_id=u.space_id AND kind='revision')`)
      .all(),
  ).toEqual([]);
  expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
}

it("cancels before dispatch without changing other users of the TypeScript client", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  let calls = 0;
  const transport = new MarinaMemoryClient("http://memory.test", token, 35000, async (req) => {
    calls++;
    return handleMemoryServiceApi(req, service);
  });
  await expect(
    transport.withSignal(controller.signal).capture(space, "never sent"),
  ).rejects.toThrow("stop");
  expect(calls).toBe(0);
  expect((await transport.usage()).usage.sources).toBe(0);
  expect(calls).toBe(1);
  await expect(
    runMemoryOperation(transport, { operation: "usage" }, undefined, controller.signal),
  ).rejects.toThrow("stop");
  expect(calls).toBe(1);
});

it("settles cancelled non-cooperative fetches and response bodies without retrying", async () => {
  for (const stage of ["fetch", "body"] as const) {
    const controller = new AbortController(),
      entered = deferred();
    let calls = 0;
    const transport = new MarinaMemoryClient("http://memory.test", token, 35000, async () => {
      calls++;
      entered.resolve();
      if (stage === "fetch") return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start() {} }));
    });
    const operation = retryMemoryOperation(() => transport.withSignal(controller.signal).usage(), {
      signal: controller.signal,
    });
    const rejected = operation.then(
      () => {
        throw new Error("unexpected success");
      },
      (error) => error,
    );
    const reason = "cancelled";
    await entered.promise;
    // Let response.json begin when testing cancellation of the body reader.
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(new DOMException("cancelled", "TimeoutError"));
    expect((await rejected).message).toBe(reason);
    expect(calls).toBe(1);
  }
}, 2000);

it("cancels a retry backoff without dispatching another attempt", async () => {
  const controller = new AbortController(),
    sleeping = deferred();
  let calls = 0;
  const operation = retryMemoryOperation(
    async () => {
      calls++;
      throw new MemoryClientError(503, "storage_busy", "busy", 1000);
    },
    {
      signal: controller.signal,
      sleep: async () => {
        sleeping.resolve();
        await new Promise(() => {});
      },
    },
  );
  const rejected = operation.then(
    () => {
      throw new Error("unexpected success");
    },
    (error) => error,
  );
  const reason = "stop backoff";
  await sleeping.promise;
  controller.abort(new Error("stop backoff"));
  expect((await rejected).message).toBe(reason);
  expect(calls).toBe(1);
}, 2000);

it("recovers an acknowledged-late committed write after cancellation using its original key", async () => {
  const controller = new AbortController(),
    committed = deferred(),
    release = deferred();
  const transport = new MarinaMemoryClient("http://memory.test", token, 35000, async (req) => {
    const response = await handleMemoryServiceApi(req, service);
    committed.resolve();
    await release.promise;
    return response;
  });
  const operation = transport
    .withSignal(controller.signal)
    .capture(space, "already committed", undefined, "lost-ack");
  const rejected = operation.then(
    () => {
      throw new Error("unexpected success");
    },
    (error) => error,
  );
  const reason = "stop waiting";
  await committed.promise;
  controller.abort(new Error("stop waiting"));
  expect((await rejected).message).toBe(reason);
  const before = await client.usage();
  const receipt = await client.capture(space, "already committed", undefined, "lost-ack");
  release.resolve();
  expect((await client.sources(space)).sources.map((s) => s.id)).toEqual([receipt.id]);
  expect(await client.usage()).toEqual(before);
  projectionMatches();
});

it("cancels incoming body reads and non-cooperative planners without writing or returning evidence", async () => {
  const controller = new AbortController(),
    entered = deferred();
  let cancelled = false;
  const req = new Request(`http://memory.test/v1/memory/spaces/${space}/sources`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": "body" },
    signal: controller.signal,
    body: new ReadableStream({
      pull() {
        entered.resolve();
      },
      cancel() {
        cancelled = true;
      },
    }),
  });
  const operation = handleMemoryServiceApi(req, service);
  await entered.promise;
  controller.abort();
  expect((await operation).status).toBe(499);
  expect(cancelled).toBe(true);
  expect((await client.usage()).usage.sources).toBe(0);
  const planning = deferred(),
    planController = new AbortController();
  const plannedService = new MemoryService(db, undefined, {
    id: "pending",
    async plan(_task, _vocab, signal) {
      expect(signal).toBeDefined();
      planning.resolve();
      return new Promise(() => {});
    },
  });
  const planRequest = new Request(`http://memory.test/v1/memory/spaces/${space}/plan`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: planController.signal,
    body: JSON.stringify({ task: "original", use_model: true }),
  });
  const pendingPlan = handleMemoryServiceApi(planRequest, plannedService);
  await planning.promise;
  planController.abort();
  expect((await pendingPlan).status).toBe(499);
}, 2000);

it("cancels the real WebSocket client's local wait and cleans listeners even if send throws", async () => {
  const ws = new MarinaClient("ws://memory.test");
  const internal = ws as unknown as {
    session: unknown;
    eventListeners: Map<string, unknown[]>;
    send(message: unknown): void;
    handlers: unknown[];
  };
  internal.session = {};
  let sends = 0;
  internal.send = () => {
    sends++;
  };
  const controller = new AbortController();
  const pending = ws.memoryService({ operation: "usage" }, 35000, controller.signal);
  const rejected = pending.then(
    () => {
      throw new Error("unexpected success");
    },
    (error) => error,
  );
  const reason = "stop websocket";
  expect(internal.handlers.length).toBe(1);
  controller.abort(new Error("stop websocket"));
  expect((await rejected).message).toBe(reason);
  expect(internal.handlers).toHaveLength(0);
  expect(internal.eventListeners.get("disconnect")?.length ?? 0).toBe(0);
  await expect(ws.memoryService({ operation: "usage" }, 35000, controller.signal)).rejects.toThrow(
    "stop websocket",
  );
  expect(sends).toBe(1);
  internal.send = () => {
    throw new Error("socket closed");
  };
  await expect(ws.memoryService({ operation: "usage" })).rejects.toThrow("socket closed");
  expect(internal.handlers).toHaveLength(0);
  expect(internal.eventListeners.get("disconnect")?.length ?? 0).toBe(0);
});

it("does not dispatch a cancelled queued resident journal when the earlier write completes", async () => {
  db.createUser({ id: crypto.randomUUID(), name: "Resident" });
  const entered = deferred(),
    release = deferred();
  let captures = 0;
  const durable = new DurableResidentMemory({
    memoryService: async (request) => {
      if (request.operation === "capture_batch") {
        captures++;
        entered.resolve();
        await release.promise;
      }
      return residentMemoryOperation(db, "Resident", request);
    },
  });
  const first = durable.journal({ role: "user", content: "first" });
  await entered.promise;
  const controller = new AbortController();
  const cancelled = durable.journal({ role: "user", content: "must not write" }, controller.signal);
  const rejected = cancelled.then(
    () => {
      throw new Error("unexpected success");
    },
    (error) => error,
  );
  const reason = "cancel queued";
  controller.abort(new Error("cancel queued"));
  expect((await rejected).message).toBe(reason);
  release.resolve();
  await first;
  expect((await durable.checkpoint())?.version).toBe(1);
  expect(captures).toBe(1);
});

it("aborts a hanging journal through the actual resident agent without calling the model", async () => {
  db.createUser({ id: crypto.randomUUID(), name: "Resident" });
  const entered = deferred();
  const adapter = new LeanAgentAdapter({ name: "Resident" }, "ws://memory.test", null);
  const internals = adapter as unknown as {
    agent: Agent;
    platformMemory: PlatformMemoryBackend;
    setupActionTracking(): void;
  };
  internals.platformMemory = new PlatformMemoryBackend({
    memoryService: async (request) => {
      if (request.operation === "capture_batch") {
        entered.resolve();
        return new Promise(() => {});
      }
      return residentMemoryOperation(db, "Resident", request);
    },
  } as MarinaClient);
  internals.setupActionTracking();
  const agent = internals.agent;
  agent.transformContext = undefined;
  agent.getApiKey = () => undefined;
  let models = 0;
  agent.streamFunction = async () => {
    models++;
    throw new Error("model must not run");
  };
  const prompt = agent.prompt("original survives cancellation");
  await entered.promise;
  agent.abort();
  await prompt;
  await agent.waitForIdle();
  expect(models).toBe(0);
  expect(JSON.stringify(agent.state.messages)).toContain("original survives cancellation");
  expect(
    await new DurableResidentMemory({
      memoryService: (req) => residentMemoryOperation(db, "Resident", req),
    }).checkpoint(),
  ).toBeNull();
}, 2000);

it("archives the system-prompt emergency compaction path and retains originals when cancelled", async () => {
  const entered = deferred(),
    controller = new AbortController();
  const messages = Array.from({ length: 20 }, (_, n) => ({
    role: "user" as const,
    content: `original ${n}`,
    timestamp: n,
  }));
  const original = JSON.stringify(messages);
  const compact = createContextManager({
    getModel: () => ({
      ...resolveModel("anthropic/claude-sonnet-4-20250514"),
      compat: undefined,
      contextWindow: 1024,
    }),
    getSystemPrompt: () => "large system ".repeat(500),
    onBeforeCompact: async (captured, _summary, signal) => {
      expect(captured).toEqual(messages);
      expect(signal).toBe(controller.signal);
      entered.resolve();
      await new Promise(() => {});
    },
  });
  const pending = compact(messages, controller.signal);
  const rejected = pending.then(
    () => {
      throw new Error("unexpected success");
    },
    (error) => error,
  );
  const reason = "cancel compact";
  await entered.promise;
  controller.abort(new Error("cancel compact"));
  expect((await rejected).message).toBe(reason);
  expect(JSON.stringify(messages)).toBe(original);
}, 2000);

it("enforces owner source limits across spaces and writers, including atomic batches and retry receipts", async () => {
  configureMemoryStorage(raw, { sources: 2, spaces: 2 });
  const otherSpace = (await client.createSpace("other", "other-space")).id;
  const writer = db.ensurePrincipal({ type: "service", displayName: "writer" }).principal_id;
  const writerClient = new MarinaMemoryClient(
    "http://memory.test",
    db.issueMemoryCredential(writer).token,
    35000,
    (req) => handleMemoryServiceApi(req, service),
  );
  await client.grant(space, writer, "writer");
  const first = await writerClient.capture(space, "α🙂", undefined, "first");
  expect((await writerClient.usage()).usage.sources).toBe(0);
  expect((await client.usage()).usage.sources).toBe(1);
  const before = await client.space(otherSpace),
    usage = await client.usage();
  await expect(
    client.captureBatch(
      otherSpace,
      [
        { content: "rolled back", key: "batch1" },
        { content: "over", key: "batch2" },
      ],
      "batch",
    ),
  ).rejects.toMatchObject({ status: 507, code: "quota_exceeded" });
  expect(await client.space(otherSpace)).toEqual(before);
  expect(await client.usage()).toEqual(usage);
  expect((await client.sources(otherSpace)).sources).toEqual([]);
  const second = await client.capture(otherSpace, "second", undefined, "batch1");
  await expect(writerClient.capture(space, "over", undefined, "over")).rejects.toMatchObject({
    code: "quota_exceeded",
  });
  expect(await writerClient.capture(space, "α🙂", undefined, "first")).toEqual(first);
  await expect(client.createSpace("third", "third")).rejects.toMatchObject({
    code: "quota_exceeded",
  });
  await client.forget(otherSpace, { source_ids: [second.id] });
  await writerClient.capture(space, "now admitted", undefined, "over");
  expect((await client.usage()).usage.sources).toBe(2);
  projectionMatches();
});

it("accounts for UTF-8 sources, historical revisions and checkpoint receipts without silent eviction", async () => {
  const source = await client.capture(space, "α🙂", "session");
  expect(
    raw
      .query("SELECT bytes FROM memory_storage_items WHERE kind='source' AND ref=?")
      .get(source.id),
  ).toEqual({
    bytes: Buffer.byteLength(JSON.stringify("α🙂")) + Buffer.byteLength("session") + 128,
  });
  configureMemoryStorage(raw, { revisions: 2 });
  const record = await client.remember(space, { content: "original", source_ids: [source.id] });
  await client.revise(space, record.id, 1, { content: "corrected", source_ids: [source.id] });
  await expect(
    client.revise(space, record.id, 2, { content: "too many revisions" }),
  ).rejects.toMatchObject({ code: "quota_exceeded" });
  expect((await client.get(space, record.id, 1)).content).toBe("original");
  expect((await client.get(space, record.id)).version).toBe(2);
  await client.saveCheckpoint(space, "resident", 0, { content: "small" }, 0, "cp1");
  const before = await client.usage();
  // Even replacing with the same-sized checkpoint grows its durable receipt history.
  configureMemoryStorage(raw, { logical_bytes: before.usage.logical_bytes });
  await expect(
    client.saveCheckpoint(space, "resident", 1, { content: "small" }, 0, "cp2"),
  ).rejects.toMatchObject({ code: "quota_exceeded" });
  expect((await client.checkpoint(space, "resident")).version).toBe(1);
  expect((await client.usage()).usage).toEqual(before.usage);
  await client.forget(space, { source_ids: [source.id] });
  expect((await client.usage()).usage).toMatchObject({ sources: 0, revisions: 0 });
  projectionMatches();
});

it("allows reads, explicit forgetting and revocation after an operator lowers the budget", async () => {
  const writer = db.ensurePrincipal({ type: "service", displayName: "writer" }).principal_id;
  await client.grant(space, writer, "writer");
  const source = await client.capture(space, "readable evidence", undefined, "original");
  configureMemoryStorage(raw, { logical_bytes: 1 });
  expect((await client.usage()).over_limit).toEqual(["logical_bytes"]);
  expect((await client.sourceRange(space, source.id)).text).toBe("readable evidence");
  await expect(client.capture(space, "more")).rejects.toMatchObject({ code: "quota_exceeded" });
  expect(await client.capture(space, "readable evidence", undefined, "original")).toEqual(source);
  await client.grant(space, writer, null);
  await client.forget(space, {
    all: true,
    expected_generation: (await client.space(space)).generation,
  });
  expect((await client.usage()).usage.spaces).toBe(0);
  expect((await client.usage()).usage.sources).toBe(0);
  // Retained erasure receipts remain charged; forgetting is never an implicit receipt reset.
  expect((await client.usage()).usage.logical_bytes).toBeGreaterThan(0);
  projectionMatches();
});

it.each(["busy", "full", "readonly"] as const)(
  "rolls back actual SQLite %s failures, then recovers the same request exactly once",
  async (fault) => {
    const before = await client.space(space),
      usage = await client.usage();
    const lock = new Database(path);
    const pageCount = (raw.query("PRAGMA page_count").get() as { page_count: number }).page_count;
    const content = "must survive recovery α🙂 ".repeat(20000);
    raw.exec("PRAGMA busy_timeout=0");
    const request = () =>
      new Request(`http://memory.test/v1/memory/spaces/${space}/sources`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": "fault" },
        body: JSON.stringify({ content }),
      });
    try {
      if (fault === "busy") lock.exec("BEGIN IMMEDIATE");
      if (fault === "full") raw.exec(`PRAGMA max_page_count=${pageCount}`);
      if (fault === "readonly") raw.exec("PRAGMA query_only=ON");
      const response = await handleMemoryServiceApi(request(), service);
      expect(response.status).toBe(fault === "busy" ? 503 : fault === "full" ? 507 : 500);
      expect(await response.json()).toMatchObject({
        error: { code: `storage_${fault === "readonly" ? "read_only" : fault}` },
      });
      if (fault === "busy") expect(response.headers.get("Retry-After")).toBe("1");
    } finally {
      if (lock.inTransaction) lock.exec("ROLLBACK");
      lock.close();
      raw.exec("PRAGMA query_only=OFF");
      raw.exec("PRAGMA max_page_count=4294967294");
    }
    expect(await client.space(space)).toEqual(before);
    expect(await client.usage()).toEqual(usage);
    expect(raw.query("SELECT 1 FROM memory_requests WHERE request_key='fault'").all()).toEqual([]);
    const receipt = await client.capture(space, content, undefined, "fault");
    expect(await client.capture(space, content, undefined, "fault")).toEqual(receipt);
    expect((await client.sources(space)).sources).toHaveLength(1);
    expect(
      (await client.sourceRange(space, receipt.id, { start: 0, end: 100 })).text.length,
    ).toBeGreaterThan(0);
    projectionMatches();
  },
);

it("keeps optional index work pending if its vector would exceed the owner's budget", async () => {
  service = new MemoryService(db, {
    id: "test-optional",
    embed: async () => Array(128).fill(0.25),
  });
  const receipt = await client.remember(space, { content: "indexed only if admitted" });
  const usage = await client.usage();
  configureMemoryStorage(raw, { logical_bytes: usage.usage.logical_bytes });
  await service.runIndexJobs();
  expect((await client.job(space, receipt.job_id!)).state).toBe("pending");
  expect(raw.query("SELECT * FROM memory_vectors").all()).toEqual([]);
  expect((await client.usage()).usage).toEqual(usage.usage);
  expect((await client.job(space, receipt.job_id!)).error).toBe("quota_exceeded");
  configureMemoryStorage(raw);
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 3000);
  try {
    await service.runIndexJobs();
    expect((await client.job(space, receipt.job_id!)).state).toBe("ready");
  } finally {
    clock.mockRestore();
  }
  projectionMatches();
});

it("rebuilds accounting on snapshot merge and backfills populated schema 104 databases", async () => {
  const source = await client.capture(space, "portable α🙂", "s", "capture");
  const record = await client.remember(space, { content: "first", source_ids: [source.id] });
  await client.revise(space, record.id, 1, { content: "second", source_ids: [source.id] });
  await client.saveCheckpoint(space, "cp", 0, { source: source.id });
  const snapshot = exportState(path);
  const destination = join(directory, "imported.db");
  new MarinaDB(destination).close();
  importState(destination, snapshot, { merge: true });
  importState(destination, snapshot, { merge: true });
  const imported = new MarinaDB(destination);
  try {
    const actor = imported.verifyMemoryCredential(imported.issueMemoryCredential(owner).token)!;
    const usage = imported.memoryRepository().usage(actor);
    expect(usage.usage).toMatchObject({ sources: 1, revisions: 2, spaces: 1 });
    expect(usage.usage.logical_bytes).toBeGreaterThan(0);
    const importedRaw = (imported as unknown as { db: Database }).db;
    expect(
      importedRaw
        .query("SELECT * FROM memory_storage_items EXCEPT SELECT * FROM memory_storage_projection")
        .all(),
    ).toEqual([]);
    expect(
      importedRaw
        .query("SELECT * FROM memory_storage_projection EXCEPT SELECT * FROM memory_storage_items")
        .all(),
    ).toEqual([]);
  } finally {
    imported.close();
  }
  const legacyPath = join(directory, "legacy.db"),
    legacy = new Database(legacyPath);
  legacy.exec(BASE_SCHEMA);
  for (const migration of MIGRATIONS.filter((m) => m.version <= 104)) {
    legacy.exec(migration.sql);
    legacy.run("INSERT INTO schema_version VALUES (?)", [migration.version]);
  }
  // Import canonical rows into the old schema before upgrading; projections are absent there.
  legacy.close();
  importState(legacyPath, { ...snapshot, schema_version: 104 });
  const upgraded = new MarinaDB(legacyPath, { memoryLimits: { sources: 1 } });
  try {
    const actor = upgraded.verifyMemoryCredential(upgraded.issueMemoryCredential(owner).token)!;
    const repo = upgraded.memoryRepository();
    expect(repo.usage(actor).usage).toMatchObject({ sources: 1, revisions: 2, spaces: 1 });
    expect(repo.sourceRange(actor, space, source.id).text).toBe("portable α🙂");
    expect(() => repo.capture(actor, space, "over", undefined, "over")).toThrow("budget exceeded");
  } finally {
    upgraded.close();
  }
});

it("validates operator budget configuration and exposes usage through resident operations without creating a space", async () => {
  expect(memoryLimitsFromEnv({ MARINA_MEMORY_MAX_BYTES: "1000" })).toEqual({ logical_bytes: 1000 });
  expect(() => memoryLimitsFromEnv({ MARINA_MEMORY_MAX_BYTES: "NaN" })).toThrow("positive integer");
  expect(() => configureMemoryStorage(raw, { sources: 0 })).toThrow("positive safe integer");
  expect(() => configureMemoryStorage(raw, { sources: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
    "positive safe integer",
  );
  db.createUser({ id: crypto.randomUUID(), name: "Resident" });
  const usage = await residentMemoryOperation(db, "Resident", { operation: "usage" });
  expect(usage.result).toMatchObject({ usage: { spaces: 0, sources: 0 } });
  expect(await runMemoryOperation(client, { operation: "usage" })).toEqual(await client.usage());
});

it("passes protocol cancellation through the memory-only MCP bridge to HTTP", async () => {
  const entered = deferred(),
    aborted = deferred();
  const transport = new MarinaMemoryClient("http://memory.test", token, 35000, async (req) => {
    entered.resolve();
    req.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return new Promise(() => {});
  });
  const mcp = createMemoryMcpServer(transport, space),
    caller = new McpClient({ name: "cancel-agent", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverTransport), caller.connect(clientTransport)]);
  try {
    const controller = new AbortController();
    const pending = caller.callTool(
      { name: "memory_service", arguments: { operation: "usage" } },
      undefined,
      { signal: controller.signal },
    );
    const outcome = pending.then(
      () => "unexpected success",
      () => "cancelled",
    );
    await entered.promise;
    controller.abort();
    expect(await outcome).toBe("cancelled");
    await aborted.promise;
  } finally {
    await caller.close();
    await mcp.close();
  }
  expect(parseMemoryServiceCommand("usage")).toEqual({ operation: "usage" });
}, 2000);

it("never silently degrades a cancelled optional semantic query into lexical results", async () => {
  await client.remember(space, { content: "needle" });
  const entered = deferred(),
    controller = new AbortController();
  const semantic = new MemoryService(db, {
    id: "non-cooperative",
    async embed(_text, signal) {
      expect(signal).toBe(controller.signal);
      entered.resolve();
      return new Promise(() => {});
    },
  });
  const pending = semantic.search(
    db.verifyMemoryCredential(token)!,
    space,
    { query: "needle", mode: "hybrid", allow_degraded: true },
    controller.signal,
  );
  const outcome = pending.then(
    () => "unexpected evidence",
    (error) => error.message,
  );
  await entered.promise;
  controller.abort(new Error("cancel semantics"));
  expect(await outcome).toBe("cancel semantics");
}, 2000);

it("archives before emergency pruning removes an orphaned tool result", async () => {
  const messages = [
    { role: "user" as const, content: "task", timestamp: 0 },
    {
      role: "toolResult" as const,
      toolCallId: "missing",
      toolName: "test",
      content: [{ type: "text" as const, text: "original tool output" }],
      isError: false,
      timestamp: 1,
    },
    { role: "user" as const, content: "continue", timestamp: 2 },
  ];
  let captured = "";
  const compact = createContextManager({
    getModel: () => ({
      ...resolveModel("anthropic/claude-sonnet-4-20250514"),
      compat: undefined,
      contextWindow: 1024,
    }),
    getSystemPrompt: () => "system ".repeat(1000),
    onBeforeCompact: async (originals) => {
      captured = JSON.stringify(originals);
    },
  });
  const result = await compact(messages);
  expect(captured).toBe(JSON.stringify(messages));
  expect(result.some((message) => message.role === "toolResult")).toBe(false);
  expect(messages[1]!.content).toEqual([{ type: "text", text: "original tool output" }]);
});

it("rejects oversized input without waiting for a non-cooperative stream cancellation", async () => {
  let cancelCalled = false;
  const response = await handleMemoryServiceApi(
    new Request(`http://memory.test/v1/memory/spaces/${space}/sources`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": "oversized" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
        },
        cancel() {
          cancelCalled = true;
          return new Promise(() => {});
        },
      }),
    }),
    service,
  );
  expect(response.status).toBe(413);
  expect(cancelCalled).toBe(true);
  expect((await client.usage()).usage.sources).toBe(0);
}, 2000);
