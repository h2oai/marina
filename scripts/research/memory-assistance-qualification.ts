// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { MarinaClient } from "../../src/sdk/client";
import type { MemoryAssistanceJob, MemoryHelperRole } from "../../src/sdk/memory-assistance";
import { MarinaMemoryAssistance } from "../../src/sdk/memory-assistance-client";
import type { MemoryReceipt } from "../../src/sdk/memory-types";
import { createLiveMemoryRuntime } from "./memory-live-runtime";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { directory: { type: "string" }, "budget-usd": { type: "string" } },
});
if (!values.directory) throw new Error("Use --directory PRIVATE_PATH --budget-usd N");
const directory = resolve(values.directory);
mkdirSync(directory, { recursive: true, mode: 0o700 });
// Resident prompts include their world context and full tool history. Keep a
// separate input bound while reserving every byte against the same USD ceiling.
const runtime = createLiveMemoryRuntime(directory, Number(values["budget-usd"]), {
  inputLimit: 131072,
});
runtime.engine.agentRuntime.setWsPort(runtime.router.getPort());
const url = `ws://127.0.0.1:${runtime.router.getPort()}`;
process.env.WS_PORT = String(runtime.router.getPort());
const model = "marina/default";
const requester = new MarinaClient(url, { autoReconnect: false, pingInterval: 0 });
const assistance = new MarinaMemoryAssistance(async (request) => {
  const result = await requester.memoryService(request);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.result;
});
const agents: string[] = [];
const report: Record<string, unknown> = {
  schema: "marina.memory.assistance.qualification.v2",
  passed: false,
  model,
  jobs: [],
  limits: "Single bounded resident workflow; no significance or general superiority claim.",
};
const traces: { name: string; event: unknown }[] = [];
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await Bun.sleep(1000);
  }
  throw new Error("Qualification timed out; inspect resident traces");
}
async function spawn(name: string, role: string, goal: string) {
  if (agents.length) await Bun.sleep(1100);
  const handle = await runtime.engine.agentRuntime.spawn({
    name,
    role,
    goal,
    model,
    crewResponder: true,
    toolProfile: "minimal",
    maxTokens: 1500,
    budgetCalls: 24,
    promptTimeoutMs: 60000,
    loopCycleDelay: 1000,
  });
  agents.push(name);
  handle.subscribe((event) => traces.push({ name, event }));
  return handle;
}
async function job(role: MemoryHelperRole, task: string, space: string) {
  const name = `Mem${role}`;
  await spawn(
    name,
    `memory-${role}`,
    "Inspect memory jobs assigned to you and complete them using the memory assistance protocol. Wait when none are assigned.",
  );
  const worker = runtime.db.getUserByName(name)!;
  const created = await assistance.create(space, {
    role,
    worker_id: worker.id,
    task,
    max_operations: 32,
    timeout_ms: 240000,
  });
  const result = await waitFor(
    () => assistance.get(created.id),
    (j) => ["answered", "abstained"].includes(j.state),
  );
  (report.jobs as MemoryAssistanceJob[]).push(result);
  assert.equal(result.state, "answered", `${role} abstained`);
  await runtime.engine.agentRuntime.stop(name);
  return result;
}
try {
  await requester.connect("MemoryConsumer");
  const port = randomInt(10000, 60000);
  const saved = await requester.memoryService({
    operation: "remember",
    input: {
      content: `Project Cobalt deploys on TCP port ${port}. This is the current approved project configuration.`,
      subject: "project:cobalt",
    },
  });
  assert.ok(saved.ok);
  const space = saved.space_id!;
  const recordId = (saved.result as MemoryReceipt).id;
  const incident = await requester.memoryService({
    operation: "capture",
    input: {
      content:
        "Cobalt incident: a migration failed because the app started before the schema was ready. Moving migration completion before app startup resolved the failure; the subsequent integration suite passed. The observation covers this deployment only.",
    },
  });
  assert.ok(incident.ok, "Incident source must be captured");
  const incidentId = (incident.result as MemoryReceipt).id;
  const pilot = await requester.memoryService({
    operation: "capture",
    input: {
      content:
        "Cobalt pilot evaluation: ten questions with seed 42, repeated warm on the same items. No held-out control, no uncertainty interval, and no comparison against the resident retrieval path. A higher warm score demonstrates performance on these repeated items only.",
    },
  });
  assert.ok(pilot.ok, "Pilot methodology source must be captured");
  const pilotId = (pilot.result as MemoryReceipt).id;
  const librarian = await job(
    "librarian",
    "Find the currently approved deployment port for project Cobalt. Read and cite the configuration; do not guess.",
    space,
  );
  assert.ok(librarian.result?.status === "answered");
  assert.ok(librarian.result.answer?.toString().includes(String(port)));
  assert.ok(librarian.result.citations.some((c) => c.kind === "record" && c.id === recordId));
  // The consumer has never received the port in its goal, checkpoint or legacy
  // notes. Its only task context is a job ID. Inspect real tool calls as well as
  // the final answer, so checkpoint arithmetic cannot satisfy this gate.
  requester.disconnect();
  const consumer = await spawn(
    "MemoryConsumer",
    "general",
    `Read memory assistance ${librarian.id}. Extract the approved Cobalt port from the cited librarian result and run memory set qualification-port NUMBER. Do not guess. This is your entire task.`,
  );
  await waitFor(
    async () => runtime.db.getCoreMemory("MemoryConsumer", "qualification-port")?.value,
    (v) => v === String(port),
  );
  assert.ok(
    traces.some(
      (x) =>
        x.name === "MemoryConsumer" &&
        JSON.stringify(x.event).includes(librarian.id) &&
        JSON.stringify(x.event).includes("tool_call"),
    ),
    "Consumer must use the job protocol",
  );
  report.consumer = {
    actual: runtime.db.getCoreMemory("MemoryConsumer", "qualification-port")?.value,
    expected: String(port),
    model: consumer.getStatus().model,
  };
  await runtime.engine.agentRuntime.stop("MemoryConsumer");
  await requester.connect("MemoryConsumer");
  const reflector = await job(
    "reflector",
    "Read the original Cobalt migration incident and propose one bounded lesson, its applicability, and how to test it. Cite the incident source.",
    space,
  );
  assert.ok(reflector.result?.status === "answered");
  assert.ok(
    reflector.result.citations.some((c) => c.kind === "source" && c.id === incidentId),
    "Reflection must cite the original incident, not just another helper's proposal",
  );
  const evaluator = await job(
    "evaluator",
    "Assess what the Cobalt pilot evaluation actually establishes. Inspect its original methodology, identify missing controls, and cite your evidence.",
    space,
  );
  assert.ok(evaluator.result?.status === "answered");
  assert.ok(
    evaluator.result.citations.some((c) => c.kind === "source" && c.id === pilotId),
    "Evaluation must cite the original pilot methodology, not the unrelated migration incident",
  );
  assert.match(String(evaluator.result.answer), /repeat|same (?:items|questions)/i);
  assert.match(String(evaluator.result.answer), /control|held[- ]out/i);
  report.qualification = {
    librarian: "Correct randomized port and canonical record citation",
    consumer: "Fresh resident reads job and uses the port; its own tool trace checked",
    reflector: "Original incident citation",
    evaluator: "Original methodology citation, repeated-item limitation and missing controls",
    review: "These are bounded functional checks, not a general semantic quality score",
  };
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const name of agents) {
    if (runtime.engine.agentRuntime.get(name)) await runtime.engine.agentRuntime.stop(name);
  }
  requester.disconnect();
  report.spending = runtime.spending;
  writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  writeFileSync(`${directory}/traces.json`, JSON.stringify(traces), { mode: 0o600 });
  await runtime.close();
  console.log(
    JSON.stringify({
      passed: report.passed,
      error: report.error,
      report: `${directory}/report.json`,
    }),
  );
}
