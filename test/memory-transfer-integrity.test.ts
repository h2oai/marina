// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Split from memory-transfer.test.ts (history / page / quota integrity). Assertions unchanged.

import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { configureMemoryStorage } from "../src/persistence/db-memory-storage";

import { fixture, runTransferCleanups, sign } from "./memory-transfer-helpers";

afterEach(runTransferCleanups);

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
