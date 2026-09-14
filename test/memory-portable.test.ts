// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { ContextPersistenceError, createContextManager } from "../src/agent/context-manager";
import { DurableResidentMemory } from "../src/agent/durable-memory";
import { createMemoryPlan, executeMemoryPlan } from "../src/memory/planning";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { exportState, importState } from "../src/persistence/export-import";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";

let directory: string,
  db: MarinaDB,
  service: MemoryService,
  client: MarinaMemoryClient,
  space: string,
  actor: NonNullable<ReturnType<MarinaDB["verifyMemoryCredential"]>>;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marina-portable-"));
  db = new MarinaDB(join(directory, "memory.db"));
  service = new MemoryService(db);
  const credential = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "owner" }).principal_id,
  );
  actor = db.verifyMemoryCredential(credential.token)!;
  client = new MarinaMemoryClient("http://memory.test", credential.token, 35000, (request) =>
    handleMemoryServiceApi(request, service),
  );
  space = (await client.createSpace("portable")).id;
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});

it("searches raw sources and reconstructs immutable UTF-8 ranges, enforcing scope, hashes and deletion", async () => {
  const text = `rawneedle αβ🙂 ${"detail ".repeat(3000)}END`;
  const saved = await client.capture(space, text, "session-a");
  expect(
    (await client.sourceSearch(space, { query: "rawneedle", session_id: "session-a" })).results[0]
      ?.id,
  ).toBe(saved.id);
  expect(
    (await client.sourceSearch(space, { query: "rawneedle absent", match: "all" })).results,
  ).toHaveLength(0);
  expect(
    (await client.sourceSearch(space, { query: "rawneedle", session_id: "session-b" })).results,
  ).toHaveLength(0);
  let start = 0,
    reconstructed = "";
  for (;;) {
    const result = await client.sourceRange(space, saved.id, { start });
    reconstructed += result.text;
    expect(result.text_hash).toBe(createHash("sha256").update(text).digest("hex"));
    if (result.next_start === null) break;
    start = result.next_start;
  }
  expect(reconstructed).toBe(text);
  await expect(client.sourceRange(space, saved.id, { start: 11, end: 12 })).rejects.toMatchObject({
    code: "invalid_range",
  });
  await expect(client.sourceRange(space, saved.id, { text_hash: "wrong" })).rejects.toMatchObject({
    code: "source_changed",
  });
  const other = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "other" }).principal_id,
  );
  expect(() =>
    service.repository.sourceRange(db.verifyMemoryCredential(other.token)!, space, saved.id),
  ).toThrow("not found");
  await client.forget(space, { source_ids: [saved.id] });
  expect((await client.sourceSearch(space, { query: "rawneedle" })).results).toHaveLength(0);
  await expect(client.sourceRange(space, saved.id)).rejects.toMatchObject({ status: 404 });
});

it("rebuilds source projections on snapshot replacement and merge", async () => {
  const saved = await client.capture(space, "snapshotneedle full source");
  const snapshot = exportState(join(directory, "memory.db"));
  expect(snapshot.tables.memory_source_text).toBeUndefined();
  const targetPath = join(directory, "restored.db");
  new MarinaDB(targetPath).close();
  for (const merge of [false, false, true])
    expect(importState(targetPath, snapshot, { merge }).errors).toEqual([]);
  const restored = new MarinaDB(targetPath);
  try {
    const credential = restored.issueMemoryCredential(actor.principalId);
    const restoredActor = restored.verifyMemoryCredential(credential.token)!;
    const repo = restored.memoryRepository();
    expect(
      repo.sourceSearch(restoredActor, space, { query: "snapshotneedle" }).results[0]?.id,
    ).toBe(saved.id);
    expect(repo.sourceRange(restoredActor, space, saved.id).text).toBe(
      "snapshotneedle full source",
    );
  } finally {
    restored.close();
  }
});

it("enforces versioned vocabulary and nonoverlapping valid time without hiding historical revisions", async () => {
  await client.saveVocabulary(space, 0, {
    closed: true,
    predicates: { status: { object: "string", cardinality: "one" } },
  });
  const input = {
    content: "active",
    claim: {
      subject: "project:a",
      predicate: "status",
      object: { kind: "literal" as const, value: "active" },
    },
    valid_time: { from: 100, until: 200 },
    expected_vocabulary_version: 1,
  };
  const first = await client.remember(space, input);
  await expect(
    client.remember(space, {
      ...input,
      claim: { ...input.claim, object: { kind: "literal", value: 3 } },
    }),
  ).rejects.toMatchObject({ code: "claim_type_conflict" });
  await expect(
    client.remember(space, {
      ...input,
      claim: { ...input.claim, object: { kind: "literal", value: "paused" } },
    }),
  ).rejects.toMatchObject({ code: "claim_cardinality_conflict" });
  await client.remember(space, {
    ...input,
    content: "paused",
    valid_time: { from: 200, until: null },
    claim: { ...input.claim, object: { kind: "literal", value: "paused" } },
  });
  expect(
    (await client.query(space, { subject: "project:a", valid_at: 199 })).results.map(
      (r) => r.content,
    ),
  ).toEqual(["active"]);
  expect(
    (await client.query(space, { subject: "project:a", valid_at: 200 })).results.map(
      (r) => r.content,
    ),
  ).toEqual(["paused"]);
  await client.revise(space, first.id, 1, {
    content: "active, verified",
    valid_time: { from: 110, until: 200 },
  });
  expect((await client.get(space, first.id, 1)).valid_time).toEqual({ from: 100, until: 200 });
  expect((await client.query(space, { valid_at: 105 })).results).toHaveLength(0);
  await expect(
    client.remember(space, { ...input, expected_vocabulary_version: 0 }),
  ).rejects.toMatchObject({ code: "vocabulary_changed" });
  await expect(
    client.remember(space, { ...input, claim: { ...input.claim, predicate: "unknown" } }),
  ).rejects.toMatchObject({ code: "unknown_predicate" });
});

it("executes inspectable plans with budgets and rejects stale generations and mutation steps", async () => {
  await client.capture(space, "launch gate security approval");
  const plan = await client.plan(space, { task: "launch gate", max_results: 1, max_bytes: 256 });
  expect(plan.planner).toBe("deterministic-keywords-v1");
  const result = await client.executePlan(space, plan);
  expect(result.trace[0]?.operation).toBe("source_search");
  expect(result.bytes).toBeLessThanOrEqual(256);
  expect(result.answer_sufficiency).toBe("not_assessed");
  await expect(
    client.plan(space, { task: "mutate", steps: [{ operation: "forget", input: {} }] as never }),
  ).rejects.toMatchObject({ code: "invalid_plan" });
  await client.capture(space, "another source");
  await expect(client.executePlan(space, plan)).rejects.toMatchObject({ code: "plan_changed" });
});

it("rechecks permissions after model planning", async () => {
  const model = new MemoryService(db, undefined, {
    id: "test-planner",
    async plan() {
      db.revokeWorkloadCredential(actor.credentialId);
      return { steps: [{ operation: "source_search", input: { query: "needle" } }] };
    },
  });
  await expect(
    createMemoryPlan(model, actor, space, { task: "needle", use_model: true }),
  ).rejects.toMatchObject({ code: "invalid_credential" });
});

it("expands model text discovery across both stores but rejects unsupported semantics and mutations", async () => {
  await client.capture(space, "modelneedle original evidence");
  await client.remember(space, { content: "modelneedle assertion" });
  let steps: unknown = [{ operation: "search", input: { query: "modelneedle" } }];
  const model = new MemoryService(db, undefined, {
    id: "test-planner",
    async plan() {
      return { steps };
    },
  });
  const plan = await createMemoryPlan(model, actor, space, {
    task: "modelneedle",
    use_model: true,
  });
  expect(plan.steps.map((step) => step.operation)).toEqual(["search", "source_search"]);
  const result = await executeMemoryPlan(model, actor, space, plan);
  expect(result.trace.map((step) => step.evidence.length)).toEqual([1, 1]);
  const explicit = await createMemoryPlan(model, actor, space, { task: "modelneedle", steps });
  expect(explicit.steps).toHaveLength(1);
  for (const invalid of [
    [{ operation: "forget", input: {} }],
    [{ operation: "search", input: { query: "modelneedle", valid_at: 150 } }],
    [{ operation: "search", input: { query: "modelneedle", mode: ["lexical"] } }],
  ]) {
    steps = invalid;
    await expect(
      createMemoryPlan(model, actor, space, { task: "modelneedle", use_model: true }),
    ).rejects.toMatchObject({ code: "invalid_plan" });
  }
});

it("validates vocabulary with write-only credentials and refuses malformed types", async () => {
  const credential = db.issueMemoryCredential(actor.principalId, ["memory:write"]);
  const writer = db.verifyMemoryCredential(credential.token)!;
  service.repository.saveVocabulary(
    writer,
    space,
    0,
    {
      closed: true,
      predicates: { status: { object: "string", cardinality: "one" } },
    },
    "vocabulary-write-only",
  );
  await expect(
    client.saveVocabulary(space, 1, {
      closed: true,
      predicates: { status: { object: ["string"], cardinality: "one" } },
    } as never),
  ).rejects.toMatchObject({ code: "invalid_vocabulary" });
});

it("uploads only new resident segments and stops local re-archival after forgetting", async () => {
  db.createUser({ id: crypto.randomUUID(), name: "Resident" });
  let captures = 0;
  const durable = new DurableResidentMemory({
    memoryService: async (request) => {
      if (request.operation === "capture") captures++;
      if (request.operation === "capture_batch")
        captures += (request.input!.items as unknown[]).length;
      return residentMemoryOperation(db, "Resident", request);
    },
  });
  const messages = [{ role: "user", content: "first original" }];
  await durable.archive(messages, "first");
  expect(captures).toBe(4); // Three text parts plus the immutable manifest.
  const firstArchive = (await durable.checkpoint())!.data.archive as { manifest_source_id: string };
  await durable.archive([...messages, { role: "user", content: "second original" }], "second");
  expect(captures).toBe(6); // One new message and one new manifest.
  const archive = (await durable.checkpoint())!.data.archive as {
    source_ids: string[];
    manifest_source_id: string;
  };
  const manifestReply = await residentMemoryOperation(db, "Resident", {
    operation: "source_range",
    id: archive.manifest_source_id,
  });
  const manifest = JSON.parse((manifestReply.result as { text: string }).text);
  expect(manifest.previous_manifest_source_id).toBe(firstArchive.manifest_source_id);
  const previousReply = await residentMemoryOperation(db, "Resident", {
    operation: "source_range",
    id: manifest.previous_manifest_source_id,
  });
  const previousManifest = JSON.parse((previousReply.result as { text: string }).text);
  let original = "";
  for (const id of previousManifest.source_ids) {
    const reply = await residentMemoryOperation(db, "Resident", { operation: "source_range", id });
    original += (reply.result as { text: string }).text;
  }
  expect(original).toBe(JSON.stringify(messages));
  const forgotten = await residentMemoryOperation(db, "Resident", {
    operation: "forget",
    input: { source_ids: [archive.source_ids[1]!] },
  });
  expect(forgotten.ok).toBe(true);
  await expect(durable.archive(messages, "retry")).rejects.toMatchObject({
    code: "checkpoint_invalidated",
  });
  await expect(durable.save({ lastIntent: "retry" })).rejects.toMatchObject({
    code: "checkpoint_invalidated",
  });
  expect(captures).toBe(6);
  await expect(
    residentMemoryOperation(db, "Resident", {
      operation: "source_range",
      id: archive.source_ids[1]!,
    }),
  ).rejects.toMatchObject({ code: "source_not_found" });
});

it("rejects checkpoint references to sources forgotten before checkpoint commit", async () => {
  const source = await client.capture(space, "temporary original");
  await client.forget(space, { source_ids: [source.id] });
  await expect(
    client.saveCheckpoint(space, "race", 0, { source: source.id }, 0, "race", [source.id]),
  ).rejects.toMatchObject({ code: "source_not_found" });
  await expect(client.checkpoint(space, "race")).rejects.toMatchObject({
    code: "checkpoint_not_found",
  });
});

it("keeps default retrieval lexical even with an unavailable embedding provider", async () => {
  service = new MemoryService(db, {
    id: "broken",
    async embed() {
      throw new Error("offline");
    },
  });
  await client.remember(space, { content: "lexicalneedle" });
  expect((await client.search(space, { query: "lexicalneedle" })).mode).toBe("lexical");
  await expect(
    client.search(space, { query: "lexicalneedle", mode: "hybrid" }),
  ).rejects.toMatchObject({ code: "retrieval_incomplete" });
});

it("awaits resident archive acknowledgments before trimming and recovers original evidence through a fresh service", async () => {
  db.createUser({ id: crypto.randomUUID(), name: "Resident" });
  let fail = true;
  const transport = {
    memoryService: async (request: MemoryOperationRequest) => {
      if (fail && request.operation === "capture") throw new Error("storage unavailable");
      return residentMemoryOperation(db, "Resident", request);
    },
  };
  const durable = new DurableResidentMemory(transport);
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: "user",
    content: `${index}: ${"evidence α ".repeat(500)}end:${index}`,
    timestamp: index,
  })) as AgentMessage[];
  const original = JSON.stringify(messages);
  const transform = createContextManager({
    getModel: () => ({ contextWindow: 1500, maxTokens: 100 }) as Model<string>,
    getSystemPrompt: () => "",
    onBeforeCompact: (originals, summary) => durable.archive(originals, summary),
  });
  await expect(transform(messages)).rejects.toBeInstanceOf(ContextPersistenceError);
  expect(JSON.stringify(messages)).toBe(original);
  fail = false;
  expect((await transform(messages)).length).toBeLessThan(messages.length);
  db.close();
  db = new MarinaDB(join(directory, "memory.db"));
  const fresh = new DurableResidentMemory({
    memoryService: (request) => residentMemoryOperation(db, "Resident", request),
  });
  const checkpoint = await fresh.checkpoint();
  const archive = checkpoint!.data.archive as { source_ids: string[]; sha256: string };
  let text = "";
  for (const id of archive.source_ids) {
    const reply = await residentMemoryOperation(db, "Resident", { operation: "source_range", id });
    text += (reply.result as { text: string }).text;
  }
  expect(text).toBe(original);
  expect(createHash("sha256").update(text).digest("hex")).toBe(archive.sha256);
});
