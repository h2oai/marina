#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Engine } from "../src/engine/engine";
import { Logger } from "../src/engine/logger";
import { contextCacheStats } from "../src/memory/context-cache";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MCP_MAX_SESSION_PENDING, mcpAdmission } from "../src/net/mcp-admission";
import { McpServerAdapter } from "../src/net/mcp-server";
import type { McpResult } from "../src/net/mcp-types";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { scopeProcessState } from "../test/process-state";

export interface ParticipationLoadOptions {
  directory: string;
  participants?: number;
  records?: number;
  operations?: number;
  walPages?: number;
}

/** Disposable local world; restores caller state even if setup or teardown fails. */
export async function qualifyParticipationLoad(options: ParticipationLoadOptions) {
  const { participants = 16, records = 64, operations = 30, walPages = 1000 } = options;
  if (
    !options.directory ||
    !Number.isInteger(participants) ||
    participants < 2 ||
    participants > 64 ||
    !Number.isInteger(records) ||
    records < 1 ||
    records > 1000 ||
    !Number.isInteger(operations) ||
    operations < 1 ||
    operations > 1000 ||
    !Number.isInteger(walPages) ||
    walPages < 1 ||
    walPages > 1_000_000
  )
    throw new Error(
      "Use --directory PATH --participants 2..64 --records 1..1000 --operations 1..1000 --wal-pages 1..1000000",
    );
  const directory = resolve(options.directory);
  if (existsSync(`${directory}/world.db`))
    throw new Error("Qualification needs a new database directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Local admission qualification deliberately removes token-rate throttling; bounded
  // work admission still applies. No providers, room agents or external services run.
  using _processState = scopeProcessState({
    trustProfile: "local",
    rateLimitBypass: true,
    env: { WS_HOST: "127.0.0.1" },
  });
  await using cleanup = new AsyncDisposableStack();
  const db = new MarinaDB(`${directory}/world.db`, { durability: "full" });
  cleanup.defer(() => db.close());
  const storage = db.memoryRepository().raw;
  // Only this disposable benchmark connection is tuned; no production setting changes.
  storage.exec(`PRAGMA wal_autocheckpoint=${walPages}`);
  const engine = new Engine({
    db,
    startRoom: roomId("qualification/start"),
    logger: new Logger({ level: "error" }),
  });
  cleanup.defer(() => engine.shutdown());
  engine.registerRoom(roomId("qualification/start"), {
    short: "Qualification",
    long: "Local participation load",
    exits: {},
  });
  const adapter = new McpServerAdapter(engine, 0);
  cleanup.defer(() => adapter.stop());
  const clients: Client[] = [];
  cleanup.defer(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
  });
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
    sqlite: {
      version: storage.query("SELECT sqlite_version() AS version").get(),
      journal: storage.query("PRAGMA journal_mode").get(),
      synchronous: storage.query("PRAGMA synchronous").get(),
      page_size: storage.query("PRAGMA page_size").get(),
      wal_autocheckpoint: storage.query("PRAGMA wal_autocheckpoint").get(),
    },
  };
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  cleanup.defer(() => release.resolve());
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
    const context = result.content.find((item) =>
      item.text.startsWith("Task memory context"),
    )?.text;
    assert.ok(context, "Automatic context missing");
    assert.ok(
      context.includes(`private-evidence-${index}`),
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
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      const logged = await call(i, "login", {
        name: `LoadResident${i}`,
        task: `quartz${i} deployment port`,
        contextMode: "auto",
      });
      assert.ok(text(logged).includes("Logged in as"), "World login failed");
      for (let note = 0; note < records; note++) {
        const writeStart = performance.now();
        db.createNote(
          `LoadResident${i}`,
          `quartz${i} deployment port private-evidence-${i} entry ${note}`,
          undefined,
          { importance: 5, noteType: "fact" },
        );
        (samples.write ??= []).push(performance.now() - writeStart);
      }
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
    while (mcpAdmission(engine).snapshot().rejected < 9 && Date.now() < waitUntil)
      await Bun.sleep(5);
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
    report.wal_bytes_before_checkpoint = statSync(`${directory}/world.db-wal`).size;
    report.checkpoint = storage.query("PRAGMA wal_checkpoint(PASSIVE)").get();
    report.passed = true;
  } finally {
    await cleanup.disposeAsync();
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

  return report;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      directory: { type: "string" },
      participants: { type: "string", default: "16" },
      records: { type: "string", default: "64" },
      operations: { type: "string", default: "30" },
      "wal-pages": { type: "string", default: "1000" },
    },
  });
  await qualifyParticipationLoad({
    directory: values.directory ?? "",
    participants: Number(values.participants),
    records: Number(values.records),
    operations: Number(values.operations),
    walPages: Number(values["wal-pages"]),
  });
}
