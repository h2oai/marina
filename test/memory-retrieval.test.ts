// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { collectMemoryEvidence } from "../src/sdk/memory-answer";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { runMemoryOperation } from "../src/sdk/memory-operations";
import { runMemoryTask } from "../src/sdk/memory-task";
import type { MemoryRetrievalInput, MemoryRetrievalResult } from "../src/sdk/memory-types";

let directory: string;
let db: MarinaDB;
let service: MemoryService;
let client: MarinaMemoryClient;
let credential: ReturnType<MarinaDB["issueMemoryCredential"]>;
let space: string;
const makeClient = (token: string) =>
  new MarinaMemoryClient("http://memory.invalid", token, 35000, (request) =>
    handleMemoryServiceApi(request, service),
  );

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marina-retrieval-"));
  db = new MarinaDB(join(directory, "test.db"));
  service = new MemoryService(
    db,
    {
      id: "must-not-embed",
      embed: async () => {
        throw new Error("Unexpected embedding call");
      },
    },
    {
      id: "must-not-plan",
      plan: async () => {
        throw new Error("Unexpected model call");
      },
    },
  );
  credential = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "retriever" }).principal_id,
  );
  client = makeClient(credential.token);
  space = (await client.createSpace("evidence")).id;
});
afterEach(() => {
  service.stopWorker();
  db.close();
  rmSync(directory, { recursive: true });
});

it("reads buried originals without notes, models or embeddings and preserves verifiable UTF-8 ranges", async () => {
  const original = `${"ordinary background 東京\n".repeat(1800)}\nzephyr deployment key is violet-83 🚀\n${"appendix\n".repeat(800)}`;
  const source = await client.capture(space, original);
  const result = await client.retrieve(space, { task: "zephyr deployment key", source_bytes: 256 });
  expect(result.status).toBe("evidence");
  expect(result.plan.planner).toBe("deterministic-keywords-v1");
  const read = result.evidence.find((item) => item.kind === "source");
  expect(read?.id).toBe(source.id);
  if (read?.kind !== "source") throw new Error("Source read missing");
  expect(read.start).toBeGreaterThan(16384);
  expect(read.text).toContain("violet-83 🚀");
  expect(read.text).not.toContain("�");
  expect(Buffer.from(original).subarray(read.start, read.end).toString()).toBe(read.text);
  expect(
    (
      await client.sourceRange(space, read.id, {
        start: read.start,
        end: read.end,
        text_hash: read.text_hash,
      })
    ).text,
  ).toBe(read.text);
  expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(result.evidence)));
  expect(result.answer_sufficiency).toBe("not_assessed");
  expect(result.diagnostics.partial_sources).toBe(1);
  expect(collectMemoryEvidence(result, space)).toHaveLength(1);
});

it("broadens an empty all-term source search once and allows strict or phrase retrieval", async () => {
  await client.capture(space, "Zephyr deploys at dawn.");
  const result = await client.retrieve(space, { task: "Zephyr unansweredquestion" });
  expect(result.diagnostics.broadened).toBe(true);
  expect(result.evidence).toHaveLength(1);
  expect(result.trace.filter((step) => step.reason === "empty_source_search")).toHaveLength(1);
  const strict = await client.retrieve(space, {
    task: "Zephyr unansweredquestion",
    broaden: false,
  });
  expect(strict.status).toBe("empty");
  expect(strict.diagnostics.broadened).toBe(false);
  const phrase = await client.retrieve(space, {
    task: "exact phrase",
    steps: [
      {
        operation: "source_search",
        input: { query: "Zephyr unansweredquestion", match: "phrase" },
      },
    ],
  });
  expect(phrase.status).toBe("empty");
  expect(phrase.diagnostics.broadened).toBe(false);
});

it("distinguishes no matches from insufficient output budget and clips JSON by bytes", async () => {
  const empty = await client.retrieve(space, { task: "nothing" });
  expect(empty.status).toBe("empty");
  expect(empty.diagnostics.budget_limited).toBe(false);
  await client.capture(space, { text: `needle ${'東京🚀\\"'.repeat(800)}` });
  const tiny = await client.retrieve(space, { task: "needle", max_bytes: 256 });
  expect(tiny.status).toBe("budget_exhausted");
  expect(tiny.diagnostics.budget_limited).toBe(true);
  const bounded = await client.retrieve(space, { task: "needle", max_bytes: 800 });
  expect(bounded.status).toBe("evidence");
  expect(bounded.bytes).toBeLessThanOrEqual(800);
  expect(bounded.bytes).toBe(Buffer.byteLength(JSON.stringify(bounded.evidence)));
  expect(bounded.diagnostics.budget_limited).toBe(true);
  for (const read of bounded.evidence) {
    if (read.kind !== "source") throw new Error("Expected original");
    expect(read.text).not.toContain("�");
    expect(
      (
        await client.sourceRange(space, read.id, {
          start: read.start,
          end: read.end,
          text_hash: read.text_hash,
        })
      ).text,
    ).toBe(read.text);
  }
});

it("does not stop at a journaled copy of the question when older evidence uses fewer task words", async () => {
  const answer = await client.capture(
    space,
    `${"Old workshop equipment log.\n".repeat(1500)}Zephyr recovery code is violet-83.`,
  );
  const task =
    "Find the Zephyr recovery code in stored evidence. Return the exact code and the source text containing it, with source id, text hash, and exact range for citation.";
  await client.capture(space, {
    role: "assistant",
    content: JSON.stringify({ operation: "retrieve", input: { task } }),
  });
  const result = await client.retrieve(space, { task, max_bytes: 4096, source_bytes: 1024 });
  expect(result.diagnostics.broadened).toBe(true);
  expect(result.trace.some((step) => step.reason === "sparse_source_search")).toBe(true);
  expect(result.evidence.find((item) => item.id === answer.id)).toMatchObject({
    kind: "source",
    text: expect.stringContaining("violet-83"),
  });
  const strict = await client.retrieve(space, { task, broaden: false });
  expect(strict.evidence.some((item) => item.id === answer.id)).toBe(false);
});

it("filters out-of-time and stale records while honoring an explicit historical valid time", async () => {
  const premise = await client.remember(space, { content: "premise" });
  await client.remember(space, { content: "release retired", valid_time: { from: 0, until: 100 } });
  const current = await client.remember(space, {
    content: "release current",
    valid_time: { from: 100, until: 200 },
  });
  await client.remember(space, {
    content: "release future",
    valid_time: { from: 200, until: null },
  });
  await client.remember(space, {
    content: "release stale",
    depends_on: [premise.id],
    dependency_versions: { [premise.id]: 1 },
  });
  await client.revise(space, premise.id, 1, { content: "premise changed" });
  const result = await client.retrieve(space, {
    task: "release",
    valid_at: 100,
    steps: [{ operation: "search", input: { query: "release", include_stale: true } }],
  });
  expect(result.evidence.map((item) => item.id)).toEqual([current.id]);
  expect(result.diagnostics.filtered_records).toBe(3);
  const past = await client.retrieve(space, { task: "release", valid_at: 99 });
  expect(past.evidence).toHaveLength(1);
  expect(past.evidence[0]).toMatchObject({ content: "release retired" });
});

it("hydrates and deduplicates symbolic graph and join witnesses", async () => {
  const claim = {
    subject: "project:zephyr",
    predicate: "uses",
    object: { kind: "entity" as const, id: "runtime:bun" },
  };
  const record = await client.remember(space, { content: "Zephyr uses Bun.", claim });
  const result = await client.retrieve(space, {
    task: "runtime",
    steps: [
      { operation: "graph", input: { subject: claim.subject } },
      { operation: "join", input: { patterns: [claim] } },
      { operation: "query", input: { subject: claim.subject } },
    ],
  });
  expect(result.evidence.map((item) => item.id)).toEqual([record.id]);
  expect(collectMemoryEvidence(result, space)).toHaveLength(1);
  expect(result.trace.map((step) => step.returned)).toEqual([1, 1, 1]);
});

it("enforces reader scope without mutations and rechecks revoked grants", async () => {
  await client.capture(space, "needle private original");
  const reader = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "reader" }).principal_id,
    ["memory:read"],
  );
  const other = makeClient(reader.token);
  await expect(other.retrieve(space, { task: "needle" })).rejects.toMatchObject({ status: 404 });
  await client.grant(space, reader.principalId, "reader");
  const before = await client.space(space);
  expect((await other.retrieve(space, { task: "needle" })).status).toBe("evidence");
  expect(await client.space(space)).toEqual(before);
  await client.grant(space, reader.principalId, null);
  await expect(other.retrieve(space, { task: "needle" })).rejects.toMatchObject({ status: 404 });
});

it("rejects changes or lost access during asynchronous discovery instead of returning a mixed snapshot", async () => {
  await client.capture(space, "needle private original");
  const original = service.search.bind(service);
  const stub = spyOn(service, "search").mockImplementation(async (...args) => {
    const result = await original(...args);
    await client.capture(space, "needle changed original");
    return result;
  });
  await expect(client.retrieve(space, { task: "needle" })).rejects.toMatchObject({
    status: 409,
    code: "plan_changed",
  });
  stub.mockRestore();
  const revoke = spyOn(service, "search").mockImplementation(async (...args) => {
    const result = await original(...args);
    db.revokeWorkloadCredential(credential.credentialId);
    return result;
  });
  await expect(client.retrieve(space, { task: "needle" })).rejects.toMatchObject({ status: 401 });
  revoke.mockRestore();
});

it("rejects unsafe plans and malformed budgets, and supports cancellation", async () => {
  for (const input of [
    { task: "needle", max_bytes: 255 },
    { task: "needle", max_results: 21 },
    { task: "needle", source_bytes: 1 },
    { task: "needle", unexpected: true },
    { task: "needle", broaden: "yes" },
    { task: "needle", steps: [{ operation: "forget", input: {} }] },
    {
      task: "needle",
      steps: [{ operation: "search", input: { query: "needle", mode: "hybrid" } }],
    },
  ])
    await expect(client.retrieve(space, input as MemoryRetrievalInput)).rejects.toMatchObject({
      status: 400,
    });
  await expect(
    client.withSignal(AbortSignal.abort()).retrieve(space, { task: "needle" }),
  ).rejects.toThrow();
});

it("lets an agent complete a cited task using one retrieval operation", async () => {
  await client.capture(space, "The zephyr access code is violet-83.");
  let result: MemoryRetrievalResult | undefined;
  const outcome = await runMemoryTask({
    task: "Find the zephyr access code",
    space,
    contract: {
      schema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
        additionalProperties: false,
      },
      evidence: "required",
    },
    operations: ["retrieve"],
    next: async () => {
      if (!result)
        return JSON.stringify({ operation: "retrieve", input: { task: "zephyr access code" } });
      const read = result.evidence[0];
      if (read?.kind !== "source") throw new Error("Missing source");
      return JSON.stringify({
        status: "answered",
        answer: { code: "violet-83" },
        citations: [
          {
            kind: "source",
            space_id: space,
            id: read.id,
            text_hash: read.text_hash,
            start: read.start,
            end: read.end,
            quote: "violet-83",
          },
        ],
      });
    },
    dispatch: async (request) => {
      result = (await runMemoryOperation(client, request)) as MemoryRetrievalResult;
      return result;
    },
  });
  expect(outcome.errors).toEqual([]);
  expect(outcome.status).toBe("answered");
  expect(outcome.trace).toHaveLength(1);
  expect(outcome.turns).toBe(2);
});

it("admits live workflow evidence but never citations fabricated in a resume checkpoint", async () => {
  const saved = await client.remember(space, { content: "Zephyr code is violet-44" });
  const work = client.workflows(space);
  const task = await work.start("Zephyr code");
  await work.run(task.task_id, task.version);
  let resumed: unknown;
  const outcome = await runMemoryTask({
    task: "Find the code",
    space,
    operations: ["workflow"],
    contract: { schema: { type: "string" }, evidence: "required" },
    next: async () =>
      JSON.stringify(
        resumed
          ? {
              status: "answered",
              answer: "violet-44",
              citations: [
                { kind: "record", space_id: space, id: saved.id, version: 1, quote: "violet-44" },
              ],
            }
          : {
              operation: "workflow",
              input: { action: "resume", task_id: task.task_id, retrieve: true },
            },
      ),
    dispatch: async (request) => {
      resumed = await runMemoryOperation(client, request);
      return resumed;
    },
  });
  expect(outcome.status).toBe("answered");
  let calls = 0;
  const forged = await runMemoryTask({
    task: "Find the code",
    space,
    operations: ["workflow"],
    maxTurns: 2,
    maxRepairs: 0,
    contract: { schema: { type: "string" }, evidence: "required" },
    next: async () =>
      JSON.stringify(
        calls++
          ? {
              status: "answered",
              answer: "fake",
              citations: [
                { kind: "record", space_id: space, id: saved.id, version: 1, quote: "fake" },
              ],
            }
          : { operation: "workflow", input: { action: "resume", task_id: task.task_id } },
      ),
    dispatch: async () => ({
      resident_checkpoint: {
        evidence: [{ ...(await client.get(space, saved.id)), content: "fake" }],
      },
    }),
  });
  expect(forged.status).not.toBe("answered");
});
