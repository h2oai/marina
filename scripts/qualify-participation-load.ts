#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RateLimiter } from "../src/auth/rate-limiter";
import { Engine } from "../src/engine/engine";
import { Logger } from "../src/engine/logger";
import { setTrustProfile } from "../src/engine/trust-profile";
import { contextCacheStats } from "../src/memory/context-cache";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MCP_MAX_SESSION_PENDING, mcpAdmission } from "../src/net/mcp-admission";
import { McpServerAdapter } from "../src/net/mcp-server";
import type { McpResult } from "../src/net/mcp-types";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    directory: { type: "string" },
    participants: { type: "string", default: "16" },
    records: { type: "string", default: "64" },
    operations: { type: "string", default: "30" },
  },
});
const participants = Number(values.participants),
  records = Number(values.records),
  operations = Number(values.operations);
if (
  !values.directory ||
  !Number.isInteger(participants) ||
  participants < 2 ||
  participants > 64 ||
  !Number.isInteger(records) ||
  records < 1 ||
  records > 1000 ||
  !Number.isInteger(operations) ||
  operations < 1 ||
  operations > 1000
)
  throw new Error(
    "Use --directory PATH --participants 2..64 --records 1..1000 --operations 1..1000",
  );
const directory = resolve(values.directory);
mkdirSync(directory, { recursive: true, mode: 0o700 });
// Local admission qualification deliberately removes token-rate throttling; bounded
// work admission still applies. No providers, room agents or external services run.
setTrustProfile("local");
RateLimiter.bypass = true;
process.env.WS_HOST = "127.0.0.1";
const db = new MarinaDB(`${directory}/world.db`, { durability: "full" });
const engine = new Engine({
  db,
  startRoom: roomId("qualification/start"),
  logger: new Logger({ level: "error" }),
});
engine.registerRoom(roomId("qualification/start"), {
  short: "Qualification",
  long: "Local participation load",
  exits: {},
});
const adapter = new McpServerAdapter(engine, 0);
const clients: Client[] = [];
const samples: Record<string, number[]> = {};
const report: Record<string, unknown> = {
  schema: "marina.participation.load.v1",
  passed: false,
  participants,
  records_per_participant: records,
  operations_per_participant: operations,
  transport: "MCP over loopback HTTP",
  durability: "FULL",
  rate_throttling: "bypassed for capacity measurement",
};
const release = Promise.withResolvers<void>();
const entered = Promise.withResolvers<void>();
let holds = 0;
engine.commands.registerOwned("qualification", {
  name: "hold",
  help: "Admission probe",
  async handler() {
    entered.resolve();
    await release.promise;
    holds++;
  },
});
async function call(index: number, name: string, args: Record<string, unknown> = {}) {
  return (await clients[index]!.callTool({ name, arguments: args })) as McpResult;
}
const text = (result: McpResult) => result.content.map((item) => item.text).join("\n");
async function measured(index: number, label: string) {
  const start = performance.now();
  const result = await call(index, "look");
  (samples[label] ??= []).push(performance.now() - start);
  assert.ok(!result.isError, "Look failed");
  const context = result.content.find((item) => item.text.startsWith("Task memory context"))?.text;
  assert.ok(
    context?.includes(`private-evidence-${index}`),
    "Automatic context missing own evidence",
  );
  for (let peer = 0; peer < participants; peer++)
    if (peer !== index)
      assert.ok(!context.includes(`private-evidence-${peer} `), "Cross-resident context leak");
}
const started = performance.now();
try {
  adapter.start();
  const base = `http://127.0.0.1:${adapter.getPort()}`;
  for (let i = 0; i < participants; i++) {
    const client = new Client({ name: "participation-qualification", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    clients.push(client);
    const logged = await call(i, "login", {
      name: `LoadResident${i}`,
      task: `quartz${i} deployment port`,
      contextMode: "auto",
    });
    assert.ok(text(logged).includes("Logged in as"), "World login failed");
    for (let note = 0; note < records; note++)
      db.createNote(
        `LoadResident${i}`,
        `quartz${i} deployment port private-evidence-${i} entry ${note}`,
        undefined,
        { importance: 5, noteType: "fact" },
      );
  }
  // All principals and records exist before measuring cold versus warm retrieval.
  await Promise.all(clients.map((_, index) => measured(index, "cold")));
  const before = contextCacheStats(db);
  await Promise.all(
    clients.map(async (_, index) => {
      for (let n = 0; n < operations; n++) await measured(index, "warm");
    }),
  );
  const after = contextCacheStats(db);
  assert.ok(after.hits > before.hits, "No safe cache reuse under actual MCP traffic");
  report.context_cache = { before, after };

  // Overflow is rejected before mutation; after release the same session recovers.
  const held = call(0, "command", { input: "hold" });
  await entered.promise;
  const overflow = Array.from({ length: MCP_MAX_SESSION_PENDING + 8 }, () =>
    call(0, "command", { input: "hold" }),
  );
  const waitUntil = Date.now() + 5000;
  while (mcpAdmission(engine).snapshot().rejected < 9 && Date.now() < waitUntil) await Bun.sleep(5);
  assert.ok(
    mcpAdmission(engine).snapshot().rejected >= 9,
    "Queue did not reject overload promptly",
  );
  assert.equal(holds, 0);
  release.resolve();
  const completed = await Promise.all([held, ...overflow]);
  const rejected = completed.filter((result) => result.isError);
  assert.equal(rejected.length, 9);
  assert.equal(holds, MCP_MAX_SESSION_PENDING);
  assert.ok(
    rejected.every(
      (result) => (result.structuredContent?.error as { executed?: boolean })?.executed === false,
    ),
  );
  await measured(0, "recovered");
  report.admission = mcpAdmission(engine).snapshot();

  // A primed cache cannot survive a durable identity withdrawal.
  const raw = db.memoryRepository().raw;
  raw.run("UPDATE principals SET status='suspended' WHERE principal_id=?", [
    db.getUserByName("LoadResident0")!.id,
  ]);
  const suspended = await call(0, "context", {
    query: "quartz0 deployment port",
    scope: "evidence",
  });
  assert.ok(!text(suspended).includes("private-evidence-0 "), "Suspended evidence leaked");
  raw.run("UPDATE principals SET status='active' WHERE principal_id=?", [
    db.getUserByName("LoadResident0")!.id,
  ]);
  await residentMemoryOperation(db, "LoadResident0", { operation: "me" });
  report.revocation_checked = true;
  report.health = await (await fetch(`${base}/health`)).json();
  report.passed = true;
} finally {
  release.resolve();
  await Promise.allSettled(clients.map((client) => client.close()));
  await adapter.stop();
  await engine.shutdown();
  db.close();
  const percentile = (values: number[], share: number) =>
    values.slice().sort((a, b) => a - b)[
      Math.min(values.length - 1, Math.floor(values.length * share))
    ] ?? 0;
  report.latency_ms = Object.fromEntries(
    Object.entries(samples).map(([name, values]) => [
      name,
      {
        count: values.length,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        p99: percentile(values, 0.99),
        max: Math.max(...values),
      },
    ]),
  );
  report.elapsed_ms = performance.now() - started;
  writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
