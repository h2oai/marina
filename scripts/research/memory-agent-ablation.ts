// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Controlled pilot: same fresh HTTP-only LLM agent, task text, data and model;
 * only memory availability / embedding retrieval changes. Not a leaderboard. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getInternalModelToken } from "../../src/agent/agent-runtime";
import { Engine } from "../../src/engine/engine";
import { localEmbeddings } from "../../src/memory/local-embeddings";
import {
  createMemoryPlan,
  executeMemoryPlan,
  routerMemoryPlanner,
} from "../../src/memory/planning";
import { serveMemory } from "../../src/memory/server";
import { MemoryService } from "../../src/memory/service";
import { setEndpointConfig } from "../../src/net/model-endpoint";
import { WebSocketServer } from "../../src/net/websocket-server";
import { MarinaDB } from "../../src/persistence/database";
import { MarinaMemoryClient } from "../../src/sdk/memory-client";
import type { MemoryRecordInput } from "../../src/sdk/memory-types";
import { roomId } from "../../src/types";

const cache = Bun.argv[2],
  output = Bun.argv[3];
if (!cache || !output)
  throw new Error(
    "Usage: bun run scripts/research/memory-agent-ablation.ts EXISTING_MODEL_CACHE OUTPUT_JSON",
  );
const directory = mkdtempSync(join(tmpdir(), "marina-ablation-"));
const routerDb = new MarinaDB(join(directory, "router.db"));
routerDb.setSetting("default_model", process.env.MARINA_EVAL_UPSTREAM ?? "openai/gpt-4o-mini");
setEndpointConfig(routerDb, { mode: "passthru", passthruModel: routerDb.getDefaultModel() });
const engine = new Engine({
  startRoom: roomId("evaluation/start"),
  tickInterval: 60000,
  db: routerDb,
});
const router = new WebSocketServer(engine, 0);
router.setDb(routerDb);
const provider = await localEmbeddings(cache, true);
const runtime = serveMemory({
  dbPath: join(directory, "memory.db"),
  port: 0,
  embeddings: provider,
});
const cases = [
  { id: "gate", task: "Who must approve the Aster migration before release?", expected: "mira" },
  {
    id: "source",
    task: "What is the exact recovery code for incident Kestrel?",
    expected: "kestrel-7b91",
  },
  {
    id: "paraphrase",
    task: "Which dietary restriction did the visitor describe?",
    expected: "animal products",
  },
  {
    id: "temporal",
    task: "What was project:river's status at UTC millisecond 150? Use its explicit status assertions.",
    expected: "active",
  },
  {
    id: "dependency",
    task: "Which component does component:gateway depend on?",
    expected: "authentication",
  },
  { id: "unknown", task: "What is the submarine captain's birthday?", expected: "unknown" },
];
const fixtures: MemoryRecordInput[] = [
  { content: "Aster migration release requires approval from Mira." },
  { content: "The visitor says: I avoid all animal products." },
  {
    content: "River is active during the first phase.",
    claim: {
      subject: "project:river",
      predicate: "status",
      object: { kind: "literal", value: "active" },
    },
    valid_time: { from: 100, until: 200 },
  },
  {
    content: "River is paused during the second phase.",
    claim: {
      subject: "project:river",
      predicate: "status",
      object: { kind: "literal", value: "paused" },
    },
    valid_time: { from: 200, until: null },
  },
  {
    content: "The gateway depends on authentication.",
    claim: {
      subject: "component:gateway",
      predicate: "depends_on",
      object: { kind: "entity", id: "component:auth" },
    },
  },
  ...[
    "The telescope observes galaxies.",
    "The orchestra rehearses on Monday.",
    "The gardener plants roses.",
    "The bicycle chain needs oil.",
    "Backups use encrypted disks.",
  ].map((content) => ({ content })),
];
try {
  router.start();
  const credential = runtime.db.issueMemoryCredential(
    runtime.db.ensurePrincipal({ type: "service", displayName: "evaluation" }).principal_id,
  );
  const url = `http://127.0.0.1:${runtime.server.port}`;
  const client = new MarinaMemoryClient(url, credential.token);
  const space = (await client.createSpace("evaluation")).id;
  const source = await client.capture(
    space,
    "Incident Kestrel runbook: recovery code KESTREL-7B91. Preserve the exact code.",
  );
  const expectedIds: Record<string, string[]> = { source: [source.id] };
  for (const [i, fixture] of fixtures.entries()) {
    const receipt = await client.remember(space, fixture);
    if (i === 0) expectedIds.gate = [receipt.id];
    if (i === 1) expectedIds.paraphrase = [receipt.id];
    if (i === 2) expectedIds.temporal = [receipt.id];
    if (i === 4) expectedIds.dependency = [receipt.id];
    await client.waitForIndex(space, receipt);
  }
  const readonly = runtime.db.issueMemoryCredential(credential.principalId, ["memory:read"]);
  const planningService = new MemoryService(
    runtime.db,
    undefined,
    routerMemoryPlanner(
      `http://127.0.0.1:${router.getPort()}/v1`,
      "marina",
      getInternalModelToken(),
    ),
  );
  const planningActor = runtime.db.verifyMemoryCredential(readonly.token)!;
  const plan = await createMemoryPlan(planningService, planningActor, space, {
    task: cases[0]!.task,
    use_model: true,
  });
  const planResult = await executeMemoryPlan(planningService, planningActor, space, plan);
  const results = [];
  for (const condition of ["none", "portable", "portable+embeddings"]) {
    for (const task of cases) {
      const child = Bun.spawn(
        [process.execPath, resolve("examples/memory-service/task-agent.ts"), task.task],
        {
          cwd: directory,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "",
            MARINA_MEMORY_URL: url,
            MARINA_MEMORY_TOKEN: readonly.token,
            MARINA_MEMORY_SPACE: space,
            MARINA_EVAL_CONDITION: condition,
            MARINA_EVAL_ROUTER_URL: `http://127.0.0.1:${router.getPort()}/v1`,
            MARINA_EVAL_ROUTER_TOKEN: getInternalModelToken(),
            MARINA_EVAL_MODEL: "marina/default",
          },
        },
      );
      const timer = setTimeout(() => child.kill(), 180000);
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      clearTimeout(timer);
      if (exit !== 0)
        throw new Error(`Agent ${condition}/${task.id} failed (${exit}): ${stderr.slice(-1000)}`);
      const result = JSON.parse(stdout.trim());
      const correct = result.answer.toLowerCase().includes(task.expected);
      const cited =
        task.id === "unknown"
          ? result.citations.length === 0
          : result.citations.some((id: string) => expectedIds[task.id]?.includes(id));
      results.push({
        condition,
        task: task.id,
        correct,
        cited,
        supported_success: correct && cited,
        ...result,
      });
      console.error(`${condition}/${task.id}: correct=${correct}, cited=${cited}`);
    }
  }
  const artifact = {
    schema: "marina.memory.agent-ablation.v1",
    observed_at: new Date().toISOString(),
    upstream: routerDb.getDefaultModel(),
    embedding: provider.id,
    agent:
      "Independent process; HTTP-only memory and LLM access; identical prompt and six-turn budget",
    agent_sha256: createHash("sha256")
      .update(readFileSync(resolve("examples/memory-service/task-agent.ts")))
      .digest("hex"),
    rubric_revision: "v2: accept animal products and authentication as equivalent answers",
    tasks: cases,
    fixture_records: fixtures.length,
    source_only_records: 1,
    planner_probe: { plan, result: planResult },
    conditions: ["none", "portable", "portable+embeddings"],
    results,
    limits:
      "Six synthetic tasks, one run per condition, temperature zero; illustrative pilot without statistical significance, cost pricing, coding-task or multi-day generalization. Correctness uses declared substrings and expected evidence IDs, not an LLM judge.",
  };
  await Bun.write(output, `${JSON.stringify(artifact, null, 2)}\n`);
} finally {
  router.stop();
  engine.stop();
  routerDb.close();
  await runtime.close();
  rmSync(directory, { recursive: true });
}
