// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosine, type EmbeddingProvider } from "../src/memory/embeddings";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MemoryService } from "../src/memory/service";
import { worldMemoryService } from "../src/memory/world-service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";

let directory: string;

it("keeps cosine finite for extreme provider magnitudes and rejects zero directions", () => {
  expect(cosine([1e308, 1e308], [1e-308, 1e-308])).toBeCloseTo(1, 12);
  expect(cosine([1e308, 0], [0, 1e-308])).toBe(0);
  expect(() => cosine([0, 0], [1, 0])).toThrow("finite nonzero direction");
});
let db: MarinaDB;
let service: MemoryService;
let owner: { token: string; principalId: string; credentialId: string };
let other: typeof owner;
let space: string;
async function api(
  path: string,
  method = "GET",
  body?: unknown,
  token = owner.token,
  key: string = crypto.randomUUID(),
) {
  const request = new Request(`http://memory.invalid/v1/memory${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      "X-Agent-Name": "owner",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleMemoryServiceApi(request, service);
  return { status: response.status, data: await response.json() };
}
const route = (path: string) => `/spaces/${space}${path}`;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marina-service-"));
  db = new MarinaDB(join(directory, "test.db"));
  service = new MemoryService(db);
  owner = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "owner" }).principal_id,
  );
  other = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "other" }).principal_id,
  );
  const created = await api("/spaces", "POST", { name: "task" });
  expect(created.status).toBe(201);
  space = created.data.id;
});
afterEach(() => {
  service.stopWorker();
  db.close();
  rmSync(directory, { recursive: true });
});

it("works without world residents and rejects foreign audiences, scopes and impersonation headers", async () => {
  expect((await api("/me")).data.principal_id).toBe(owner.principalId);
  expect((await api(route(""), "GET", undefined, other.token)).status).toBe(404);
  const readonly = db.issueMemoryCredential(owner.principalId, ["memory:read"]);
  expect(
    (await api(route("/records"), "POST", { content: "forbidden" }, readonly.token)).status,
  ).toBe(403);
  const agent = db.ensurePrincipal({ type: "agent", displayName: "world-agent" });
  const world = db.issueWorkloadCredential(agent.principal_id);
  expect((await api("/me", "GET", undefined, world.token)).status).toBe(401);
  db.revokeWorkloadCredential(owner.credentialId);
  expect((await api("/me")).status).toBe(401);
});

it("makes retried writes idempotent and rejects competing revisions", async () => {
  const input = { content: "launchneedle deployment is Tuesday", metadata: { stage: 1 } };
  const first = await api(route("/records"), "POST", input, owner.token, "create");
  const repeat = await api(
    route("/records"),
    "POST",
    { metadata: { stage: 1 }, content: input.content },
    owner.token,
    "create",
  );
  expect(repeat.data).toEqual(first.data);
  expect(
    (await api(route("/records"), "POST", { content: "different" }, owner.token, "create")).status,
  ).toBe(409);
  const revised = await api(route(`/records/${first.data.id}`), "PATCH", {
    content: "launchneedle deployment is Friday",
    expected_version: 1,
    metadata: { stage: 2 },
  });
  expect(revised.data.version).toBe(2);
  expect(
    (
      await api(route(`/records/${first.data.id}`), "PATCH", {
        content: "stale",
        expected_version: 1,
      })
    ).status,
  ).toBe(409);
  const results = await api(route("/search"), "POST", { query: "launchneedle" });
  expect(results.data.results).toHaveLength(1);
  expect(results.data.results[0].content).toContain("Friday");
  const historical = await api(route(`/records/${first.data.id}?version=1`));
  expect(historical.data.content).toContain("Tuesday");
  expect(historical.data.metadata).toEqual({ stage: 1 });
});

it("captures original evidence and acknowledges checkpoint cursors atomically", async () => {
  const content = { role: "tool", result: "EXACT_EVIDENCE", detail: "line\n  two" };
  const source = await api(
    route("/sources"),
    "POST",
    { content, session_id: "work" },
    owner.token,
    "source",
  );
  expect(source.status).toBe(201);
  expect(
    (await api(route("/sources"), "POST", { content, session_id: "work" }, owner.token, "source"))
      .data,
  ).toEqual(source.data);
  expect((await api(route("/sources"))).data.sources[0].body).toEqual(content);
  expect(
    (
      await api(route("/checkpoints/work"), "POST", {
        expected_version: 0,
        source_cursor: 99999,
        data: { goal: "resume" },
      })
    ).status,
  ).toBe(409);
  const checkpoint = await api(route("/checkpoints/work"), "POST", {
    expected_version: 0,
    source_cursor: source.data.seq,
    data: { goal: "resume", decision: "retain  exact whitespace" },
  });
  expect(checkpoint.data.version).toBe(1);
  expect((await api(route("/checkpoints/work"))).data.data.decision).toBe(
    "retain  exact whitespace",
  );
});

it("rechecks grants after embedding awaits and never queries an unauthorized space", async () => {
  let resolve: ((vector: number[]) => void) | undefined;
  let calls = 0;
  const provider: EmbeddingProvider = {
    id: "test-only-controlled-v1",
    embed: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
  };
  service = new MemoryService(db, provider);
  expect(
    (await api(route("/search"), "POST", { query: "secret", mode: "hybrid" }, other.token)).status,
  ).toBe(404);
  expect(calls).toBe(0);
  await api(route("/grants"), "POST", { principal_id: other.principalId, role: "reader" });
  const pending = api(route("/search"), "POST", { query: "secret", mode: "hybrid" }, other.token);
  while (!resolve) await Bun.sleep(1);
  await api(route("/grants"), "POST", { principal_id: other.principalId, role: null });
  resolve([1, 0]);
  expect((await pending).status).toBe(404);
});

it("uses durable jobs, refuses partial semantic indexes by default and reports deliberate fallback", async () => {
  service = new MemoryService(db, { id: "test-only-vector-v1", embed: async () => [1, 0] });
  const saved = await api(route("/records"), "POST", {
    content: "indexneedle remembered evidence",
  });
  expect(saved.data.job_id).toBeTruthy();
  expect(
    (await api(route("/search"), "POST", { query: "indexneedle", mode: "hybrid" })).status,
  ).toBe(503);
  const fallback = await api(route("/search"), "POST", {
    query: "indexneedle",
    mode: "hybrid",
    allow_degraded: true,
  });
  expect(fallback.data.degraded).toContain("index_incomplete");
  expect(await service.runIndexJobs()).toBe(1);
  expect((await api(route(`/jobs/${saved.data.job_id}`))).data.state).toBe("ready");
  const search = await api(route("/search"), "POST", { query: "indexneedle", mode: "hybrid" });
  expect(search.data.results[0].ranks).toEqual({ lexical: 1, semantic: 1 });
});

it("recovers expired worker leases and refuses a late result for a revised head", async () => {
  service = new MemoryService(db, { id: "test-only-recovery-v1", embed: async () => [1, 0] });
  const saved = await api(route("/records"), "POST", { content: "original value" });
  const stale = service.repository.claimJob(service.embeddings!.id)!;
  expect(stale.id).toBe(saved.data.job_id);
  const raw = new Database(join(directory, "test.db"));
  raw.run("UPDATE memory_index_jobs SET lease_until=0 WHERE id=?", [stale.id]);
  raw.close();
  const recovered = service.repository.claimJob(service.embeddings!.id)!;
  expect(recovered.lease_token).not.toBe(stale.lease_token);
  expect(service.repository.finishJob(stale, [1, 0])).toBe(false);
  await api(route(`/records/${saved.data.id}`), "PATCH", {
    expected_version: 1,
    content: "corrected value",
  });
  expect(service.repository.finishJob(recovered, [1, 0])).toBe(false);
  expect(await service.runIndexJobs()).toBe(1);
});

it("indexes existing lexical memories when a provider is added or changed", async () => {
  await api(route("/records"), "POST", { content: "previously lexical evidence" });
  for (const model of ["test-only-upgrade-v1", "test-only-upgrade-v2"]) {
    service = new MemoryService(db, { id: model, embed: async () => [1, 0] });
    expect(
      (await api(route("/search"), "POST", { query: "evidence", mode: "hybrid" })).status,
    ).toBe(503);
    const generation = (await api(route(""))).data.generation;
    const input = { expected_generation: generation };
    const queued = await api(route("/reindex"), "POST", input, owner.token, model);
    expect(queued.status).toBe(202);
    expect(queued.data.job_ids).toHaveLength(1);
    expect((await api(route("/reindex"), "POST", input, owner.token, model)).data).toEqual(
      queued.data,
    );
    expect((await api(route("/reindex"), "POST", input)).status).toBe(409);
    expect(await service.runIndexJobs()).toBe(1);
    const recalled = await api(route("/search"), "POST", { query: "evidence", mode: "hybrid" });
    expect(recalled.data.results[0].content).toBe("previously lexical evidence");
    expect(recalled.data.degraded).toEqual([]);
  }
});

it("forgets sources, dependent versions, vectors and copied checkpoints together", async () => {
  service = new MemoryService(db, { id: "test-only-forget-v1", embed: async () => [1, 0] });
  const source = await api(route("/sources"), "POST", { content: "FORGET_SENTINEL" });
  const first = await api(route("/records"), "POST", {
    content: "FORGET_SENTINEL source claim",
    source_ids: [source.data.id],
  });
  const derived = await api(route("/records"), "POST", {
    content: "FORGET_SENTINEL derived",
    depends_on: [first.data.id],
  });
  await api(route("/checkpoints/work"), "POST", {
    expected_version: 0,
    data: { copied: "FORGET_SENTINEL" },
  });
  await service.runIndexJobs();
  expect((await api(route("/forget"), "POST", { source_ids: [source.data.id] })).status).toBe(200);
  expect((await api(route(`/records/${first.data.id}`))).status).toBe(404);
  expect((await api(route(`/records/${derived.data.id}`))).status).toBe(404);
  expect((await api(route("/checkpoints/work"))).status).toBe(404);
  expect((await api(route("/sources"))).data.sources).toEqual([]);
  expect(JSON.stringify((await api(route("/export"))).data)).not.toContain("FORGET_SENTINEL");
  expect(
    service.repository.vectors(
      db.verifyMemoryCredential(owner.token)!,
      space,
      service.embeddings!.id,
    ),
  ).toEqual([]);
});

it("bounds returned context including Unicode, JSON escaping and citation framing", async () => {
  await api(route("/records"), "POST", { content: `budgetneedle ${'"\\🧠'.repeat(2000)} END` });
  for (const budget_tokens of [32, 128, 512]) {
    const result = await api(route("/context"), "POST", { query: "budgetneedle", budget_tokens });
    expect(result.status).toBe(200);
    expect(Buffer.byteLength(result.data.text)).toBeLessThanOrEqual(budget_tokens);
    expect(result.data.estimated_tokens).toBe(Buffer.byteLength(result.data.text));
  }
});

it("requires current-generation owner consent to forget a whole space and makes retries safe", async () => {
  await api(route("/records"), "POST", { content: "whole-space evidence" });
  const generation = (await api(route(""))).data.generation;
  expect(
    (await api(route("/forget"), "POST", { all: true, expected_generation: generation - 1 }))
      .status,
  ).toBe(409);
  const first = await api(
    route("/forget"),
    "POST",
    { all: true, expected_generation: generation },
    owner.token,
    "forget-all",
  );
  expect(first.status).toBe(200);
  expect(
    (
      await api(
        route("/forget"),
        "POST",
        { all: true, expected_generation: generation },
        owner.token,
        "forget-all",
      )
    ).data,
  ).toEqual(first.data);
  expect((await api(route("/search"), "POST", { query: "evidence" })).status).toBe(410);
});

it("rejects invalid batches without persisting partially created notes", async () => {
  expect(
    (await api(route("/records"), "POST", { content: "partial", source_ids: ["missing"] })).status,
  ).toBe(404);
  expect((await api(route("/search"), "POST", { query: "partial" })).data.results).toEqual([]);
  expect(
    (await api(route("/records"), "POST", { content: "invalid", importance: 99 })).status,
  ).toBe(400);
  expect((await api(route("/search"), "POST", { query: "x", allow_degraded: "true" })).status).toBe(
    400,
  );
});

it("queries typed assertions exactly and traverses cited relationships without invoking an embedding provider", async () => {
  let embeddingCalls = 0;
  service = new MemoryService(db, {
    id: "must-not-run",
    async embed() {
      embeddingCalls++;
      throw new Error("Symbolic retrieval must not depend on embeddings");
    },
  });
  const claim = async (subject: string, predicate: string, object: unknown) => {
    const r = await api(route("/records"), "POST", {
      content: `${subject} ${predicate}`,
      claim: { subject, predicate, object },
    });
    expect(r.status).toBe(201);
    return r.data.id as string;
  };
  const ab = await claim("project:A", "depends-on", { kind: "entity", id: "project:B" });
  const bc = await claim("project:B", "depends-on", { kind: "entity", id: "project:C" });
  const ca = await claim("project:C", "depends-on", { kind: "entity", id: "project:A" });
  for (const value of [1, "1", true, null]) {
    const id = await claim("project:A", "value", { kind: "literal", value });
    const result = await api(route("/query"), "POST", {
      subject: "project:A",
      predicate: "value",
      object: { value, kind: "literal" },
    });
    expect(result.status).toBe(200);
    expect(result.data.mode).toBe("symbolic");
    expect(result.data.results.map((r: { id: string }) => r.id)).toEqual([id]);
  }
  expect(
    (await api(route("/query"), "POST", { object: { kind: "literal", value: "project:B" } })).data
      .results,
  ).toEqual([]);
  const graph = await api(route("/graph"), "POST", {
    subject: "project:A",
    predicates: ["depends-on"],
    max_depth: 5,
  });
  expect(graph.status).toBe(200);
  expect(graph.data.edges.map((e: { path: string[] }) => e.path)).toEqual([
    [ab],
    [ab, bc],
    [ab, bc, ca],
  ]);
  expect(graph.data.truncated).toBe(false);
  const reverse = await api(route("/graph"), "POST", {
    subject: "project:C",
    direction: "in",
    predicates: ["depends-on"],
    max_depth: 1,
  });
  expect(reverse.data.edges.map((e: { record: { id: string } }) => e.record.id)).toEqual([bc]);
  expect(reverse.data.truncated).toBe(true);
  expect(
    (await api(route("/graph"), "POST", { subject: "project:A", limit: 1 })).data.edges,
  ).toHaveLength(1);
  expect(
    (await api(route("/graph"), "POST", { subject: "project:A", direction: ["out"] })).status,
  ).toBe(400);
  expect((await api(route("/query"), "POST", {}, other.token)).status).toBe(404);
  expect((await api(route("/graph"), "POST", { subject: "project:A" }, other.token)).status).toBe(
    404,
  );
  expect(embeddingCalls).toBe(0);
});

it("keeps symbolic versions, typed terms, query cursors and source forgetting consistent", async () => {
  const source = await api(route("/sources"), "POST", { content: "source evidence" });
  const write = await api(route("/records"), "POST", {
    content: "launch blocked",
    source_ids: [source.data.id],
    claim: {
      subject: "launch",
      predicate: "status",
      object: { kind: "literal", value: "blocked" },
    },
  });
  const id = write.data.id;
  expect(
    (
      await api(route("/records"), "POST", {
        content: "bad",
        subject: "other",
        claim: { subject: "launch", predicate: "status", object: { kind: "literal", value: 1 } },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await api(route(`/records/${id}`), "PATCH", {
        content: "bad rename",
        subject: "other",
        expected_version: 1,
      })
    ).status,
  ).toBe(400);
  await api(route(`/records/${id}`), "PATCH", {
    content: "launch ready",
    expected_version: 1,
    claim: { subject: "launch", predicate: "status", object: { kind: "literal", value: "ready" } },
  });
  expect((await api(route(`/records/${id}?version=1`))).data.claim.object.value).toBe("blocked");
  expect(
    (await api(route("/query"), "POST", { object: { kind: "literal", value: "blocked" } })).data
      .results,
  ).toEqual([]);
  const second = await api(route("/records"), "POST", { content: "extra", subject: "launch" });
  const page = await api(route("/query"), "POST", { subject: "launch", limit: 1 });
  const cursor = page.data.next_cursor;
  expect(typeof cursor).toBe("string");
  const next = await api(route("/query"), "POST", { subject: "launch", limit: 1, cursor });
  expect(next.data.next_cursor).toBeNull();
  expect(
    new Set([...page.data.results, ...next.data.results].map((r: { id: string }) => r.id)),
  ).toEqual(new Set([id, second.data.id]));
  expect((await api(route("/query"), "POST", { subject: "other", cursor })).status).toBe(400);
  await api(route(`/records/${id}`), "PATCH", {
    content: "no assertion now",
    expected_version: 2,
    claim: null,
  });
  expect((await api(route("/query"), "POST", { subject: "launch", cursor })).status).toBe(409);
  expect((await api(route("/query"), "POST", { predicate: "status" })).data.results).toEqual([]);
  await api(route(`/records/${id}`), "PATCH", {
    content: "restored",
    expected_version: 3,
    claim: { subject: "launch", predicate: "status", object: { kind: "literal", value: "ready" } },
  });
  expect(
    (await api(route("/export"))).data.records.find((r: { id: string }) => r.id === id).claim.object
      .value,
  ).toBe("ready");
  expect((await api(route("/forget"), "POST", { source_ids: [source.data.id] })).status).toBe(200);
  expect((await api(route("/query"), "POST", { predicate: "status" })).data.results).toEqual([]);
  expect((await api(route(`/records/${id}?version=1`))).status).toBe(404);
});

it("reports graph truncation only when a bound omits a reachable assertion", async () => {
  const add = async (subject: string, target: string) =>
    api(route("/records"), "POST", {
      content: `${subject} -> ${target}`,
      claim: { subject, predicate: "edge", object: { kind: "entity", id: target } },
    });
  const first = await add("a", "b");
  for (const direction of ["out", "both"]) {
    const complete = await api(route("/graph"), "POST", {
      subject: "a",
      direction,
      max_depth: 1,
      limit: 1,
    });
    expect(complete.data.edges[0].record.id).toBe(first.data.id);
    expect(complete.data.truncated).toBe(false);
  }
  await add("b", "c");
  expect((await api(route("/graph"), "POST", { subject: "a", max_depth: 1 })).data.truncated).toBe(
    true,
  );
  expect((await api(route("/graph"), "POST", { subject: "a", limit: 1 })).data.truncated).toBe(
    true,
  );
  const complete = await api(route("/graph"), "POST", {
    subject: "a",
    max_depth: 2,
    limit: 2,
    direction: "both",
  });
  expect(complete.data.edges).toHaveLength(2);
  expect(complete.data.truncated).toBe(false);
  expect((await api(route("/graph"), "POST", { subject: "a", predicates: [] })).data.edges).toEqual(
    [],
  );
  await add("self", "self");
  const self = await api(route("/graph"), "POST", { subject: "self", direction: "both", limit: 1 });
  expect(self.data.edges).toHaveLength(1);
  expect(self.data.truncated).toBe(false);
});

it("keeps search rank, record versions and generation on one snapshot during a concurrent correction", async () => {
  const receipt = await api(route("/records"), "POST", {
    content: "snapshotneedle original",
    metadata: { version: 1 },
    claim: { subject: "task", predicate: "state", object: { kind: "literal", value: "old" } },
  });
  const generation = (await api(route(""))).data.generation;
  const concurrent = new MarinaDB(join(directory, "test.db"));
  const lexical = service.repository.lexical;
  let corrected = false;
  service.repository.lexical = (...args) => {
    if (!corrected) {
      corrected = true;
      concurrent.memoryRepository().revise(
        concurrent.verifyMemoryCredential(owner.token)!,
        space,
        receipt.data.id,
        1,
        {
          content: "snapshotneedle corrected",
          metadata: { version: 2 },
          claim: {
            subject: "task",
            predicate: "state",
            object: { kind: "literal", value: "new" },
          },
        },
        "concurrent-correction",
      );
    }
    return lexical(...args);
  };
  try {
    const result = await api(route("/search"), "POST", { query: "snapshotneedle" });
    expect(result.status).toBe(200);
    expect(result.data.generation).toBe(generation);
    expect(result.data.results[0].version).toBe(1);
    expect(result.data.results[0].metadata).toEqual({ version: 1 });
    expect(result.data.results[0].claim.object.value).toBe("old");
    const next = await api(route("/search"), "POST", { query: "snapshotneedle" });
    expect(next.data.results[0].version).toBe(2);
    expect(next.data.results[0].claim.object.value).toBe("new");
    expect(next.data.generation).toBeGreaterThan(generation);
  } finally {
    service.repository.lexical = lexical;
    concurrent.close();
  }
});

it("recovers resident space initialization after a transient rate limit without changing identity", async () => {
  const name = "RetryResident";
  db.createUser({ id: crypto.randomUUID(), name });
  const credential = db.issueMemoryCredential(db.getUserByName(name)!.id);
  const world = worldMemoryService(db);
  // Freeze the budget clock so the initial bucket is exhausted deterministically.
  const now = Date.now();
  const time = spyOn(Date, "now").mockReturnValue(now);
  try {
    for (let i = 0; i < 100; i++) {
      const response = await handleMemoryServiceApi(
        new Request("http://memory.invalid/v1/memory/me", {
          headers: { Authorization: `Bearer ${credential.token}` },
        }),
        world,
      );
      expect(response.status).toBe(200);
    }
    await expect(
      residentMemoryOperation(db, name, { operation: "capabilities" }),
    ).rejects.toMatchObject({ status: 429 });
    time.mockReturnValue(now + 1100);
    const result = await residentMemoryOperation(db, name, { operation: "me" });
    expect(result.ok).toBe(true);
    expect((result.result as { principal_id: string }).principal_id).toBe(credential.principalId);
  } finally {
    time.mockRestore();
  }
});
