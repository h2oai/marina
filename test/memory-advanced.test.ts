// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { rotateMemoryBackups } from "../src/persistence/db-memory-backups";
import { translateMemoryExport } from "../src/sdk/memory-adapters";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { memoryPortableDigest } from "../src/sdk/memory-portable";

let directory: string,
  db: MarinaDB,
  raw: Database,
  service: MemoryService,
  client: MarinaMemoryClient,
  space: string,
  token: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marina-advanced-"));
  db = new MarinaDB(join(directory, "memory.db"));
  raw = (db as unknown as { db: Database }).db;
  service = new MemoryService(db);
  token = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "owner" }).principal_id,
  ).token;
  client = new MarinaMemoryClient("http://memory.test", token, 35000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  space = (await client.createSpace("advanced")).id;
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});

it("finds indexed evidence beyond 10,000 records without loading all heads", async () => {
  const repo = db.memoryRepository(),
    actor = db.verifyMemoryCredential(token)!;
  let last = "";
  raw.transaction(() => {
    for (let i = 0; i < 10010; i++)
      last = repo.remember(
        actor,
        space,
        { content: i === 10009 ? "uniqueneedle α🙂" : "background", subject: `task:${i}` },
        `large-${i}`,
      ).id;
  })();
  const heads = spyOn(service.repository, "heads").mockImplementation(() => {
    throw new Error("whole-space heads scan");
  });
  try {
    const result = await client.search(space, { query: "uniqueneedle" });
    expect(result.results.map((r) => r.id)).toEqual([last]);
    expect(result.coverage?.lexical_candidates).toBe(1);
    expect((await client.query(space, { subject: "task:10009" })).results[0]?.id).toBe(last);
  } finally {
    heads.mockRestore();
  }
}, 60000);

it("reviews changed premises and competing claims with stable pagination and explicit reaffirmation", async () => {
  const premise = await client.remember(space, { content: "old premise" });
  const derived = await client.remember(space, { content: "derived", depends_on: [premise.id] });
  await client.revise(space, premise.id, 1, { content: "new premise" });
  const stale = await client.review(space, { kind: "stale" });
  expect(stale.items[0]?.record.id).toBe(derived.id);
  expect(stale.items[0]?.premises).toEqual([
    { id: premise.id, pinned_version: 1, current_version: 2, state: "changed" },
  ]);
  await expect(client.reaffirm(space, derived.id, 1, { [premise.id]: 1 })).rejects.toMatchObject({
    code: "dependency_changed",
  });
  await client.reaffirm(space, derived.id, 1, { [premise.id]: 2 });
  expect((await client.review(space, { kind: "stale" })).items).toEqual([]);
  for (const [value, from, until] of [
    ["a", 0, 10],
    ["b", 5, 15],
    ["c", 15, 20],
  ] as const)
    await client.remember(space, {
      content: value,
      claim: { subject: "task", predicate: "state", object: { kind: "literal", value } },
      valid_time: { from, until },
    });
  const page = await client.review(space, { kind: "competing", limit: 1 });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.competing_records).toHaveLength(1);
  expect(page.next_cursor).not.toBeNull();
  const next = await client.review(space, {
    kind: "competing",
    limit: 1,
    cursor: page.next_cursor!,
  });
  expect(next.items).toHaveLength(1);
  expect(next.next_cursor).toBeNull();
  expect(next.items[0]?.record.id).not.toBe(page.items[0]?.record.id);
  await client.remember(space, { content: "changes read generation" });
  await expect(
    client.review(space, { kind: "competing", cursor: page.next_cursor! }),
  ).rejects.toMatchObject({ code: "query_changed" });
});

it("reuses exact work results only while pins, input/model/policy, expiration and authorization agree", async () => {
  const source = await client.capture(space, "original");
  const sourceRow = (await client.sources(space)).sources[0]!;
  const record = await client.remember(space, { content: "derived", source_ids: [source.id] });
  const identity = {
    inputs: { task: "build", args: ["test"] },
    model: "router:model@revision",
    policy: "tests-v1",
  };
  const put = {
    ...identity,
    value: { passed: 4 },
    records: [{ id: record.id, version: 1 }],
    sources: [{ id: source.id, content_hash: sourceRow.content_hash }],
    expires_at: Date.now() + 60000,
  };
  const receipt = await client.cachePut(space, put, "cache-put");
  expect(await client.cachePut(space, put, "cache-put")).toEqual(receipt);
  await client.saveCheckpoint(space, receipt.id, 0, {
    value: "ordinary checkpoint cannot forge cached outputs",
  });
  expect((await client.checkpoint(space, receipt.id)).data.value).toBe(
    "ordinary checkpoint cannot forge cached outputs",
  );
  expect(await client.cacheGet(space, identity)).toMatchObject({ hit: true, value: { passed: 4 } });
  expect(await client.cacheGet(space, { ...identity, policy: "new-policy" })).toMatchObject({
    hit: false,
  });
  const clock = spyOn(Date, "now").mockReturnValue(put.expires_at + 1);
  try {
    expect(await client.cacheGet(space, identity)).toMatchObject({ hit: false, reason: "expired" });
  } finally {
    clock.mockRestore();
  }
  await client.revise(space, record.id, 1, { content: "corrected" });
  expect(await client.cacheGet(space, identity)).toMatchObject({ hit: false });
  await expect(
    client.cachePut(space, { ...put, expires_at: Date.now() + 60000 }, "old-basis"),
  ).rejects.toMatchObject({ code: "cache_basis_changed" });
  await client.cachePut(space, { ...put, records: [{ id: record.id, version: 2 }] }, "new-basis");
  await client.forget(space, { source_ids: [source.id] });
  expect(await client.cacheGet(space, identity)).toMatchObject({ hit: false, reason: "missing" });
  const credential = db.verifyMemoryCredential(token)!;
  db.revokeWorkloadCredential(credential.credentialId);
  await expect(client.cacheGet(space, identity)).rejects.toMatchObject({ status: 401 });
});

it("compacts only acknowledged receipts and permanently refuses retired request keys", async () => {
  const source = await client.capture(space, "unresolved", undefined, "unresolved");
  const batch = await client.captureBatch(
    space,
    Array.from({ length: 10 }, (_, i) => ({ content: `item ${i}`, key: `item-${i}` })),
    "acknowledged",
  );
  expect(await client.acknowledge(space, ["acknowledged", "absent"])).toEqual({
    acknowledged: ["acknowledged"],
    missing: ["absent"],
  });
  const before = (await client.usage()).usage.logical_bytes;
  const plan = db.compactMemoryReceipts({ before: Date.now() });
  expect(plan.selected).toBe(1);
  expect(plan.applied).toBe(false);
  expect(
    await client.captureBatch(
      space,
      Array.from({ length: 10 }, (_, i) => ({ content: `item ${i}`, key: `item-${i}` })),
      "acknowledged",
    ),
  ).toEqual(batch);
  expect(db.compactMemoryReceipts({ before: Date.now(), apply: true }).selected).toBe(1);
  expect((await client.usage()).usage.logical_bytes).toBeLessThan(before);
  await expect(
    client.captureBatch(
      space,
      Array.from({ length: 10 }, (_, i) => ({ content: `item ${i}`, key: `item-${i}` })),
      "acknowledged",
    ),
  ).rejects.toMatchObject({ code: "receipt_retired", status: 410 });
  expect(await client.capture(space, "unresolved", undefined, "unresolved")).toEqual(source);
  expect((await client.sources(space)).sources).toHaveLength(11);
});

it("rotates only verified managed snapshots and preserves backups on failed publication", async () => {
  const backups = join(directory, "backups");
  const first = await rotateMemoryBackups(join(directory, "memory.db"), backups, 2);
  writeFileSync(join(backups, "operator-file.db"), "untouched");
  await rotateMemoryBackups(join(directory, "memory.db"), backups, 2);
  const third = await rotateMemoryBackups(join(directory, "memory.db"), backups, 2);
  expect(third.retained).toHaveLength(2);
  expect(third.removed).toHaveLength(1);
  expect(existsSync(first.snapshot.destination)).toBe(false);
  expect(existsSync(join(backups, "operator-file.db"))).toBe(true);
  const files = readdirSync(backups).sort();
  await expect(rotateMemoryBackups(join(directory, "missing.db"), backups, 1)).rejects.toThrow();
  expect(readdirSync(backups).sort()).toEqual(files);
});

it("round-trips original source IDs, byte ranges, revision history, stale state and checkpoints between independent services", async () => {
  const source = await client.capture(
    space,
    { text: "α🙂  exact\nsource", code: "secret" },
    "session",
  );
  const premise = await client.remember(space, { content: "first", source_ids: [source.id] });
  const derived = await client.remember(space, { content: "conclusion", depends_on: [premise.id] });
  await client.revise(space, premise.id, 1, { content: "second" });
  await client.saveCheckpoint(space, "resume", 0, { original: source.id }, source.seq, undefined, [
    source.id,
  ]);
  const bundle = await client.exportBundle(space),
    destination = new MarinaDB(join(directory, "destination.db"));
  try {
    const svc = new MemoryService(destination),
      credential = destination.issueMemoryCredential(
        destination.ensurePrincipal({ type: "service", displayName: "new-owner" }).principal_id,
      );
    const other = new MarinaMemoryClient("http://other.test", credential.token, 35000, (req) =>
      handleMemoryServiceApi(req, svc),
    );
    const empty = (await other.createSpace("invalid")).id;
    const malformed = structuredClone(bundle) as {
      payload: { records: { versions: { attributes: Record<string, unknown> }[] }[] };
      sha256: string;
    };
    malformed.payload.records[0]!.versions[0]!.attributes.source_ids = ["missing-source"];
    malformed.sha256 = await memoryPortableDigest(malformed.payload);
    await expect(other.importBundle(empty, malformed, "invalid")).rejects.toMatchObject({
      code: "invalid_bundle",
    });
    expect((await other.sources(empty)).sources).toHaveLength(0);
    expect((await other.query(empty)).results).toHaveLength(0);
    const target = (await other.createSpace("import")).id;
    const receipt = await other.importBundle(target, bundle, "import");
    expect(receipt.portable_ids_preserved).toBe(true);
    expect(await other.importBundle(target, bundle, "import")).toEqual(receipt);
    expect((await other.sourceRange(target, source.id)).text).toBe(
      (await client.sourceRange(space, source.id)).text,
    );
    expect((await other.get(target, premise.id, 1)).content).toBe("first");
    expect((await other.get(target, premise.id)).content).toBe("second");
    expect((await other.get(target, derived.id)).freshness).toBe("stale");
    expect((await other.checkpoint(target, "resume")).data).toEqual({ original: source.id });
    await other.forget(target, { source_ids: [source.id] });
    await expect(other.get(target, derived.id)).rejects.toMatchObject({ status: 404 });
  } finally {
    destination.close();
  }
});

it("imports named MCP graph and LangGraph item exports with explicit loss reports and verbatim originals", async () => {
  const graph = {
    entities: [
      { name: "gateway", entityType: "service", observations: ["uses retries"] },
      { name: "auth", entityType: "service", observations: [] },
    ],
    relations: [{ from: "gateway", to: "auth", relationType: "depends" }],
  };
  const translated = await translateMemoryExport("mcp-knowledge-graph-v1", graph, {
    origin: "graph:one",
    imported_at: 100,
  });
  expect(translated.losses.length).toBeGreaterThan(0);
  await client.importBundle(space, translated.bundle, "graph-import");
  expect(
    (await client.graph(space, { subject: "gateway", predicates: ["depends"] })).edges[0]?.record
      .claim?.object,
  ).toEqual({ kind: "entity", id: "auth" });
  expect((await client.sources(space)).sources[0]?.body).toEqual(graph);
  const target = (await client.createSpace("items")).id;
  const items = [{ namespace: ["user", "one"], key: "preference", value: { color: "blue" } }];
  const imported = await translateMemoryExport("langgraph-items-v1", items, {
    origin: "store:one",
    imported_at: 100,
  });
  await client.importBundle(target, imported.bundle, "items-import");
  expect(
    (await client.query(target, { subject: 'langgraph:["user","one","preference"]' })).results[0]
      ?.metadata.value,
  ).toEqual({ color: "blue" });
});

it("federates only explicitly selected principal mounts and observes peer revocation and forgetting", async () => {
  const peerDb = new MarinaDB(join(directory, "peer.db"));
  try {
    const peerService = new MemoryService(peerDb),
      owner = peerDb.ensurePrincipal({ type: "service", displayName: "peer-owner" }).principal_id;
    const credential = peerDb.issueMemoryCredential(owner),
      peer = new MarinaMemoryClient("http://peer.test", credential.token, 35000, (req) =>
        handleMemoryServiceApi(req, peerService),
      );
    const remote = (await peer.createSpace("peer")).id,
      record = await peer.remember(remote, { content: "federated needle" });
    const localOwner = db.verifyMemoryCredential(token)!.principalId;
    service.federation.mount(localOwner, "research", peer, remote);
    expect(await client.federationMounts(space)).toEqual({ mounts: ["research"] });
    await expect(
      client.federatedSearch(space, { mounts: ["unmounted"], query: "needle" }),
    ).rejects.toMatchObject({ code: "mount_not_found" });
    const found = await client.federatedSearch(space, { mounts: ["research"], query: "needle" });
    expect(found.results).toMatchObject([
      { origin: { mount: "research", id: record.id }, record: { content: "federated needle" } },
    ]);
    await peer.forget(remote, { record_ids: [record.id] });
    expect(
      (await client.federatedSearch(space, { mounts: ["research"], query: "needle" })).results,
    ).toEqual([]);
    peerDb.revokeWorkloadCredential(credential.credentialId);
    await expect(
      client.federatedSearch(space, { mounts: ["research"], query: "needle" }),
    ).rejects.toMatchObject({ code: "federation_incomplete" });
    expect(
      await client.federatedSearch(space, {
        mounts: ["research"],
        query: "needle",
        allow_partial: true,
      }),
    ).toMatchObject({
      incomplete: true,
      results: [],
      failures: [{ mount: "research", code: "invalid_credential" }],
    });
    expect((await client.sources(space)).sources).toHaveLength(0);
  } finally {
    peerDb.close();
  }
});

it("rejects bundle attribute forgery and cyclic heads atomically", async () => {
  const first = await client.remember(space, { content: "one" });
  const second = await client.remember(space, { content: "two" });
  const original = await client.exportBundle(space);
  const destination = new MarinaDB(join(directory, "adversarial.db"));
  try {
    const svc = new MemoryService(destination);
    const owner = destination.ensurePrincipal({
      type: "service",
      displayName: "importer",
    }).principal_id;
    const other = new MarinaMemoryClient(
      "http://other.test",
      destination.issueMemoryCredential(owner).token,
      35000,
      (req) => handleMemoryServiceApi(req, svc),
    );
    const target = (await other.createSpace("target")).id;
    const forged = structuredClone(original);
    forged.payload.records[0]!.versions[0]!.attributes!.id = "forged-authority";
    forged.sha256 = await memoryPortableDigest(forged.payload);
    await expect(other.importBundle(target, forged, "forged")).rejects.toMatchObject({
      code: "invalid_bundle",
    });
    const cycle = structuredClone(original);
    for (const record of cycle.payload.records) {
      const parent = record.id === first.id ? second.id : first.id;
      record.versions[0]!.attributes!.depends_on = [parent];
      record.versions[0]!.attributes!.dependency_versions = { [parent]: 1 };
    }
    cycle.sha256 = await memoryPortableDigest(cycle.payload);
    await expect(other.importBundle(target, cycle, "cycle")).rejects.toMatchObject({
      code: "invalid_bundle",
    });
    expect((await other.query(target)).results).toHaveLength(0);
    expect((await other.sources(target)).sources).toHaveLength(0);
    await other.importBundle(target, original, "good");
    expect((await other.query(target)).results).toHaveLength(2);
  } finally {
    destination.close();
  }
});

it("pages optional reindex work and rejects cursors after evidence changes", async () => {
  for (let i = 0; i < 5; i++) await client.remember(space, { content: `record ${i}` });
  const actor = db.verifyMemoryCredential(token)!;
  const repo = db.memoryRepository();
  const first = repo.reindex(
    actor,
    space,
    (await client.space(space)).generation,
    "fixture:v1",
    "index-1",
    { limit: 2 },
  );
  expect(first.job_ids).toHaveLength(2);
  expect(first.next_cursor).not.toBeNull();
  expect(
    repo.reindex(actor, space, first.generation - 1, "fixture:v1", "index-1", { limit: 2 }),
  ).toEqual(first);
  const second = repo.reindex(actor, space, first.generation, "fixture:v1", "index-2", {
    limit: 2,
    cursor: first.next_cursor!,
  });
  expect(second.job_ids).toHaveLength(2);
  const last = repo.reindex(actor, space, second.generation, "fixture:v1", "index-3", {
    limit: 2,
    cursor: second.next_cursor!,
  });
  expect(last.job_ids).toHaveLength(1);
  expect(last.next_cursor).toBeNull();
  expect(new Set([...first.job_ids, ...second.job_ids, ...last.job_ids]).size).toBe(5);
  await client.remember(space, { content: "new generation" });
  expect(() =>
    repo.reindex(actor, space, repo.authorize(actor, space).generation, "fixture:v1", "stale", {
      cursor: second.next_cursor!,
    }),
  ).toThrow("Evidence changed");
});

it("rechecks local authorization, mount identity and cancellation after federated waits", async () => {
  const localOwner = db.verifyMemoryCredential(token)!.principalId;
  let started!: () => void, resume!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const slow = new MarinaMemoryClient("http://peer.test", "peer-only-token", 35000, async () => {
    started();
    await hold;
    return Response.json({ results: [], generation: 1, mode: "lexical" });
  });
  service.federation.mount(localOwner, "slow", slow, "peer");
  const pending = client.federatedSearch(space, { mounts: ["slow"], query: "needle" });
  await ready;
  service.federation.unmount(localOwner, "slow");
  resume();
  await expect(pending).rejects.toMatchObject({ code: "mount_changed" });
  service.federation.mount(localOwner, "slow", slow, "peer");
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(
    client
      .withSignal(controller.signal)
      .federatedSearch(space, { mounts: ["slow"], query: "needle" }),
  ).rejects.toThrow("cancelled");
  const revoked = new MarinaMemoryClient("http://peer.test", "peer-only-token", 35000, async () => {
    db.revokeWorkloadCredential(db.verifyMemoryCredential(token)!.credentialId);
    return Response.json({ results: [], generation: 1, mode: "lexical" });
  });
  service.federation.mount(localOwner, "revoker", revoked, "peer");
  await expect(
    client.federatedSearch(space, { mounts: ["revoker"], query: "needle" }),
  ).rejects.toMatchObject({ status: 401 });
});

it("accounts cached outputs and isolates identical keys between shared writers", async () => {
  const premise = await client.remember(space, { content: "shared evidence" });
  const writer = db.ensurePrincipal({ type: "service", displayName: "writer" }).principal_id;
  await client.grant(space, writer, "writer");
  const other = new MarinaMemoryClient(
    "http://memory.test",
    db.issueMemoryCredential(writer).token,
    35000,
    (req) => handleMemoryServiceApi(req, service),
  );
  const identity = { inputs: { task: "same" }, model: "model:v1", policy: "policy:v1" };
  const basis = {
    ...identity,
    records: [{ id: premise.id, version: 1 }],
    expires_at: Date.now() + 60000,
  };
  const before = (await client.usage()).usage.logical_bytes;
  await client.cachePut(space, { ...basis, value: "owner's result" }, "owner-cache");
  expect((await client.usage()).usage.logical_bytes).toBeGreaterThan(before);
  expect(await other.cacheGet(space, identity)).toMatchObject({ hit: false });
  await other.cachePut(space, { ...basis, value: "writer's result" }, "writer-cache");
  expect(await client.cacheGet(space, identity)).toMatchObject({
    hit: true,
    value: "owner's result",
  });
  expect(await other.cacheGet(space, identity)).toMatchObject({
    hit: true,
    value: "writer's result",
  });
  const projected = raw
    .query("SELECT sum(bytes) AS bytes FROM memory_storage_projection WHERE space_id=?")
    .get(space) as { bytes: number };
  expect((await client.usage()).usage.logical_bytes).toBe(projected.bytes);
  expect((await client.exportBundle(space)).payload.checkpoints).toHaveLength(0);
  await client.forget(space, { record_ids: [premise.id] });
  expect(await client.cacheGet(space, identity)).toMatchObject({ hit: false });
  expect(await other.cacheGet(space, identity)).toMatchObject({ hit: false });
});

it("acknowledges and retires space-creation receipts without losing owner accounting", async () => {
  const created = await client.createSpace("retention", "created-space");
  expect((await client.acknowledge(created.id, ["created-space"])).acknowledged).toEqual([
    "created-space",
  ]);
  expect(db.compactMemoryReceipts({ before: Date.now(), apply: true }).selected).toBe(1);
  await expect(client.createSpace("retention", "created-space")).rejects.toMatchObject({
    code: "receipt_retired",
  });
  const projected = raw
    .query("SELECT sum(bytes) AS bytes FROM memory_storage_projection")
    .get() as { bytes: number };
  expect((await client.usage()).usage.logical_bytes).toBe(projected.bytes);
  const generation = (await client.space(created.id)).generation;
  await client.forget(
    created.id,
    { all: true, expected_generation: generation },
    "forgotten-space",
  );
  expect((await client.acknowledge(created.id, ["forgotten-space"])).acknowledged).toEqual([
    "forgotten-space",
  ]);
});

it("deletes cached results idempotently without deleting authored evidence or another writer's cache", async () => {
  const record = await client.remember(space, { content: "keep original memory" });
  const source = await client.capture(space, "keep original source");
  const writer = db.ensurePrincipal({ type: "service", displayName: "cache-writer" }).principal_id;
  await client.grant(space, writer, "writer");
  const other = new MarinaMemoryClient(
    "http://memory.test",
    db.issueMemoryCredential(writer).token,
    35000,
    (req) => handleMemoryServiceApi(req, service),
  );
  const identity = { inputs: "same task", model: "model:1", policy: "policy:1" };
  const value = {
    ...identity,
    value: "cached output",
    records: [{ id: record.id, version: 1 }],
    expires_at: Date.now() + 60000,
  };
  await client.cachePut(space, value);
  await other.cachePut(space, value);
  const deletion = await client.cacheDelete(space, identity, "delete-cache");
  expect(deletion.removed).toBe(true);
  expect(await client.cacheDelete(space, identity, "delete-cache")).toEqual(deletion);
  expect(await client.cacheGet(space, identity)).toMatchObject({ hit: false });
  expect(await other.cacheGet(space, identity)).toMatchObject({ hit: true });
  expect((await client.get(space, record.id)).content).toBe("keep original memory");
  expect((await client.sourceRange(space, source.id)).text).toBe("keep original source");
});
