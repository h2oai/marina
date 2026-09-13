// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Concurrent HTTP tenants, real transport cancellation and lost-response retry.
 * No model, vector index or deployment-specific latency promise. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { serveMemory } from "../src/memory/server";
import { MarinaMemoryClient, MemoryClientError } from "../src/sdk/memory-client";
import { retryMemoryOperation } from "../src/sdk/memory-retry";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    directory: { type: "string" },
    tenants: { type: "string", default: "16" },
    operations: { type: "string", default: "40" },
  },
});
const tenants = Number(values.tenants),
  operations = Number(values.operations);
if (
  !values.directory ||
  !Number.isInteger(tenants) ||
  tenants < 2 ||
  tenants > 64 ||
  !Number.isInteger(operations) ||
  operations < 1 ||
  operations > 1000
)
  throw new Error("Use --directory PATH --tenants 2..64 --operations 1..1000");
const directory = resolve(values.directory);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const memory = serveMemory({ dbPath: `${directory}/memory.db`, port: 0 });
const url = `http://127.0.0.1:${memory.server.port}`;
const metrics: Record<string, number[]> = {};
let throttles = 0,
  errors = 0,
  committedAfterCancel = 0;
const started = performance.now();
async function measured<T>(kind: string, fn: () => Promise<T>) {
  const start = performance.now();
  try {
    return await retryMemoryOperation(
      async () => {
        try {
          return await fn();
        } catch (error) {
          if (error instanceof MemoryClientError && error.status === 429) throttles++;
          throw error;
        }
      },
      { attempts: 10 },
    );
  } catch (error) {
    errors++;
    throw error;
  } finally {
    (metrics[kind] ??= []).push(performance.now() - start);
  }
}
const clients: { client: MarinaMemoryClient; token: string; space: string; principal: string }[] =
  [];
const report: Record<string, unknown> = {
  schema: "marina.memory.load.v1",
  tenants,
  operations_per_tenant: operations,
  passed: false,
};
let proxy: ReturnType<typeof Bun.serve> | undefined;
try {
  for (let i = 0; i < tenants; i++) {
    const principal = memory.db.ensurePrincipal({
      type: "service",
      displayName: `tenant-${i}`,
    }).principal_id;
    const credential = memory.db.issueMemoryCredential(principal);
    const client = new MarinaMemoryClient(url, credential.token);
    clients.push({
      client,
      token: credential.token,
      principal,
      space: (await client.createSpace(`tenant-${i}`)).id,
    });
  }
  await Promise.all(
    clients.map(async ({ client, space }, tenant) => {
      for (let index = 0; index < operations; index++) {
        const key = `tenant-${tenant}-write-${index}`;
        const content = `tenantneedle${tenant} document ${index} α🙂 original evidence`;
        const source = await measured("capture", () =>
          client.capture(space, content, undefined, `${key}-source`),
        );
        const record = await measured("remember", () =>
          client.remember(space, { content, source_ids: [source.id] }, key),
        );
        const read = await measured("get", () => client.get(space, record.id));
        assert.equal(read.content, content);
        const search = await measured("search", () =>
          client.search(space, { query: `tenantneedle${tenant}`, limit: 5 }),
        );
        assert.ok(search.results.length);
        assert.ok(search.results.every((row) => row.space_id === space));
      }
    }),
  );
  for (const [i, tenant] of clients.entries()) {
    const next = clients[(i + 1) % clients.length]!;
    await assert.rejects(
      () => tenant.client.space(next.space),
      (error: unknown) => error instanceof MemoryClientError && error.status === 404,
    );
  }
  // Another tenant's intentional burst cannot consume this tenant's bucket.
  const burst = await Promise.all(
    Array.from({ length: 140 }, () =>
      clients[0]!.client.space(clients[0]!.space).then(
        () => 200,
        (e: MemoryClientError) => e.status,
      ),
    ),
  );
  assert.ok(burst.includes(429));
  await measured("unrelated-tenant-during-burst", () =>
    clients[1]!.client.space(clients[1]!.space),
  );
  report.burst_throttled = burst.filter((status) => status === 429).length;
  await Bun.sleep(1100);
  // A real local proxy waits after an upstream commit, then loses the response
  // when the caller aborts. Same-key retry must recover exactly that receipt.
  let resolveCommitted: (() => void) | undefined;
  let committed = new Promise<void>((resolve) => {
    resolveCommitted = resolve;
  });
  let delay = true;
  proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const response = await fetch(
        new Request(`${url}${new URL(request.url).pathname}`, {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
        }),
      );
      const text = await response.text();
      if (delay) {
        resolveCommitted?.();
        await Bun.sleep(250);
      }
      return new Response(text, { status: response.status, headers: response.headers });
    },
  });
  const tenant = clients[1]!;
  const throughProxy = new MarinaMemoryClient(`http://127.0.0.1:${proxy.port}`, tenant.token);
  for (let n = 0; n < 12; n++) {
    committed = new Promise<void>((resolve) => {
      resolveCommitted = resolve;
    });
    delay = true;
    const controller = new AbortController();
    const promise = throughProxy
      .withSignal(controller.signal)
      .capture(tenant.space, `cancel-proof-${n}`, undefined, `cancel-${n}`);
    const failed = promise.then(
      () => false,
      () => true,
    );
    await committed;
    const time = performance.now();
    controller.abort();
    assert.equal(await failed, true);
    (metrics.cancel ??= []).push(performance.now() - time);
    delay = false;
    const replay = await throughProxy.capture(
      tenant.space,
      `cancel-proof-${n}`,
      undefined,
      `cancel-${n}`,
    );
    const replayAgain = await tenant.client.capture(
      tenant.space,
      `cancel-proof-${n}`,
      undefined,
      `cancel-${n}`,
    );
    assert.equal(replay.id, replayAgain.id);
    committedAfterCancel++;
  }
  let cursor = 0,
    recoveredSources = 0;
  for (;;) {
    const original = await retryMemoryOperation(() =>
      tenant.client.sources(tenant.space, cursor, 100),
    );
    recoveredSources += original.sources.filter(
      (source) => typeof source.body === "string" && source.body.startsWith("cancel-proof-"),
    ).length;
    if (!original.sources.length) break;
    assert.ok(original.next_cursor > cursor, "Source pagination must advance");
    cursor = original.next_cursor;
  }
  assert.equal(recoveredSources, 12);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "Load qualification failed";
  process.exitCode = 1;
} finally {
  report.observed_at = new Date().toISOString();
  report.elapsed_ms = performance.now() - started;
  report.errors = errors;
  report.retried_429s = throttles;
  report.cancelled_committed_writes_recovered = committedAfterCancel;
  report.latency_ms = Object.fromEntries(
    Object.entries(metrics).map(([kind, values]) => {
      values.sort((a, b) => a - b);
      return [
        kind,
        {
          count: values.length,
          p50: values[Math.floor(values.length * 0.5)],
          p95: values[Math.floor(values.length * 0.95)],
          p99: values[Math.floor(values.length * 0.99)],
          max: values.at(-1),
        },
      ];
    }),
  );
  report.limits =
    "Loopback, one SQLite deployment, small tenant corpora, cooperative HTTP concurrency. Latencies include explicit retries. An aborted caller does not roll back an already committed mutation; same-key retry resolves ambiguity. No claim of interrupting synchronous SQLite execution or physical power-loss tolerance.";
  writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  proxy?.stop(true);
  await memory.close();
  console.log(JSON.stringify(report));
}
