// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Split from memory-transfer.test.ts (staging, discovery, tenancy and staleness lifecycle). Assertions unchanged.

import { afterEach, expect, it } from "bun:test";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { memoryPortableDigest } from "../src/sdk/memory-portable";
import { resumeMemoryTransfer } from "../src/sdk/memory-transfer-client";

import { fixture, runTransferCleanups } from "./memory-transfer-helpers";

afterEach(runTransferCleanups);

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
