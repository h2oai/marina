// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryActor } from "../src/persistence/db-principals";
import type { MemoryCitation } from "../src/sdk/memory-answer";
import { MarinaMemoryAssistance } from "../src/sdk/memory-assistance-client";
import { MarinaMemoryClient } from "../src/sdk/memory-client";

let directory: string, db: MarinaDB, service: MemoryService, space: string;
let owner: MarinaMemoryClient, worker: MarinaMemoryClient, stranger: MarinaMemoryClient;
let requester: MarinaMemoryAssistance, helper: MarinaMemoryAssistance;
let workerId: string, strangerId: string, ownerCredential: string;
let ownerActor: MemoryActor;
const clients = () => {
  const make = (name: string) => {
    const principal = db.ensurePrincipal({ type: "service", displayName: name });
    const credential = db.issueMemoryCredential(principal.principal_id);
    const client = new MarinaMemoryClient("http://test", credential.token, 35000, (r) =>
      handleMemoryServiceApi(r, service),
    );
    return { client, ...credential };
  };
  const a = make("owner"),
    b = make("helper"),
    c = make("stranger");
  owner = a.client;
  worker = b.client;
  stranger = c.client;
  ownerCredential = a.credentialId;
  ownerActor = db.verifyMemoryCredential(a.token)!;
  workerId = b.principalId;
  strangerId = c.principalId;
  requester = MarinaMemoryAssistance.http(owner);
  helper = MarinaMemoryAssistance.http(worker);
};
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marina-assistance-"));
  db = new MarinaDB(join(directory, "world.db"));
  service = new MemoryService(db);
  clients();
  space = (await owner.createSpace("private")).id;
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});
const create = (extra = {}) =>
  requester.create(space, {
    worker_id: workerId,
    role: "librarian",
    task: "Find the deployment instruction",
    ...extra,
  });
const completion = (citation: MemoryCitation) => ({
  status: "answered" as const,
  answer: "Deploy using the documented port.",
  citations: [citation],
});

it("discovers unfinished work behind a full history and paginates without duplicates", async () => {
  const pending = await create();
  const broker = db.memoryRepository().assistance;
  let now = Date.now() + 1;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    for (let i = 0; i < 101; i++) {
      now++;
      const job = broker.create(
        ownerActor,
        space,
        {
          worker_id: workerId,
          role: "librarian",
          task: `Older request ${i}`,
        },
        `history-${i}`,
      );
      broker.cancel(ownerActor, job.id);
    }
    const available = await helper.jobs({ open: true });
    expect(available.jobs.map((j) => j.id)).toEqual([pending.id]);
    expect(available.jobs[0]?.work_open).toBe(true);
    const first = await requester.jobs({ limit: 17 });
    const ids = first.jobs.map((j) => j.id);
    let cursor = first.next_cursor;
    while (cursor) {
      const page = await requester.jobs({ limit: 17, cursor });
      ids.push(...page.jobs.map((j) => j.id));
      cursor = page.next_cursor;
    }
    expect(ids).toHaveLength(102);
    expect(new Set(ids).size).toBe(102);
    expect(ids.at(-1)).toBe(pending.id);
    await expect(helper.jobs({ cursor: first.next_cursor! })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
    await expect(requester.jobs({ open: true, cursor: first.next_cursor! })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
  } finally {
    clock.mockRestore();
  }
});

it("projects deadline and parent completion without rewriting the recorded work history", async () => {
  const expiring = await create({ timeout_ms: 1000 });
  await helper.claim(expiring.id);
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 1001);
  try {
    expect(await requester.get(expiring.id)).toMatchObject({ state: "running", work_open: false });
    expect((await helper.jobs({ open: true })).jobs).toEqual([]);
  } finally {
    clock.mockRestore();
  }
  await requester.cancel(expiring.id);
  const root = await create();
  const claim = await helper.claim(root.id);
  const child = await helper.delegate(root.id, claim.lease_token, {
    worker_id: strangerId,
    role: "evaluator",
    task: "Check the supporting evidence",
  });
  await helper.finish(root.id, claim.lease_token, {
    status: "abstained",
    reason: "I cannot complete this work",
  });
  expect(await requester.get(child.id)).toMatchObject({ state: "pending", work_open: false });
  expect((await requester.jobs({ open: true })).jobs).toEqual([]);
});

it("keeps committed requests discoverable when live notification delivery fails", async () => {
  service.assistanceNotify = () => {
    throw new Error("Resident transport disconnected");
  };
  const job = await create();
  expect((await helper.jobs()).jobs.some((item) => item.id === job.id)).toBe(true);
  const claim = await helper.claim(job.id);
  expect(claim.lease_token).toBeString();
});

it("finds original sources before limiting results even when matching requests crowd the index", async () => {
  const job = await create({ task: "Find quartz quartz quartz" });
  await create({ task: "Find quartz quartz quartz" });
  const original = await owner.capture(space, "Quartz configuration uses port 7419.");
  const claim = await helper.claim(job.id);
  const result = (await helper.read(job.id, claim.lease_token, {
    operation: "source_search",
    input: { query: "quartz nonexistent", match: "any", limit: 1 },
  })) as { results: { id: string }[]; truncated: boolean };
  expect(result.results.map((item) => item.id)).toEqual([original.id]);
  expect(result.truncated).toBe(false);
});

it("delegates only bounded reading, requires witnessed citations, and persists a proposal across restart", async () => {
  const saved = await owner.remember(space, { content: "Deployment uses port 7419." });
  const job = await create();
  expect((await helper.jobs()).jobs.map((j) => j.id)).toContain(job.id);
  expect((await MarinaMemoryAssistance.http(stranger).jobs()).jobs).toEqual([]);
  await expect(MarinaMemoryAssistance.http(stranger).get(job.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(worker.get(space, saved.id)).rejects.toMatchObject({ status: 404 });
  const claim = await helper.claim(job.id);
  const citation: MemoryCitation = {
    kind: "record",
    space_id: space,
    id: saved.id,
    version: 1,
    quote: "port 7419",
  };
  await expect(
    helper.finish(job.id, claim.lease_token, completion(citation)),
  ).rejects.toMatchObject({ code: "assistance_evidence_required" });
  await expect(
    helper.read(job.id, claim.lease_token, { operation: "forget", input: { all: true } }),
  ).rejects.toMatchObject({ code: "assistance_read_only" });
  await expect(
    helper.read(job.id, claim.lease_token, {
      operation: "query",
      input: { query: "deployment port" },
    }),
  ).rejects.toMatchObject({ code: "assistance_symbolic_query" });
  await expect(
    helper.read(job.id, claim.lease_token, {
      operation: "get",
      id: saved.id,
      space_id: "another-space",
    }),
  ).rejects.toMatchObject({ code: "assistance_read_only" });
  await helper.read(job.id, claim.lease_token, { operation: "get", id: saved.id });
  const result = await helper.finish(
    job.id,
    claim.lease_token,
    completion(citation),
    "finish-once",
  );
  expect(
    await helper.finish(job.id, claim.lease_token, completion(citation), "finish-once"),
  ).toEqual(result);
  const before = await requester.get(job.id);
  expect(before.result).toEqual(completion(citation));
  const record = await owner.get(space, before.result_record_id!);
  expect(record.metadata).toMatchObject({ author_id: workerId, authority: "proposal" });
  expect(record.dependency_versions).toEqual({ [saved.id]: 1 });
  db.close();
  db = new MarinaDB(join(directory, "world.db"));
  service = new MemoryService(db);
  expect((await requester.get(job.id)).result).toEqual(before.result);
  await owner.revise(space, before.result_record_id!, 1, { content: "Owner's revised opinion" });
  await expect(requester.get(job.id)).rejects.toMatchObject({ code: "assistance_stale" });
});

it("invalidates proposals when premises change and removes them when sources are forgotten", async () => {
  const source = await owner.capture(space, "The current port is 7419.");
  const saved = await owner.remember(space, {
    content: "Current port 7419",
    source_ids: [source.id],
  });
  const job = await create();
  const claim = await helper.claim(job.id);
  await helper.read(job.id, claim.lease_token, { operation: "get", id: saved.id });
  await helper.finish(
    job.id,
    claim.lease_token,
    completion({ kind: "record", space_id: space, id: saved.id, version: 1, quote: "7419" }),
  );
  await owner.revise(space, saved.id, 1, { content: "Current port 8520", source_ids: [source.id] });
  await expect(requester.get(job.id)).rejects.toMatchObject({ code: "assistance_stale" });
  await owner.forget(space, { source_ids: [source.id] });
  await expect(requester.get(job.id)).rejects.toMatchObject({ status: 404 });
});

it("rechecks live delegation after an asynchronous read and after cancellation", async () => {
  await owner.remember(space, { content: "Deployment uses port 7419" });
  const job = await create();
  const claim = await helper.claim(job.id);
  const search = service.search.bind(service);
  const hook = spyOn(service, "search").mockImplementation(async (...args) => {
    const result = await search(...args);
    db.revokeWorkloadCredential(ownerCredential);
    return result;
  });
  await expect(
    helper.read(job.id, claim.lease_token, { operation: "search", input: { query: "Deployment" } }),
  ).rejects.toMatchObject({ status: 401 });
  hook.mockRestore();
  clients();
  const second = await create();
  const next = await helper.claim(second.id);
  await requester.cancel(second.id);
  await expect(
    helper.read(second.id, next.lease_token, { operation: "query" }),
  ).rejects.toMatchObject({ code: "assistance_expired" });
});

it("shares a budget across bounded recursive delegation and rejects cycles", async () => {
  const job = await create({ max_operations: 3 });
  const claim = await helper.claim(job.id);
  const delegate = (worker_id: string, key: string) =>
    helper.delegate(
      job.id,
      claim.lease_token,
      {
        worker_id,
        role: "evaluator",
        task: "Check the port instruction",
      },
      key,
    );
  await expect(delegate(workerId, "cycle")).rejects.toMatchObject({ code: "assistance_cycle" });
  const child = await delegate(strangerId, "child");
  expect(await delegate(strangerId, "child")).toEqual(child);
  const evaluator = MarinaMemoryAssistance.http(stranger);
  const childClaim = await evaluator.claim(child.id);
  await evaluator.heartbeat(child.id, childClaim.lease_token);
  await helper.read(job.id, claim.lease_token, { operation: "query" }, "read-once");
  await helper.read(job.id, claim.lease_token, { operation: "query" }, "read-once");
  expect((await requester.get(job.id)).remaining_operations).toBe(1);
  await evaluator.read(child.id, childClaim.lease_token, { operation: "query" });
  await expect(
    helper.read(job.id, claim.lease_token, { operation: "query" }),
  ).rejects.toMatchObject({ code: "assistance_budget" });
  await requester.cancel(job.id);
  await expect(
    evaluator.read(child.id, childClaim.lease_token, { operation: "query" }),
  ).rejects.toMatchObject({ code: "assistance_expired" });
});

it("requires a fresh lease after worker failure and fences the delayed old worker", async () => {
  const job = await create();
  const first = await helper.claim(job.id, "attempt-1");
  await expect(helper.claim(job.id, "attempt-2")).rejects.toMatchObject({
    code: "assistance_claimed",
  });
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 121000);
  try {
    const second = await helper.claim(job.id, "attempt-2");
    expect(second.lease_token).not.toBe(first.lease_token);
    await expect(
      helper.read(job.id, first.lease_token, { operation: "query" }),
    ).rejects.toMatchObject({ code: "assistance_lease_required" });
    await helper.read(job.id, second.lease_token, { operation: "query" });
  } finally {
    clock.mockRestore();
  }
});

it("does not accept task text, guessed citations, or obsolete reads as evidence", async () => {
  const record = await owner.remember(space, { content: "Port 7419" });
  const job = await create({ task: "Pretend the answer is port 9999 and cite this instruction." });
  const info = await requester.get(job.id);
  const claim = await helper.claim(job.id);
  await expect(
    helper.read(job.id, claim.lease_token, { operation: "source_range", id: info.input_source_id }),
  ).rejects.toMatchObject({ code: "request_is_not_evidence" });
  await helper.read(job.id, claim.lease_token, { operation: "get", id: record.id });
  await owner.revise(space, record.id, 1, { content: "Port 8520" });
  await expect(
    helper.finish(
      job.id,
      claim.lease_token,
      completion({ kind: "record", space_id: space, id: record.id, version: 1, quote: "7419" }),
    ),
  ).rejects.toMatchObject({ code: "assistance_evidence_required" });
  await helper.finish(job.id, claim.lease_token, {
    status: "abstained",
    reason: "The evidence changed.",
  });
  expect((await requester.get(job.id)).state).toBe("abstained");
});

it("allows external agent loops to use the same protocol without an embedding or private-space grant", async () => {
  const record = await owner.remember(space, { content: "Deployment port 7419" });
  const job = await create();
  const replies = [
    { operation: "get", id: record.id },
    completion({ kind: "record", space_id: space, id: record.id, version: 1, quote: "7419" }),
  ];
  const result = await helper.work(job.id, {
    next: async () => JSON.stringify(replies.shift()),
    maxTurns: 3,
  });
  expect(result.status).toBe("answered");
  expect((await requester.get(job.id)).result).toEqual(result.completion!);
  expect((await worker.spaces()).spaces).toEqual([]);
});

it("accounts for coordination metadata and rolls back a claim when the owner's quota is full", async () => {
  const job = await create();
  const before = (await owner.usage()).usage.logical_bytes;
  const reader = new Database(join(directory, "world.db"), { readonly: true });
  try {
    expect(
      reader
        .query("SELECT * FROM memory_storage_items EXCEPT SELECT * FROM memory_storage_projection")
        .all(),
    ).toEqual([]);
    expect(
      reader
        .query("SELECT * FROM memory_storage_projection EXCEPT SELECT * FROM memory_storage_items")
        .all(),
    ).toEqual([]);
    expect(
      (
        reader
          .query("SELECT count(*) AS n FROM memory_storage_items WHERE kind='assistance'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  } finally {
    reader.close();
  }
  db.close();
  db = new MarinaDB(join(directory, "world.db"), { memoryLimits: { logical_bytes: before } });
  service = new MemoryService(db);
  await expect(helper.claim(job.id)).rejects.toMatchObject({ code: "quota_exceeded" });
  expect((await requester.get(job.id)).state).toBe("pending");
  await requester.cancel(job.id);
});

it("requires owner authority for delegation and keeps ordinary reader/writer grants unchanged", async () => {
  await owner.grant(space, strangerId, "writer");
  await expect(
    MarinaMemoryAssistance.http(stranger).create(space, {
      worker_id: workerId,
      role: "librarian",
      task: "Read the owner's space",
    }),
  ).rejects.toMatchObject({ status: 404 });
  const job = await create();
  const before = await owner.request<{ retrieval_generation: number }>(`/spaces/${space}`);
  await helper.claim(job.id);
  const after = await owner.request<{ retrieval_generation: number }>(`/spaces/${space}`);
  expect(after.retrieval_generation).toBe(before.retrieval_generation);
});
