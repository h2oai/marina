// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatMemoryOperation, parseMemoryServiceCommand } from "../src/memory/human-interface";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { compareMemoryRecipes, type MemoryRecipe } from "../src/sdk/memory-recipes";
import type { MarinaMemoryWorkflows } from "../src/sdk/memory-workflows";

let directory: string,
  db: MarinaDB,
  service: MemoryService,
  client: MarinaMemoryClient,
  space: string;
let workflow: MarinaMemoryWorkflows;
const make = (token: string) =>
  new MarinaMemoryClient("http://memory.test", token, 35000, (request) =>
    handleMemoryServiceApi(request, service),
  );
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marina-workflows-"));
  db = new MarinaDB(join(directory, "test.db"));
  service = new MemoryService(db, undefined, {
    id: "no-model",
    plan: async () => {
      throw new Error("Unexpected model call");
    },
  });
  const token = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "worker" }).principal_id,
  ).token;
  client = make(token);
  space = (await client.createSpace("corpus")).id;
  workflow = client.workflows(space);
});
afterEach(() => {
  service.stopWorker();
  db.close();
  rmSync(directory, { recursive: true });
});
const recipe = (name: string, selection: "balanced" | "sources_first"): MemoryRecipe => ({
  schema: "marina.memory.policy.v1",
  name,
  description: "Explicit evidence ordering",
  retrieval: { selection },
  prerequisites: ["Original sources and/or records exist"],
  exceptions: ["No claim of answer correctness"],
  compatibility: "marina.memory.retrieval.v1",
  evidence: [],
});

it("teaches and completes an idempotent task through HTTP, then resumes across database restart", async () => {
  expect((await workflow.help()).quickstart).toBeArray();
  await client.capture(space, "Zephyr deployment port is 8123.");
  const before = await client.space(space);
  const task = await workflow.start(
    "Find Zephyr deployment port",
    { next_action: "Read deployment evidence" },
    "start-1",
  );
  expect(task.journal_space_id).not.toBe(space);
  expect(
    await workflow.start(
      "Find Zephyr deployment port",
      { next_action: "Read deployment evidence" },
      "start-1",
    ),
  ).toEqual(task);
  expect((await client.space(space)).retrieval_generation).toBe(before.retrieval_generation);
  const result = await workflow.run(task.task_id, task.version, {}, "run-1");
  expect(result.status).toBe("ready");
  expect(JSON.stringify(result.retrieval.evidence)).toContain("8123");
  expect((await workflow.run(task.task_id, task.version, {}, "run-1")).version).toBe(
    result.version,
  );
  const exported = await workflow.exportEpisode(task.task_id);
  expect(exported.result.evidence).toEqual(result.retrieval.evidence);
  const feedback = await workflow.feedback(
    {
      task_id: task.task_id,
      rubric: "Port matches documented source",
      result: "pass",
      explanation: "Read 8123",
      metrics: { model_calls: 0, cost_usd: 0 },
    },
    "feedback",
  );
  const outcome = JSON.parse((await client.get(task.journal_space_id, feedback.id)).content);
  expect(outcome.metrics_attribution).toBe("caller_reported");
  expect(outcome.evaluator).toBeString();
  const completed = await workflow.finish(
    task.task_id,
    result.version,
    "completed",
    "Configure the documented port",
    "finish",
  );
  expect(
    await workflow.finish(
      task.task_id,
      result.version,
      "completed",
      "Configure the documented port",
      "finish",
    ),
  ).toEqual(completed);
  db.close();
  db = new MarinaDB(join(directory, "test.db"));
  service = new MemoryService(db);
  const resumed = await workflow.resume(task.task_id);
  expect(resumed.status).toBe("completed");
  expect(resumed.episode.next_action).toBe("Configure the documented port");
  expect(resumed.premises[0]?.state).toBe("current");
  expect((await workflow.tasks()).tasks.map((entry) => entry.task_id)).toEqual([task.task_id]);
});

it("keeps interrupted intent and flags corrections and forgotten sources on resume/export", async () => {
  const source = await client.capture(space, "Zephyr port is 8123");
  const record = await client.remember(space, { content: "Zephyr port is 8123" });
  const task = await workflow.start("Zephyr port", {}, "task");
  const result = await workflow.run(task.task_id, task.version, {}, "run");
  await client.revise(space, record.id, 1, { content: "Zephyr port is 9001" });
  expect(
    (await workflow.resume(task.task_id)).premises.find((pin) => pin.reference.id === record.id)
      ?.state,
  ).toBe("changed");
  await client.forget(space, { source_ids: [source.id] });
  expect(
    (await workflow.resume(task.task_id)).premises.find((pin) => pin.reference.id === source.id)
      ?.state,
  ).toBe("unavailable");
  await expect(workflow.exportEpisode(task.task_id)).rejects.toMatchObject({ status: 404 });
  await expect(
    workflow.finish(task.task_id, task.version, "completed", "Done"),
  ).rejects.toMatchObject({ code: "version_conflict" });
  expect(
    (await workflow.finish(task.task_id, result.version, "interrupted", "Check corrected port"))
      .status,
  ).toBe("interrupted");
});

it("preserves failed attempt intent and accepts a new explicit retry", async () => {
  await client.capture(space, "Zephyr deployment instruction");
  const task = await workflow.start("Zephyr deployment");
  const search = spyOn(service, "search").mockImplementation(async () => {
    throw new Error("Provider disconnected");
  });
  await expect(workflow.run(task.task_id, task.version, {}, "failed-run")).rejects.toBeDefined();
  search.mockRestore();
  const resumed = await workflow.resume(task.task_id);
  expect(resumed.status).toBe("failed");
  expect(resumed.episode.input?.task).toBe("Zephyr deployment");
  expect(resumed.episode.error?.code).toBe("retrieval_failed");
  expect((await workflow.run(task.task_id, resumed.version, {}, "retry")).status).toBe("ready");
});

it("allows scoped readers to keep their own journal but never mutate the corpus or bypass revocation", async () => {
  const principal = db.ensurePrincipal({ type: "service", displayName: "reader" }).principal_id;
  const reader = make(db.issueMemoryCredential(principal).token);
  await client.grant(space, principal, "reader");
  await client.capture(space, "Shared documented procedure");
  const tasks = reader.workflows(space);
  const task = await tasks.start("Shared procedure");
  expect((await reader.space(task.journal_space_id)).owner_id).toBe(principal);
  await expect(reader.remember(space, { content: "Forbidden" })).rejects.toMatchObject({
    status: 404,
  });
  await tasks.run(task.task_id, task.version);
  await client.grant(space, principal, null);
  await expect(tasks.resume(task.task_id)).rejects.toMatchObject({ status: 404 });
  await expect(tasks.exportEpisode(task.task_id)).rejects.toMatchObject({ status: 404 });
});

it("compares only observed selection choices offline and supports explicit portable recipe transfer", async () => {
  await client.capture(space, "Zephyr deployment instructions");
  await client.remember(space, { content: "Zephyr deployment decision" });
  const task = await workflow.start("Zephyr deployment");
  await workflow.run(task.task_id, task.version, { valid_at: 1000 });
  const observation = await workflow.exportEpisode(task.task_id);
  const compare = compareMemoryRecipes(observation, [
    recipe("balanced", "balanced"),
    {
      ...recipe("unobserved", "balanced"),
      retrieval: { steps: [{ operation: "source_search", input: { query: "unrecorded" } }] },
    },
  ]);
  expect(compare.candidates[0]?.status).toBe("observed_only");
  expect(compare.candidates[1]?.status).toBe("unsupported");
  const saved = await workflow.saveRecipe(recipe("balanced", "balanced"));
  const used = await workflow.useRecipe(saved.id, saved.version!, "Zephyr deployment");
  expect(used.evidence[0]?.kind).toBe("record");
  expect((await workflow.recipes()).results[0]?.id).toBe(saved.id);
  // A successor imports authored portable data and executes without the author process.
  const portable = JSON.parse((await client.get(space, saved.id)).content) as MemoryRecipe;
  const recipient = (await client.createSpace("recipient")).id;
  await client.capture(recipient, "Zephyr successor instructions");
  const accepted = await client.workflows(recipient).saveRecipe(portable);
  const successor = await client
    .workflows(recipient)
    .useRecipe(accepted.id, accepted.version!, "Zephyr successor");
  expect(JSON.stringify(successor.evidence)).toContain("successor instructions");
});

it("provides resumable filtered notifications, explicit acknowledgements, temporal boundaries and cancellation", async () => {
  const now = Date.now();
  const premise = await client.remember(space, {
    content: "Temporary rule",
    valid_time: { from: null, until: now + 10000 },
  });
  await workflow.watch("deployment", [premise.id]);
  expect((await workflow.poll("deployment")).changes.events).toHaveLength(0);
  await client.remember(space, { content: "Unrelated" });
  await client.revise(space, premise.id, 1, { content: "Corrected rule" });
  const first = await workflow.poll("deployment", 1);
  expect(first.changes.events).toHaveLength(1);
  expect(first.changes.events[0]?.reference_id).toBe(premise.id);
  expect((await workflow.poll("deployment", 1)).changes).toEqual(first.changes);
  const acknowledged = await workflow.ack("deployment", first.version, first.changes.cursor);
  expect((await workflow.poll("deployment")).changes.events).toHaveLength(0);
  const clock = spyOn(Date, "now").mockReturnValue(now + 10001);
  try {
    expect((await workflow.poll("deployment")).temporal_due).toBe(true);
  } finally {
    clock.mockRestore();
  }
  await workflow.unwatch("deployment", acknowledged.version!);
  await expect(workflow.poll("deployment")).rejects.toMatchObject({ code: "watch_inactive" });
});

it("makes commands discoverable and returns actionable human output", async () => {
  expect(parseMemoryServiceCommand("guide")?.input).toEqual({ action: "help" });
  const task = await workflow.start("Continue deployment");
  const rendered = formatMemoryOperation({ ok: true, result: task });
  expect(rendered).toContain(`memory run ${task.task_id} ${task.version}`);
  expect(
    parseMemoryServiceCommand(`run ${task.task_id} ${task.version}`)?.input?.expected_version,
  ).toBe(task.version);
  expect(
    parseMemoryServiceCommand("finish task-1 3 completed Check the deployment")?.input?.next_action,
  ).toBe("Check the deployment");
});

it("imports an exported episode as attributed observations and requires explicit rerun", async () => {
  await client.capture(space, "Zephyr deployment code is violet-77");
  await client.remember(space, { content: "Zephyr deployment uses Bun" });
  const first = await workflow.start("Zephyr deployment");
  await workflow.run(first.task_id, first.version);
  const portable = await workflow.exportEpisode(first.task_id);
  const target = (await client.createSpace("import-target")).id;
  const recipient = client.workflows(target);
  const imported = await recipient.importEpisode(portable, {}, "import-1");
  expect(await recipient.importEpisode(portable, {}, "import-1")).toEqual(imported);
  expect(imported.status).toBe("interrupted");
  expect(
    (await recipient.resume(imported.task_id)).premises.every((pin) => pin.state === "current"),
  ).toBe(true);
  await expect(recipient.exportEpisode(imported.task_id)).rejects.toMatchObject({
    code: "episode_incomplete",
  });
  const reread = await recipient.run(imported.task_id, imported.version);
  expect(JSON.stringify(reread.retrieval.evidence)).toContain("violet-77");
});

it("never skips a temporal change between polling and acknowledgement", async () => {
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const premise = await client.remember(space, {
      content: "Expires soon",
      valid_time: { from: null, until: now + 100 },
    });
    await workflow.watch("expiry", [premise.id]);
    const first = await workflow.poll("expiry");
    clock.mockReturnValue(now + 101);
    await workflow.ack("expiry", first.acknowledgement);
    const later = await workflow.poll("expiry");
    expect(later.temporal_due).toBe(true);
    await workflow.ack("expiry", later.acknowledgement);
    expect((await workflow.poll("expiry")).temporal_due).toBe(false);
  } finally {
    clock.mockRestore();
  }
});

it("teaches recovery from unknown IDs and refuses unsupported workflow fields", async () => {
  await workflow.start("Keep a discoverable task", { task_id: "exact-id" });
  await expect(workflow.resume("wrong-id")).rejects.toMatchObject({
    code: "task_not_found",
    message: expect.stringContaining('"action":"tasks"'),
  });
  await expect(
    client.request(`/spaces/${space}/workflow`, "POST", {
      action: "resume",
      task_id: "exact-id",
      complete: true,
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  const listed = (await workflow.tasks()).tasks[0]!;
  expect(listed.next_calls?.[0]?.input?.task_id).toBe("exact-id");
});

it("captures the explicitly selected recipe version in a task episode", async () => {
  await client.capture(space, "Zephyr deployment instructions");
  const selected = await workflow.saveRecipe(recipe("explicit", "balanced"));
  const task = await workflow.start("Zephyr deployment");
  const result = await workflow.runRecipe(
    task.task_id,
    task.version,
    selected.id,
    selected.version!,
  );
  expect(result.retrieval.selected_recipe).toEqual({
    space_id: space,
    id: selected.id,
    version: selected.version!,
  });
  expect((await workflow.resume(task.task_id)).episode.recipe?.id).toBe(selected.id);
});

it("preserves running intent on cancellation and resumes the same idempotent attempt", async () => {
  await client.capture(space, "Zephyr deployment evidence");
  const task = await workflow.start("Zephyr deployment");
  const abort = new AbortController();
  const original = service.search.bind(service);
  const read = spyOn(service, "search").mockImplementation(async (...args) => {
    const value = await original(...args);
    abort.abort();
    return value;
  });
  try {
    await expect(
      client
        .withSignal(abort.signal)
        .workflows(space)
        .run(task.task_id, task.version, {}, "interrupted-read"),
    ).rejects.toThrow();
  } finally {
    read.mockRestore();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await workflow.resume(task.task_id)).status).toBe("running");
  expect((await workflow.run(task.task_id, task.version, {}, "interrupted-read")).status).toBe(
    "ready",
  );
});

it("does not turn read-only credentials into journal writers and rechecks watch access", async () => {
  const principal = db.ensurePrincipal({ type: "service", displayName: "observer" }).principal_id;
  const reader = make(db.issueMemoryCredential(principal, ["memory:read"]).token);
  const writer = make(db.issueMemoryCredential(principal).token);
  await client.grant(space, principal, "reader");
  await client.capture(space, "Zephyr instructions");
  expect((await reader.retrieve(space, { task: "Zephyr" })).status).toBe("evidence");
  await expect(reader.workflows(space).start("Zephyr task")).rejects.toBeDefined();
  await writer.workflows(space).watch("private-events");
  await client.grant(space, principal, null);
  await expect(writer.workflows(space).poll("private-events")).rejects.toMatchObject({
    status: 404,
  });
});

it("cannot activate model planning through a recipe authored outside save_recipe", async () => {
  const unsafe = { ...recipe("authored externally", "balanced"), retrieval: { use_model: true } };
  const stored = await client.remember(space, { content: JSON.stringify(unsafe), type: "skill" });
  const task = await workflow.start("Zephyr");
  await expect(
    workflow.runRecipe(task.task_id, task.version, stored.id, stored.version!),
  ).rejects.toMatchObject({ code: "invalid_recipe" });
  expect((await workflow.resume(task.task_id)).status).toBe("open");
});

it("resumes a corrected record despite dense resident journal echoes", async () => {
  const record = await client.remember(space, { content: "Zephyr recovery code is old" });
  const task = await workflow.start("Zephyr recovery code");
  await workflow.run(task.task_id, task.version, { selection: "balanced" });
  await client.revise(space, record.id, record.version!, {
    content: "Zephyr recovery code is corrected",
  });
  for (let i = 0; i < 12; i++)
    await client.capture(space, {
      role: "user",
      content: `Zephyr recovery code question ${i}; previously old`,
    });
  const resumed = await workflow.resume(task.task_id, true);
  expect(resumed.premises[0]?.current_version).toBe(2);
  expect(resumed.premises[0]?.read_current).toEqual({ operation: "get", id: record.id });
  expect(resumed.episode).not.toHaveProperty("observation");
  expect(resumed.retrieval?.evidence[0]).toMatchObject({
    kind: "record",
    id: record.id,
    version: 2,
  });
  const tiny = await client.retrieve(space, {
    task: "Zephyr recovery code",
    selection: "balanced",
    max_results: 1,
  });
  expect(tiny.evidence[0]).toMatchObject({ kind: "record", id: record.id, version: 2 });
});

it("shares a journal explicitly for a different principal's handoff and attributed evaluation", async () => {
  await client.capture(space, "Zephyr handoff evidence");
  const task = await workflow.start("Zephyr handoff");
  const otherId = db.ensurePrincipal({ type: "service", displayName: "successor" }).principal_id;
  const successor = make(db.issueMemoryCredential(otherId).token);
  await client.grant(space, otherId, "reader");
  const shared = successor.workflows(space, task.journal_space_id);
  await expect(shared.resume(task.task_id)).rejects.toMatchObject({ status: 404 });
  await client.grant(task.journal_space_id, otherId, "writer");
  expect((await shared.resume(task.task_id)).task_id).toBe(task.task_id);
  const ran = await shared.run(task.task_id, task.version);
  expect((await shared.exportEpisode(task.task_id)).attribution).toBe(otherId);
  const assessed = await shared.feedback({
    task_id: task.task_id,
    rubric: "Contains handoff evidence",
    result: "helpful",
    explanation: "Read the original",
  });
  expect(JSON.parse((await client.get(task.journal_space_id, assessed.id)).content).evaluator).toBe(
    otherId,
  );
  expect(
    (await shared.finish(task.task_id, ran.version, "completed", "Evidence checked")).status,
  ).toBe("completed");
  await client.grant(task.journal_space_id, otherId, null);
  await expect(shared.resume(task.task_id)).rejects.toMatchObject({ status: 404 });
});

it("does not replay omitted recipe parameters as if they inherited observed discovery settings", async () => {
  await client.capture(space, "Zephyr deployment procedure");
  const task = await workflow.start("Zephyr deployment");
  await workflow.run(task.task_id, task.version, { source_bytes: 512 });
  const observation = await workflow.exportEpisode(task.task_id);
  const wrong = recipe("uses default source bytes", "balanced");
  const matched = {
    ...wrong,
    name: "matches the read envelope",
    retrieval: { selection: "balanced" as const, source_bytes: 512 },
  };
  const comparison = compareMemoryRecipes(observation, [wrong, matched]);
  expect(comparison.candidates.map((row) => row.status)).toEqual(["unsupported", "observed_only"]);
});

it("enforces export scope separately from ordinary task reads", async () => {
  await client.capture(space, "Zephyr evidence");
  const task = await workflow.start("Zephyr evidence");
  await workflow.run(task.task_id, task.version);
  const principal = (await client.space(space)).owner_id;
  const readOnly = make(db.issueMemoryCredential(principal, ["memory:read"]).token).workflows(
    space,
  );
  expect((await readOnly.resume(task.task_id)).status).toBe("ready");
  await expect(readOnly.exportEpisode(task.task_id)).rejects.toMatchObject({ status: 403 });
});

it("notifies source-specific watches when forgetting removes their source", async () => {
  const source = await client.capture(space, "Zephyr source-only premise");
  await workflow.watch("source-premise", [source.id]);
  await client.forget(space, { source_ids: [source.id] });
  const changed = await workflow.poll("source-premise");
  expect(changed.changes.events.some((event) => event.operation === "forget.completed")).toBe(true);
  expect(JSON.stringify(changed.changes.events)).not.toContain("source-only premise");
});

it("lists recognizable task goals and teaches pagination without requiring JSON", async () => {
  const task = await workflow.start("Investigate the Zephyr health endpoint");
  const page = await workflow.tasks();
  expect(page.tasks[0]?.goal).toBe("Investigate the Zephyr health endpoint");
  const text = formatMemoryOperation({ ok: true, result: { ...page, next_cursor: "next-page" } });
  expect(text).toContain(task.task_id);
  expect(text).toContain("Investigate the Zephyr health endpoint");
  expect(text).toContain("memory tasks next-page");
  expect(parseMemoryServiceCommand("tasks next-page")?.input).toEqual({
    action: "tasks",
    cursor: "next-page",
  });
});
