// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Repeated, balanced same-agent utility trial through Marina's model router.
 * --offline validates protocol/grading only; it is never reported as LLM evidence.
 * Live runs require an explicit dollar budget. Optional embeddings require a cache.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getInternalModelToken } from "../../src/agent/agent-runtime";
import { Engine } from "../../src/engine/engine";
import { localEmbeddings } from "../../src/memory/local-embeddings";
import { serveMemory } from "../../src/memory/server";
import { setEndpointConfig } from "../../src/net/model-endpoint";
import { WebSocketServer } from "../../src/net/websocket-server";
import { MarinaDB } from "../../src/persistence/database";
import { MarinaMemoryClient } from "../../src/sdk/memory-client";
import { roomId } from "../../src/types";
import { evaluationBudgetFetch } from "./memory-evaluation-budget";
import { gradeUtility, utilityCases } from "./memory-utility-cases";

// Qualification endpoints stay local regardless of deployment defaults.
process.env.WS_HOST = "127.0.0.1";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    output: { type: "string" },
    repetitions: { type: "string", default: "3" },
    "budget-usd": { type: "string" },
    "model-cache": { type: "string" },
    offline: { type: "boolean", default: false },
  },
});
const repetitions = Number(values.repetitions),
  budget = Number(values["budget-usd"]);
if (
  !values.output ||
  !Number.isInteger(repetitions) ||
  repetitions < 1 ||
  repetitions > 20 ||
  (!values.offline && (!Number.isFinite(budget) || budget <= 0 || budget > 20))
)
  throw new Error(
    "Use --output FILE --repetitions 1..20 [--model-cache EXISTING_CACHE] and --offline or --budget-usd 0..20",
  );
const upstream = "openai/gpt-4o-mini-2024-07-18";
const pricing = {
  input_per_million: 0.15,
  output_per_million: 0.6,
  verified_on: "2026-09-12",
  source: "https://developers.openai.com/api/docs/models/gpt-4o-mini",
};
const directory = mkdtempSync(join(tmpdir(), "marina-utility-"));
const routerDb = new MarinaDB(join(directory, "router.db"));
routerDb.setSetting("default_model", upstream);
setEndpointConfig(routerDb, { mode: "passthru", passthruModel: upstream });
const engine = new Engine({
  db: routerDb,
  startRoom: roomId("evaluation/start"),
  tickInterval: 60000,
});
const router = new WebSocketServer(engine, 0);
router.setDb(routerDb);
const provider = values["model-cache"]
  ? await localEmbeddings(values["model-cache"], true)
  : undefined;
const memory = serveMemory({ dbPath: join(directory, "memory.db"), port: 0, embeddings: provider });
let actual = 0,
  calls = 0;
const maxCalls = repetitions * utilityCases.length * (provider ? 3 : 2) * 6;
const spending = {
  ceiling: values.offline ? 0 : budget,
  reserved: 0,
  attempts: 0,
  maxAttempts: maxCalls,
  model: "gpt-4o-mini-2024-07-18",
  inputPerMillion: pricing.input_per_million,
  outputPerMillion: pricing.output_per_million,
};
const originalFetch = globalThis.fetch;
globalThis.fetch = evaluationBudgetFetch(originalFetch, spending);
const gateToken = crypto.randomUUID();
const gate = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBodySize: 65536,
  async fetch(req) {
    if (req.headers.get("Authorization") !== `Bearer ${gateToken}`)
      return new Response("Unauthorized", { status: 401 });
    const body = (await req.json()) as {
      messages: { role: string; content: string }[];
      max_tokens: number;
      model: string;
    };
    if (
      !Array.isArray(body.messages) ||
      body.messages.some((m) => typeof m.content !== "string") ||
      body.max_tokens !== 500 ||
      body.model !== "marina/default"
    )
      return new Response("Invalid evaluation request", { status: 400 });
    if (calls >= maxCalls) return new Response("Evaluation request limit reached", { status: 429 });
    calls++;
    if (values.offline) {
      const searched = body.messages.some((m) => m.content.includes('"tool_result"'));
      const result = searched
        ? { answer: "UNKNOWN", citations: [] }
        : { operation: "search", input: { query: body.messages[1]?.content ?? "evidence" } };
      return Response.json({
        choices: [{ message: { content: JSON.stringify(result) } }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    }
    const response = await fetch(`http://127.0.0.1:${router.getPort()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getInternalModelToken()}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const result = (await response.json()) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    actual +=
      ((result.usage?.prompt_tokens ?? 0) * pricing.input_per_million +
        (result.usage?.completion_tokens ?? 0) * pricing.output_per_million) /
      1e6;
    return Response.json(result, { status: response.status });
  },
});
const results: Record<string, unknown>[] = [];
const report = () => ({
  schema: "marina.memory.utility.v1",
  observed_at: new Date().toISOString(),
  protocol_only: values.offline,
  complete: results.length === repetitions * utilityCases.length * (provider ? 3 : 2),
  upstream: values.offline ? "offline-protocol-fixture" : upstream,
  pricing,
  repetitions,
  embedding: provider?.id ?? null,
  conditions: provider ? ["none", "portable", "portable+embeddings"] : ["none", "portable"],
  source_hashes: Object.fromEntries(
    [
      "examples/memory-service/task-agent.ts",
      "scripts/research/memory-utility-cases.ts",
      "scripts/research/memory-evaluation-budget.ts",
      "scripts/research/memory-utility-qualification.ts",
    ].map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
  ),
  budget: {
    ceiling_usd: values.offline ? 0 : budget,
    reserved_upper_bound_usd: spending.reserved,
    upstream_attempts: spending.attempts,
    observed_usage_cost_usd: actual,
    calls,
    max_calls: maxCalls,
  },
  results,
  limits:
    "Twelve synthetic structured tasks across coding, research, planning and personal memory; balanced condition order. Coding scores a configuration patch and retry behavior, not arbitrary repository coding. Exact graders and citation checks; no LLM judge, production-task claim, or statistical significance claim. Offline runs prove protocol only.",
});
const publish = () => Bun.write(values.output!, `${JSON.stringify(report(), null, 2)}\n`);
try {
  if (!values.offline) router.start();
  const credential = memory.db.issueMemoryCredential(
    memory.db.ensurePrincipal({ type: "service", displayName: "utility" }).principal_id,
  );
  const client = new MarinaMemoryClient(`http://127.0.0.1:${memory.server.port}`, credential.token);
  const space = (await client.createSpace("utility")).id;
  const expected = new Map<string, string[]>();
  for (const task of utilityCases) {
    if (!("evidence" in task)) continue;
    const source = await client.capture(space, task.evidence);
    expected.set(task.id, [source.id]);
    if ("source_only" in task && task.source_only) continue;
    const oldSource = "old" in task ? await client.capture(space, task.old) : source;
    const original = await client.remember(space, {
      content: "old" in task ? task.old : task.evidence,
      source_ids: [oldSource.id],
    });
    let receipt = original;
    if ("old" in task)
      receipt = await client.revise(space, original.id, 1, {
        content: task.evidence,
        source_ids: [source.id],
      });
    expected.get(task.id)!.push(receipt.id);
    if (provider) await client.waitForIndex(space, receipt);
  }
  const reader = memory.db.issueMemoryCredential(credential.principalId, ["memory:read"]);
  const conditions = provider ? ["none", "portable", "portable+embeddings"] : ["none", "portable"];
  for (let repetition = 0; repetition < repetitions; repetition++)
    for (const [index, task] of utilityCases.entries()) {
      const offset = (repetition + index) % conditions.length;
      for (let n = 0; n < conditions.length; n++) {
        const condition = conditions[(n + offset) % conditions.length]!;
        const child = Bun.spawn(
          [process.execPath, resolve("examples/memory-service/task-agent.ts"), task.task],
          {
            cwd: directory,
            stdout: "pipe",
            stderr: "pipe",
            env: {
              PATH: process.env.PATH ?? "",
              MARINA_MEMORY_URL: client.url,
              MARINA_MEMORY_TOKEN: reader.token,
              MARINA_MEMORY_SPACE: space,
              MARINA_EVAL_CONDITION: condition,
              MARINA_EVAL_ROUTER_URL: `http://127.0.0.1:${gate.port}`,
              MARINA_EVAL_ROUTER_TOKEN: gateToken,
              MARINA_EVAL_MODEL: "marina/default",
            },
          },
        );
        const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
        let out: string, err: string, status: number;
        try {
          [out, err, status] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (status) throw new Error(`Agent failed ${condition}/${task.id}: ${err.slice(-1000)}`);
        const result = JSON.parse(out.trim());
        const available = new Set<string>();
        const inspect = (value: unknown) => {
          if (Array.isArray(value)) {
            for (const item of value) inspect(item);
          } else if (value && typeof value === "object") {
            for (const [key, item] of Object.entries(value)) {
              if (key === "id" && typeof item === "string") available.add(item);
              else inspect(item);
            }
          }
        };
        for (const trace of result.trace) inspect(trace.result);
        const grade = gradeUtility(
          task,
          result.answer,
          result.citations,
          available,
          expected.get(task.id) ?? [],
        );
        results.push({
          repetition,
          condition,
          task: task.id,
          domain: task.domain,
          correction: task.correction,
          ...grade,
          ...result,
        });
        await publish();
        console.error(
          `${condition}/${task.id}/${repetition}: supported=${grade.supported_success}`,
        );
      }
    }
} finally {
  await publish();
  globalThis.fetch = originalFetch;
  gate.stop(true);
  router.stop();
  engine.stop();
  routerDb.close();
  await memory.close();
  rmSync(directory, { recursive: true });
}
