// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { compareMemoryRecipes, MarinaMemoryClient, type MemoryRecipe } from "../../src/sdk/memory";

const credentialPath = process.argv[2];
if (!credentialPath)
  throw new Error(
    "Usage: bun examples/memory-workflows/run.ts CREDENTIAL_FILE [http://127.0.0.1:3301]",
  );
const credential = JSON.parse(readFileSync(credentialPath, "utf8")) as { token: string };
const client = new MarinaMemoryClient(process.argv[3] ?? "http://127.0.0.1:3301", credential.token);
// Disposable spaces make this repeatable without altering an existing corpus.
const space = (await client.createSpace(`workflow-example-${crypto.randomUUID()}`)).id;
const source = await client.capture(space, "Zephyr deployment: port 8123; health path /ready.");
const fact = await client.remember(space, {
  content: "Zephyr health path is /ready",
  source_ids: [source.id],
  claim: {
    subject: "app:zephyr",
    predicate: "health:path",
    object: { kind: "literal", value: "/ready" },
  },
});
const work = client.workflows(space);
const task = await work.start(
  "Find Zephyr deployment port and health path",
  { next_action: "Read the deployment instructions" },
  "start-example",
);
const run = await work.run(task.task_id, task.version, { selection: "balanced" }, "run-example");
if (!JSON.stringify(run.retrieval.evidence).includes("8123"))
  throw new Error("Expected documented port in evidence");
const policy: MemoryRecipe = {
  schema: "marina.memory.policy.v1",
  name: "Claims with original context",
  description: "Show a claim and an original passage early.",
  retrieval: { selection: "balanced" },
  prerequisites: ["Corpus contains original sources or versioned records"],
  exceptions: ["Lexical matching needs explicit alternatives for unfamiliar vocabulary"],
  compatibility: "marina.memory.retrieval.v1",
  evidence: [],
};
const comparison = compareMemoryRecipes(await work.exportEpisode(task.task_id), [policy]);
const saved = await work.saveRecipe(policy, "save-example-recipe");
const selected = await work.useRecipe(saved.id, saved.version!, "Zephyr health path");
await work.watch("deployment", [fact.id]);
await client.revise(space, fact.id, fact.version!, {
  content: "Zephyr health path changed to /healthz",
  claim: {
    subject: "app:zephyr",
    predicate: "health:path",
    object: { kind: "literal", value: "/healthz" },
  },
});
// A fresh client has no conversational or process state from the first task.
const successor = new MarinaMemoryClient(client.url, credential.token).workflows(space);
const resumed = await successor.resume(task.task_id, true);
if (!resumed.premises.some((pin) => pin.state === "changed"))
  throw new Error("Expected changed premise on resume");
const changes = await successor.poll("deployment");
await successor.ack("deployment", changes.acknowledgement);
await successor.finish(
  task.task_id,
  resumed.version,
  "completed",
  "Use the corrected health path /healthz",
  "finish-example",
);
await successor.feedback(
  {
    task_id: task.task_id,
    rubric: "Retrieved the documented port and detected the corrected premise",
    result: "pass",
    explanation: "Executable assertions passed; no model correctness claim.",
    metrics: { model_calls: 0, cost_usd: 0 },
  },
  "feedback-example",
);
console.log(
  JSON.stringify(
    {
      space_id: space,
      journal_space_id: task.journal_space_id,
      task_id: task.task_id,
      evidence_items: run.retrieval.evidence.length,
      comparison_status: comparison.candidates[0]?.status,
      recipe_evidence_items: selected.evidence.length,
      changed_premises: resumed.premises.filter((pin) => pin.state === "changed").length,
      notification_count: changes.changes.events.length,
      status: "completed",
    },
    null,
    2,
  ),
);
