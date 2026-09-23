// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Split from memory-transfer.test.ts (bulk volume transfer). Assertions unchanged.

import { afterEach, expect, it } from "bun:test";
import { memoryPortableDigest } from "../src/sdk/memory-portable";
import { retryMemoryOperation } from "../src/sdk/memory-retry";

import { fixture, runTransferCleanups } from "./memory-transfer-helpers";

afterEach(runTransferCleanups);

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
