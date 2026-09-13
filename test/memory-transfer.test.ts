// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { configureMemoryStorage } from "../src/persistence/db-memory-storage";
import { exportState, importState } from "../src/persistence/export-import";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { memoryPortableDigest } from "../src/sdk/memory-portable";
import { retryMemoryOperation } from "../src/sdk/memory-retry";
import type { MemoryTransferPage } from "../src/sdk/memory-transfer";
import { resumeMemoryTransfer } from "../src/sdk/memory-transfer-client";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture(name: string) {
  const directory = mkdtempSync(join(tmpdir(), "marina-transfer-"));
  let db = new MarinaDB(join(directory, "memory.db")),
    service = new MemoryService(db);
  const owner = db.ensurePrincipal({ type: "service", displayName: name }).principal_id;
  const credential = db.issueMemoryCredential(owner);
  const client = new MarinaMemoryClient(`http://${name}.test`, credential.token, 130000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  const space = (await client.createSpace(name)).id;
  const get = () => ({
    db,
    service,
    actor: db.verifyMemoryCredential(credential.token)!,
    raw: (db as unknown as { db: Database }).db,
  });
  cleanups.push(async () => {
    await service.close();
    db.close();
    rmSync(directory, { recursive: true });
  });
  return {
    client,
    space,
    credential,
    owner,
    get,
    snapshotRoundTrip() {
      const snapshot = exportState(join(directory, "memory.db"));
      db.close();
      const result = importState(join(directory, "memory.db"), snapshot);
      db = new MarinaDB(join(directory, "memory.db"));
      service = new MemoryService(db);
      return result;
    },
    restart() {
      db.close();
      db = new MarinaDB(join(directory, "memory.db"));
      service = new MemoryService(db);
    },
  };
}
async function sign(page: MemoryTransferPage) {
  const { sha256: _, next_cursor: __, ...payload } = page;
  return { ...page, sha256: await memoryPortableDigest(payload) };
}

it("transfers more than 2,000 records and 1.5 MiB with exact history, bounded pages and restart resume", async () => {
  const source = await fixture("source"),
    destination = await fixture("destination");
  const { service, actor, raw } = source.get(),
    repo = service.repository;
  const text = 'Original α🙂 evidence with quotations " and slash \\ \n'.repeat(13000);
  const original = repo.capture(actor, source.space, text, "large", "source");
  const first = repo.remember(
    actor,
    source.space,
    { content: "old premise", source_ids: [original.id] },
    "first",
  );
  const derived = repo.remember(
    actor,
    source.space,
    { content: "derived", depends_on: [first.id] },
    "derived",
  );
  repo.revise(
    actor,
    source.space,
    first.id,
    1,
    { content: "corrected premise", source_ids: [original.id] },
    "revise",
  );
  raw.transaction(() => {
    for (let i = 0; i < 2100; i++)
      repo.remember(
        actor,
        source.space,
        {
          content: `record-${i} ${"bounded portable evidence ".repeat(20)}`,
          subject: `subject-${i}`,
        },
        `row-${i}`,
      );
    for (let i = 0; i < 2003; i++)
      repo.revise(
        actor,
        source.space,
        first.id,
        i + 2,
        { content: "corrected premise", source_ids: [original.id] },
        `history-${i}`,
      );
  })();
  repo.checkpoint(
    actor,
    source.space,
    "resume",
    0,
    { source: original.id, record: first.id },
    original.seq!,
    "checkpoint",
    [original.id],
  );
  await expect(source.client.exportBundle(source.space)).rejects.toMatchObject({
    code: "bundle_capacity",
  });
  let page = await source.client.exportTransferPage(source.space);
  let state = await destination.client.beginTransfer(destination.space, page.header, "begin");
  const transfer = state.id;
  let pages = 0,
    total = 0;
  for (;;) {
    const { sha256, next_cursor: _, ...payload } = page;
    expect(await memoryPortableDigest(payload)).toBe(sha256);
    const bytes = page.fragments.reduce(
      (sum, p) => sum + Buffer.from(p.base64, "base64").length,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(262144);
    total += bytes;
    state = await retryMemoryOperation(() =>
      destination.client.appendTransfer(destination.space, transfer, page, `page-${page.position}`),
    );
    if (pages++ === 0) {
      expect(
        (await destination.client.search(destination.space, { query: "premise" })).results,
      ).toHaveLength(0);
      destination.restart();
      expect(await destination.client.transferStatus(destination.space, transfer)).toMatchObject({
        position: state.position,
        sha256: state.sha256,
      });
      expect(
        await destination.client.appendTransfer(
          destination.space,
          transfer,
          page,
          `page-${page.position}`,
        ),
      ).toEqual(state);
      const usage = (await destination.client.usage()).usage;
      expect(destination.snapshotRoundTrip().errors).toEqual([]);
      expect((await destination.client.usage()).usage).toEqual(usage);
    }
    if (page.done) break;
    page = await retryMemoryOperation(() =>
      source.client.exportTransferPage(source.space, state.next_cursor!),
    );
  }
  expect(total).toBeGreaterThan(1572864);
  expect(pages).toBeGreaterThan(2);
  const receipt = await destination.client.commitTransfer(
    destination.space,
    transfer,
    state.sha256,
    "commit",
  );
  expect(
    await destination.client.commitTransfer(destination.space, transfer, state.sha256, "commit"),
  ).toEqual(receipt);
  expect((await destination.client.get(destination.space, first.id, 1)).content).toBe(
    "old premise",
  );
  expect((await destination.client.get(destination.space, first.id)).content).toBe(
    "corrected premise",
  );
  expect((await destination.client.get(destination.space, derived.id)).freshness).toBe("stale");
  expect(
    (await destination.client.sources(destination.space)).sources.find((s) => s.id === original.id)
      ?.body,
  ).toBe(text);
  expect((await destination.client.checkpoint(destination.space, "resume")).data).toEqual({
    source: original.id,
    record: first.id,
  });
  expect(
    (await destination.client.exportTransferPage(destination.space)).header.counts.record,
  ).toBe(2102);
  expect(destination.get().raw.query("SELECT count(*) n FROM memory_transfer_parts").get()).toEqual(
    { n: 0 },
  );
  await expect(destination.client.abortTransfer(destination.space, transfer)).rejects.toMatchObject(
    { code: "transfer_committed" },
  );
  // Includes fixture creation, thousands of revisions, transfer/restart and
  // publication. The service independently enforces its 120-second writer limit.
}, 180000);

it("rolls back invalid dependency history at publication and detects changed staged bytes", async () => {
  const source = await fixture("source"),
    destination = await fixture("destination");
  const record = await source.client.remember(source.space, { content: "authored" });
  const page = await source.client.exportTransferPage(source.space);
  expect(page.done).toBe(true);
  const broken = await sign({
    ...page,
    fragments: page.fragments.map((part) => {
      if (part.kind !== "revision") return part;
      const value = JSON.parse(Buffer.from(part.base64, "base64").toString());
      value.attributes.depends_on = [record.id];
      value.attributes.dependency_versions = { [record.id]: 1 };
      const bytes = Buffer.from(JSON.stringify(value));
      return {
        ...part,
        base64: bytes.toString("base64"),
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  });
  const first = await destination.client.beginTransfer(destination.space, page.header);
  await destination.client.appendTransfer(destination.space, first.id, broken);
  await expect(
    destination.client.commitTransfer(destination.space, first.id, broken.sha256),
  ).rejects.toMatchObject({ code: "invalid_bundle" });
  expect(
    (await destination.client.search(destination.space, { query: "authored" })).results,
  ).toEqual([]);
  expect(
    destination
      .get()
      .raw.query("SELECT count(*) n FROM memory_records WHERE space_id=?")
      .get(destination.space),
  ).toEqual({ n: 0 });
  await destination.client.abortTransfer(destination.space, first.id);
  const second = await destination.client.beginTransfer(destination.space, page.header);
  await destination.client.appendTransfer(destination.space, second.id, page);
  destination
    .get()
    .raw.run("UPDATE memory_transfer_parts SET data=? WHERE transfer_id=? AND kind='revision'", [
      Buffer.from("{}").toString("base64"),
      second.id,
    ]);
  await expect(
    destination.client.commitTransfer(destination.space, second.id, page.sha256),
  ).rejects.toMatchObject({ code: "invalid_transfer" });
  expect((await destination.client.sources(destination.space)).sources).toEqual([]);
});

it("rejects changed source generations, revoked export access and forged/cross-space cursors", async () => {
  const source = await fixture("source"),
    other = await fixture("other");
  source
    .get()
    .service.repository.capture(
      source.get().actor,
      source.space,
      "x".repeat(600000),
      undefined,
      "large",
    );
  const page = await source.client.exportTransferPage(source.space);
  expect(page.done).toBe(false);
  await expect(
    other.client.exportTransferPage(other.space, page.next_cursor!),
  ).rejects.toMatchObject({ code: "transfer_changed" });
  await source.client.remember(source.space, { content: "new write" });
  await expect(
    source.client.exportTransferPage(source.space, page.next_cursor!),
  ).rejects.toMatchObject({ code: "transfer_changed" });
  source.get().db.revokeWorkloadCredential(source.credential.credentialId);
  await expect(
    source.client.exportTransferPage(source.space, page.next_cursor!),
  ).rejects.toMatchObject({ status: 401 });
});

it("rejects missing/out-of-order/corrupt pages and publishes nothing on invalid history", async () => {
  const source = await fixture("source"),
    destination = await fixture("destination");
  const original = await source.client.capture(source.space, "x".repeat(600000));
  await source.client.remember(source.space, { content: "record", source_ids: [original.id] });
  const page = await source.client.exportTransferPage(source.space);
  const transfer = await destination.client.beginTransfer(destination.space, page.header);
  const second = await source.client.exportTransferPage(source.space, page.next_cursor!);
  await expect(
    destination.client.appendTransfer(destination.space, transfer.id, second),
  ).rejects.toMatchObject({ code: "transfer_order" });
  await expect(
    destination.client.appendTransfer(destination.space, transfer.id, { ...page, sha256: "bad" }),
  ).rejects.toMatchObject({ code: "invalid_transfer" });
  const forged = await sign({
    ...page,
    fragments: page.fragments.map((p, i) => (i ? p : { ...p, offset: 1 })),
  });
  await expect(
    destination.client.appendTransfer(destination.space, transfer.id, forged),
  ).rejects.toMatchObject({ code: "invalid_transfer" });
  const state = await destination.client.appendTransfer(
    destination.space,
    transfer.id,
    page,
    "valid",
  );
  await expect(
    destination.client.commitTransfer(destination.space, transfer.id, state.sha256),
  ).rejects.toMatchObject({ code: "transfer_inactive" });
  const before = (await destination.client.usage()).usage.logical_bytes;
  await destination.client.abortTransfer(destination.space, transfer.id, "abort");
  expect((await destination.client.usage()).usage.logical_bytes).toBeLessThan(before);
  expect((await destination.client.sources(destination.space)).sources).toEqual([]);
  expect(destination.get().raw.query("SELECT count(*) n FROM memory_transfer_parts").get()).toEqual(
    { n: 0 },
  );
});

it("accounts staged bytes, refuses quota growth and lets the owner abort at the limit", async () => {
  const source = await fixture("source"),
    destination = await fixture("destination");
  await source.client.capture(source.space, "x".repeat(600000));
  const page = await source.client.exportTransferPage(source.space);
  const transfer = await destination.client.beginTransfer(destination.space, page.header);
  configureMemoryStorage(destination.get().raw, {
    logical_bytes: (await destination.client.usage()).usage.logical_bytes + 1000,
  });
  await expect(
    destination.client.appendTransfer(destination.space, transfer.id, page, "too-large"),
  ).rejects.toMatchObject({ code: "quota_exceeded" });
  expect((await destination.client.transferStatus(destination.space, transfer.id)).position).toBe(
    0,
  );
  expect(destination.get().raw.query("SELECT count(*) n FROM memory_transfer_parts").get()).toEqual(
    { n: 0 },
  );
  await destination.client.abortTransfer(destination.space, transfer.id);
  expect((await destination.client.transferStatus(destination.space, transfer.id)).state).toBe(
    "aborted",
  );
});

it("keeps staging owner-only, rejects expired writes, and cleans staged content on explicit forgetting", async () => {
  const source = await fixture("source"),
    destination = await fixture("destination");
  await source.client.capture(source.space, "x".repeat(600000));
  const page = await source.client.exportTransferPage(source.space);
  const transfer = await destination.client.beginTransfer(destination.space, page.header);
  await destination.client.appendTransfer(destination.space, transfer.id, page);
  const { db, service, raw } = destination.get();
  const reader = db.ensurePrincipal({ type: "service", displayName: "reader" }).principal_id;
  const credential = db.issueMemoryCredential(reader);
  const shared = new MarinaMemoryClient("http://destination.test", credential.token, 35000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  await destination.client.grant(destination.space, reader, "writer");
  await expect(shared.transferStatus(destination.space, transfer.id)).rejects.toMatchObject({
    code: "transfer_not_found",
  });
  await expect(shared.beginTransfer(destination.space, page.header)).rejects.toMatchObject({
    code: "owner_required",
  });
  await expect(shared.transfers(destination.space)).rejects.toMatchObject({
    code: "owner_required",
  });
  raw.run("UPDATE memory_transfers SET expires_at=0 WHERE id=?", [transfer.id]);
  expect(
    (await destination.client.transfers(destination.space, { expired: true })).transfers.map(
      (t) => t.id,
    ),
  ).toEqual([transfer.id]);
  expect(
    (await destination.client.transfers(destination.space, { expired: false })).transfers,
  ).toEqual([]);
  const next = await source.client.exportTransferPage(source.space, page.next_cursor!);
  await expect(
    destination.client.appendTransfer(destination.space, transfer.id, next),
  ).rejects.toMatchObject({ code: "transfer_inactive" });
  expect(
    (await destination.client.transferStatus(destination.space, transfer.id)).bytes,
  ).toBeGreaterThan(0);
  await destination.client.forget(destination.space, {
    all: true,
    expected_generation: (await destination.client.space(destination.space)).generation,
  });
  await expect(
    destination.client.transferStatus(destination.space, transfer.id),
  ).rejects.toMatchObject({ code: "space_forgotten" });
  expect(raw.query("SELECT state FROM memory_transfers WHERE id=?").get(transfer.id)).toEqual({
    state: "aborted",
  });
  expect(raw.query("SELECT count(*) n FROM memory_transfer_parts").get()).toEqual({ n: 0 });
});

it("discovers lost transfer IDs, pages status and resumes from the durable source cursor", async () => {
  const source = await fixture("source"),
    destination = await fixture("destination");
  await source.client.capture(source.space, "original 🙂".repeat(50000));
  const first = await source.client.exportTransferPage(source.space);
  const abandoned = await destination.client.beginTransfer(destination.space, first.header);
  await destination.client.abortTransfer(destination.space, abandoned.id);
  const started = await destination.client.beginTransfer(destination.space, first.header);
  await destination.client.appendTransfer(destination.space, started.id, first);
  destination.restart();
  const listing = await destination.client.transfers(destination.space, { limit: 1 });
  expect(listing.transfers).toHaveLength(1);
  const rest = await destination.client.transfers(destination.space, {
    limit: 1,
    cursor: listing.next_cursor!,
  });
  expect(new Set([...listing.transfers, ...rest.transfers].map((t) => t.id))).toEqual(
    new Set([abandoned.id, started.id]),
  );
  expect(rest.next_cursor).toBeNull();
  const recovered = (await destination.client.transfers(destination.space, { state: "receiving" }))
    .transfers[0]!;
  expect(recovered.next_cursor).toBe(first.next_cursor);
  await expect(
    resumeMemoryTransfer(destination.client, destination.space, recovered.id),
  ).rejects.toMatchObject({ code: "source_required" });
  const complete = await resumeMemoryTransfer(destination.client, destination.space, recovered.id, {
    source: source.client,
  });
  expect(complete.state).toBe("committed");
  expect(await resumeMemoryTransfer(destination.client, destination.space, recovered.id)).toEqual(
    complete,
  );
  await expect(
    destination.client.transfers(destination.space, { state: "invalid" as "ready" }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    destination.client.transfers(destination.space, { limit: 101 }),
  ).rejects.toMatchObject({ code: "invalid_input" });
});

it("keeps another tenant's reads live during publication, rejects writers and recovers after cancellation", async () => {
  const source = await fixture("source"),
    destination = await fixture("destination");
  await source.client.capture(source.space, "evidence".repeat(50000));
  const bundle = await source.client.exportBundle(source.space);
  const { db, service, actor, raw } = destination.get();
  const other = db.ensurePrincipal({ type: "service", displayName: "other" });
  const credential = db.issueMemoryCredential(other.principal_id);
  const tenant = db.verifyMemoryCredential(credential.token)!;
  const space = service.repository.createSpace(tenant, "other", "space").id;
  const record = service.repository.remember(
    tenant,
    space,
    { content: "unchanged evidence" },
    "remember",
  );
  const prior = raw.query("PRAGMA busy_timeout").get();
  const controller = new AbortController();
  const publication = service.importBundle(
    actor,
    destination.space,
    bundle,
    "publication",
    controller.signal,
  );
  expect(service.repository.read(tenant, space, record.id).content).toBe("unchanged evidence");
  expect(() => service.repository.remember(tenant, space, { content: "later" }, "later")).toThrow(
    "publication is in progress",
  );
  controller.abort();
  await expect(publication).rejects.toMatchObject({ name: "AbortError" });
  expect(raw.query("PRAGMA busy_timeout").get()).toEqual(prior);
  const receipt = await service.importBundle(actor, destination.space, bundle, "publication");
  expect(await service.importBundle(actor, destination.space, bundle, "publication")).toEqual(
    receipt,
  );
  expect(service.repository.remember(tenant, space, { content: "later" }, "later").id).toBeString();
});

it("propagates imported staleness down a deep DAG while another tenant reads through the writer lock", async () => {
  const source = await fixture("source"),
    destination = await fixture("destination");
  const s = source.get();
  s.raw.transaction(() => {
    for (let i = 0; i < 600; i++)
      s.service.repository.remember(s.actor, source.space, { content: `chain ${i}` }, `c${i}`);
  })();
  const bundle = await source.client.exportBundle(source.space);
  const chain = bundle.payload.records;
  chain[0]!.stale = 1;
  chain[0]!.stale_reason = '{"kind":"review_required"}';
  for (let i = 1; i < chain.length; i++) {
    const attrs = chain[i]!.versions[0]!.attributes!;
    attrs.depends_on = [chain[i - 1]!.id];
    attrs.dependency_versions = { [chain[i - 1]!.id]: 1 };
  }
  const last = chain.at(-1)!.id;
  bundle.payload.records.reverse();
  bundle.sha256 = await memoryPortableDigest(bundle.payload);
  const d = destination.get(),
    tenant = d.db.ensurePrincipal({ type: "service", displayName: "read during import" });
  const actor = d.db.verifyMemoryCredential(d.db.issueMemoryCredential(tenant.principal_id).token)!;
  const space = d.service.repository.createSpace(actor, "other", "other").id;
  const record = d.service.repository.remember(actor, space, { content: "readable" }, "evidence");
  let reads = 0,
    lockedReads = 0;
  const timer = setInterval(() => {
    let locked = false;
    try {
      d.raw.exec("BEGIN IMMEDIATE");
      d.raw.exec("ROLLBACK");
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_BUSY") locked = true;
      else throw error;
    }
    expect(d.service.repository.read(actor, space, record.id).content).toBe("readable");
    reads++;
    if (locked) lockedReads++;
  }, 5);
  try {
    await d.service.importBundle(d.actor, destination.space, bundle, "chain");
  } finally {
    clearInterval(timer);
  }
  expect(reads).toBeGreaterThan(0);
  expect(lockedReads).toBeGreaterThan(0);
  expect((await destination.client.get(destination.space, last)).freshness).toBe("stale");
  expect((await destination.client.query(destination.space)).results).toEqual([]);
}, 30000);
