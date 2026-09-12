// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Engine } from "../src/engine/engine";
import { serveMemory } from "../src/memory/server";
import { McpServerAdapter } from "../src/net/mcp-server";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { MarinaClient } from "../src/sdk/client";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import type { MemoryQueryResult, MemoryReceipt, MemoryReviewResult } from "../src/sdk/memory-types";
import { roomId } from "../src/types";
import { makeTestRoom } from "./helpers";

async function call<T>(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, JSON.stringify(response)).toBeFalsy();
  const result = response.structuredContent as { ok: boolean; space_id: string; result: T };
  expect(result.ok).toBe(true);
  return result;
}

it("shares one symbolic memory across world MCP, HTTP, resident SDK and human commands with grants enforced", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-interfaces-"));
  const db = new MarinaDB(join(directory, "world.db"));
  const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom());
  const ws = new WebSocketServer(engine, 0);
  ws.setDb(db);
  const mcp = new McpServerAdapter(engine, 0);
  const agent = new Client({ name: "symbolic-agent", version: "1" });
  let resident: MarinaClient | undefined;
  try {
    ws.start();
    mcp.start();
    engine.start();
    await agent.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.getPort()}/mcp`)),
    );
    expect((await agent.callTool({ name: "memory_query", arguments: {} })).isError).toBe(true);
    await agent.callTool({ name: "login", arguments: { name: "SymbolicOwner" } });
    const saved = await call<MemoryReceipt>(agent, "memory_remember", {
      content: "Build passes with Bun",
      key: "build-assertion",
      claim: {
        subject: "project:marina",
        predicate: "build:runtime",
        object: { kind: "entity", id: "runtime:bun" },
      },
    });
    const space = saved.space_id;
    const credential = db.issueMemoryCredential(db.getUserByName("SymbolicOwner")!.id);
    const http = new MarinaMemoryClient(`http://127.0.0.1:${ws.getPort()}`, credential.token);
    expect((await http.get(space, saved.result.id)).claim?.object).toEqual({
      kind: "entity",
      id: "runtime:bun",
    });
    resident = new MarinaClient(`ws://127.0.0.1:${ws.getPort()}`, {
      autoReconnect: false,
      pingInterval: 0,
      commandDrainTimeout: 1,
    });
    await resident.connect("SymbolicReader");
    const denied = await resident.memoryService({ operation: "query", space_id: space });
    expect(denied.ok).toBe(false);
    const reader = db.getUserByName("SymbolicReader")!.id;
    await http.grant(space, reader, "reader");
    const observed = await resident.memoryService({
      operation: "query",
      space_id: space,
      input: { subject: "project:marina" },
    });
    expect(observed.ok).toBe(true);
    if (observed.ok)
      expect((observed.result as MemoryQueryResult).results[0]?.id).toBe(saved.result.id);
    expect(
      (
        await resident.memoryService({
          operation: "remember",
          space_id: space,
          input: { content: "unauthorized" },
        })
      ).ok,
    ).toBe(false);
    await agent.callTool({
      name: "command",
      arguments: { input: 'memory claim project:marina status "active"' },
    });
    const found = await call<MemoryQueryResult>(agent, "memory_query", {
      subject: "project:marina",
      predicate: "status",
    });
    expect(found.result.results[0]?.claim?.object).toEqual({ kind: "literal", value: "active" });
    const readViaHttp = await http.query(space, { predicate: "status" });
    expect(readViaHttp.results[0]?.id).toBe(found.result.results[0]?.id);
    await http.grant(space, reader, null);
    expect(
      (
        await resident.memoryService({
          operation: "graph",
          space_id: space,
          input: { subject: "project:marina" },
        })
      ).ok,
    ).toBe(false);
    // Concurrent calls in one MCP session must receive their own structured result.
    const [left, right] = await Promise.all([
      call<MemoryQueryResult>(agent, "memory_query", { predicate: "status" }),
      call<MemoryQueryResult>(agent, "memory_query", { predicate: "build:runtime" }),
    ]);
    expect(left.result.results[0]?.claim?.predicate).toBe("status");
    expect(right.result.results[0]?.claim?.predicate).toBe("build:runtime");
    const batch = await call<MemoryReceipt & { receipts: MemoryReceipt[] }>(
      agent,
      "memory_service",
      {
        operation: "capture_batch",
        key: "mcp-batch",
        input: { items: [{ content: "review evidence", key: "mcp-evidence" }] },
      },
    );
    const derived = await call<MemoryReceipt>(agent, "memory_remember", {
      content: "Use the current runtime",
      depends_on: [saved.result.id],
      dependency_versions: { [saved.result.id]: 1 },
      source_ids: [batch.result.receipts[0]!.id],
      claim: {
        subject: "project:derived",
        predicate: "uses",
        object: { kind: "entity", id: "runtime:bun" },
      },
    });
    await http.revise(space, saved.result.id, 1, { content: "Runtime contract changed" });
    expect(
      (await call<MemoryQueryResult>(agent, "memory_query", { subject: "project:derived" })).result
        .results,
    ).toHaveLength(0);
    expect(
      (
        await call<MemoryQueryResult>(agent, "memory_query", {
          subject: "project:derived",
          include_stale: true,
        })
      ).result.results[0],
    ).toMatchObject({ id: derived.result.id, freshness: "stale" });
    const review = await call<MemoryReviewResult>(agent, "memory_service", {
      operation: "review",
      input: { kind: "stale" },
    });
    expect(review.result.items[0]?.record.id).toBe(derived.result.id);
    const humanReview = await agent.callTool({
      name: "command",
      arguments: { input: 'memory review {"kind":"stale"}' },
    });
    expect(JSON.stringify(humanReview)).toContain(derived.result.id);
    await call(agent, "memory_service", {
      operation: "reaffirm",
      id: derived.result.id,
      input: { expected_version: 1, dependency_versions: { [saved.result.id]: 2 } },
    });
    expect((await http.review(space, { kind: "stale" })).items).toHaveLength(0);
    const identity = { inputs: { task: "verify" }, model: "fixture:1", policy: "reviewed:1" };
    await call(agent, "memory_service", {
      operation: "cache_put",
      input: {
        ...identity,
        value: "supported result",
        records: [{ id: derived.result.id, version: 2 }],
        expires_at: Date.now() + 60000,
      },
    });
    expect(await http.cacheGet(space, identity)).toMatchObject({
      hit: true,
      value: "supported result",
    });
    await call(agent, "memory_service", { operation: "cache_delete", input: identity });
    expect(await http.cacheGet(space, identity)).toMatchObject({ hit: false });
    expect(
      (await call<{ schema: string }>(agent, "memory_service", { operation: "export_bundle" }))
        .result.schema,
    ).toBe("marina.memory.bundle.v2");
  } finally {
    resident?.disconnect();
    await agent.close();
    mcp.stop();
    ws.stop();
    await Bun.sleep(30);
    engine.stop();
    db.close();
    rmSync(directory, { recursive: true });
  }
}, 20000);

it("lets a fresh stdio MCP coding-agent process resume symbolic memory using only HTTP credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-memory-stdio-"));
  const runtime = serveMemory({ dbPath: join(directory, "memory.db"), port: 0 });
  const credential = runtime.db.issueMemoryCredential(
    runtime.db.ensurePrincipal({ type: "service", displayName: "coding-agent" }).principal_id,
  );
  const url = `http://127.0.0.1:${runtime.server.port}`;
  const http = new MarinaMemoryClient(url, credential.token);
  const space = (await http.createSpace("work")).id;
  const credentials = join(directory, "credentials.json");
  writeFileSync(credentials, JSON.stringify({ ...credential, spaceId: space }), { mode: 0o600 });
  let client: Client | undefined;
  const connect = async () => {
    const c = new Client({ name: "coding-agent-test", version: "1" });
    await c.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["run", resolve("scripts/memory-mcp.ts"), "--url", url, "--credentials", credentials],
        stderr: "pipe",
      }),
    );
    return c;
  };
  try {
    client = await connect();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "memory_service",
      "memory_remember",
      "memory_query",
      "memory_graph",
    ]);
    const source = await call<MemoryReceipt>(client, "memory_service", {
      operation: "capture",
      input: { content: { result: "exact evidence\n  preserved" }, session_id: "long-task" },
    });
    const receipt = await call<MemoryReceipt>(client, "memory_remember", {
      content: "Review is pending",
      source_ids: [source.result.id],
      claim: {
        subject: "task:123",
        predicate: "status",
        object: { kind: "literal", value: "review" },
      },
      key: "task-status",
    });
    await call(client, "memory_service", {
      operation: "save_checkpoint",
      id: "work",
      input: {
        expected_version: 0,
        source_cursor: source.result.seq,
        data: { record: receipt.result.id, next: "review" },
      },
    });
    await client.close();
    client = undefined;
    client = await connect();
    const checkpoint = await call<{ data: { record: string } }>(client, "memory_service", {
      operation: "checkpoint",
      id: "work",
    });
    expect(checkpoint.result.data.record).toBe(receipt.result.id);
    const query = await call<MemoryQueryResult>(client, "memory_query", {
      subject: "task:123",
      predicate: "status",
    });
    expect(query.result.results[0]?.source_ids).toEqual([source.result.id]);
    expect(query.result.results[0]?.claim?.object).toEqual({ kind: "literal", value: "review" });
    runtime.db.revokeWorkloadCredential(credential.credentialId);
    expect((await client.callTool({ name: "memory_query", arguments: {} })).isError).toBe(true);
  } finally {
    await client?.close();
    await runtime.close();
    rmSync(directory, { recursive: true });
  }
}, 20000);

it("runs the fetch-only TypeScript bundle in Node and the Python symbolic client against the public API", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-memory-portable-"));
  const runtime = serveMemory({ dbPath: join(directory, "memory.db"), port: 0 });
  const credential = runtime.db.issueMemoryCredential(
    runtime.db.ensurePrincipal({ type: "service", displayName: "portable" }).principal_id,
  );
  const url = `http://127.0.0.1:${runtime.server.port}`;
  const http = new MarinaMemoryClient(url, credential.token);
  const space = (await http.createSpace("portable")).id;
  const credentials = join(directory, "credentials.json");
  writeFileSync(credentials, JSON.stringify({ ...credential, spaceId: space }), { mode: 0o600 });
  async function run(args: string[]) {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [output, error, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(error).toBe("");
    expect(status).toBe(0);
    return JSON.parse(output.trim());
  }
  try {
    const built = await Bun.build({
      entrypoints: [resolve("src/sdk/memory.ts")],
      target: "browser",
      outdir: directory,
    });
    expect(built.success).toBe(true);
    const program = join(directory, "agent.mjs");
    writeFileSync(
      program,
      `import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {MarinaMemoryClient} from './memory.js';
const identity = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const client = new MarinaMemoryClient(process.argv[3], identity.token);
const space = identity.spaceId;
const saved = await client.remember(space, {content: 'portable across runtimes', claim: {subject: 'project:portable', predicate: 'works', object: {kind: 'literal', value: true}}}, 'portable-claim');
const query = await client.query(space, {subject: 'project:portable'});
assert.equal(query.results[0].id, saved.id);
assert.equal(query.results[0].claim.object.value, true);
console.log(JSON.stringify({id: saved.id, mode: query.mode}));`,
    );
    const node = await run(["node", program, credentials, url]);
    expect(node.mode).toBe("symbolic");
    const python = join(directory, "agent.py");
    writeFileSync(
      python,
      `import sys, json
sys.path.insert(0, ${JSON.stringify(resolve("src/sdk"))})
from marina_memory import MarinaMemory
with open(sys.argv[1]) as f: identity = json.load(f)
memory = MarinaMemory(sys.argv[2], identity['token'], identity['spaceId'])
batch = memory.capture_batch([{'content': 'Python original', 'key': 'python-original'}], key='python-batch')
assert memory.capture_batch([{'content': 'Python original', 'key': 'python-original'}], key='regrouped-python')['receipts'] == batch['receipts']
assert memory.source_range(batch['receipts'][0]['id'])['text'] == 'Python original'
found = memory.query(subject='project:portable', object={'kind': 'literal', 'value': True})
assert found['results'][0]['claim']['object']['value'] is True
graph = memory.graph('project:portable')
assert graph['edges'][0]['record']['id'] == found['results'][0]['id']
premise = memory.remember('old premise')
conclusion = memory.remember('derived', depends_on=[premise['id']])
memory.revise(premise['id'], 1, 'new premise')
assert memory.review(kind='stale')['items'][0]['record']['id'] == conclusion['id']
memory.reaffirm(conclusion['id'], 1, {premise['id']: 2})
assert memory.review(kind='stale')['items'] == []
import time
memory.cache_put({'task': 'python'}, 'model:1', 'policy:1', 'answer', int(time.time()*1000)+60000,
                 records=[{'id': conclusion['id'], 'version': 2}], key='python-cache')
assert memory.cache_get({'task': 'python'}, 'model:1', 'policy:1')['value'] == 'answer'
assert memory.acknowledge(['python-cache'])['acknowledged'] == ['python-cache']
assert memory.cache_delete({'task': 'python'}, 'model:1', 'policy:1')['removed'] is True
assert memory.cache_get({'task': 'python'}, 'model:1', 'policy:1')['hit'] is False
assert memory.export_bundle()['schema'] == 'marina.memory.bundle.v2'
assert memory.federation_mounts()['mounts'] == []

print(json.dumps({'id': found['results'][0]['id']}))
`,
    );
    expect((await run(["python3", python, credentials, url])).id).toBe(node.id);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true });
  }
}, 20000);

it("reads original sources across two real HTTP services without replication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-federation-wire-"));
  const local = serveMemory({ dbPath: join(directory, "local.db"), port: 0 });
  const remote = serveMemory({ dbPath: join(directory, "remote.db"), port: 0 });
  try {
    const principal = local.db.ensurePrincipal({
      type: "service",
      displayName: "local",
    }).principal_id;
    const remotePrincipal = remote.db.ensurePrincipal({
      type: "service",
      displayName: "remote",
    }).principal_id;
    const remoteCredential = remote.db.issueMemoryCredential(remotePrincipal);
    const client = new MarinaMemoryClient(
      `http://127.0.0.1:${local.server.port}`,
      local.db.issueMemoryCredential(principal).token,
    );
    const peer = new MarinaMemoryClient(
      `http://127.0.0.1:${remote.server.port}`,
      remoteCredential.token,
    );
    const space = (await client.createSpace("local")).id,
      peerSpace = (await peer.createSpace("remote")).id;
    const source = await peer.capture(peerSpace, "Federatedoriginal α🙂 exact evidence");
    local.service.federation.mount(principal, "evidence", peer, peerSpace);
    const results = await client.federatedSearch(space, {
      mounts: ["evidence"],
      query: "Federatedoriginal",
      kind: "sources",
    });
    expect(results.results[0]).toMatchObject({
      kind: "source",
      origin: { id: source.id, mount: "evidence" },
    });
    expect(
      (await client.federatedRead(space, { mount: "evidence", id: source.id, kind: "source" }))
        .result,
    ).toMatchObject({ text: "Federatedoriginal α🙂 exact evidence" });
    expect((await client.sources(space)).sources).toHaveLength(0);
    await peer.forget(peerSpace, { source_ids: [source.id] });
    await expect(
      client.federatedRead(space, { mount: "evidence", id: source.id, kind: "source" }),
    ).rejects.toMatchObject({ code: "peer_not_found", status: 404 });
    expect(
      (
        await client.federatedSearch(space, {
          mounts: ["evidence"],
          query: "Federatedoriginal",
          kind: "sources",
        })
      ).results,
    ).toHaveLength(0);
    remote.db.revokeWorkloadCredential(remoteCredential.credentialId);
    await expect(
      client.federatedSearch(space, {
        mounts: ["evidence"],
        query: "Federatedoriginal",
        kind: "sources",
      }),
    ).rejects.toMatchObject({ code: "federation_incomplete" });
  } finally {
    await local.close();
    await remote.close();
    rmSync(directory, { recursive: true });
  }
}, 10000);
