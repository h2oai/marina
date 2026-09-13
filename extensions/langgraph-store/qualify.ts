// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { snapshotMemoryQualification } from "../../scripts/research/memory-qualification-sources";
import { serveMemory } from "../../src/memory/server";
import { MarinaMemoryClient, MarinaStore } from "./index";

const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2] || directory.startsWith(`${process.cwd()}/`))
  throw new Error("Supply a qualification directory outside the public repository");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const sources = snapshotMemoryQualification(directory);
let runtime = serveMemory({ dbPath: `${directory}/memory.db`, port: 0 });
const principal = runtime.db.ensurePrincipal({
  type: "service",
  displayName: "LangGraph qualification",
});
const credential = runtime.db.issueMemoryCredential(principal.principal_id);
let client = new MarinaMemoryClient(`http://127.0.0.1:${runtime.server.port}`, credential.token);
const space = (await client.createSpace("framework")).id;
let store = new MarinaStore(client, space);
const State = Annotation.Root({ observed: Annotation<string>() });
const graph = () =>
  new StateGraph(State)
    .addNode("resume", async (_state, config) => {
      const item = await config.store!.get(["project", "handoff"], "next");
      return { observed: String(item?.value.task) };
    })
    .addEdge(START, "resume")
    .addEdge("resume", END)
    .compile({ store });
try {
  await store.put(["project", "handoff"], "next", { task: "review original sources", priority: 3 });
  assert.equal((await graph().invoke({ observed: "" })).observed, "review original sources");
  await runtime.close();
  runtime = serveMemory({ dbPath: `${directory}/memory.db`, port: 0 });
  client = new MarinaMemoryClient(`http://127.0.0.1:${runtime.server.port}`, credential.token);
  store = new MarinaStore(client, space);
  assert.equal((await graph().invoke({ observed: "" })).observed, "review original sources");
  const first = await store.get(["project", "handoff"], "next");
  assert(first?.createdAt instanceof Date);
  assert(first.updatedAt instanceof Date);
  await store.put(["project", "handoff"], "next", {
    task: "review corrected sources",
    priority: 7,
  });
  assert.equal((await graph().invoke({ observed: "" })).observed, "review corrected sources");
  assert.equal((await store.search(["project"], { filter: { priority: { $gte: 7 } } })).length, 1);
  assert.deepEqual(await store.listNamespaces({ prefix: ["project"], maxDepth: 1 }), [["project"]]);
  await assert.rejects(() => store.search(["project"], { query: "semantic" }));
  await store.delete(["project", "handoff"], "next");
  assert.equal(await store.get(["project", "handoff"], "next"), null);
  const report = {
    passed: true,
    profile: "langgraph-store-json-v1",
    client: "LangGraph StateGraph",
    phases: [
      "authored JSON",
      "fresh graph retrieval",
      "service restart",
      "fresh adapter",
      "correction",
      "filter",
      "namespace listing",
      "explicit unsupported semantic query",
      "delete",
    ],
    sources,
  };
  writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, phases: report.phases.length }));
} finally {
  await runtime.close();
}
