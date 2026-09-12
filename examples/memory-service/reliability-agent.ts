// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Deterministic agent policy. All persistent knowledge comes through public HTTP;
 * no database access, operator imports, embedding provider or local memory file. */
import { MarinaMemoryClient, MemoryClientError } from "../../src/sdk/memory-client";

const url = process.env.MARINA_MEMORY_URL!;
const space = process.env.MARINA_MEMORY_SPACE!;
const cycle = Number(process.env.MARINA_MEMORY_CYCLE);
const mode = process.env.MARINA_MEMORY_PHASE;
const client = new MarinaMemoryClient(
  url,
  process.env.MARINA_MEMORY_TOKEN!,
  10000,
  async (request) => {
    const response = await fetch(request);
    if (
      mode === "lose-ack" &&
      request.method === "POST" &&
      request.url.endsWith("/sources/batch") &&
      response.ok
    ) {
      await response.arrayBuffer(); // Server committed; terminate before the SDK can deliver its receipt.
      process.exit(97);
    }
    return response;
  },
);
function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const original = (n: number) =>
  `Task ${n}: use /v2 after the correction. Original UTF-8 evidence αβ🙂. ${"detail ".repeat(50)}`;

if (mode === "inspect") {
  const checkpoint = await client.checkpoint(space, "continuity");
  require(checkpoint.version === cycle &&
    checkpoint.data.cycle === cycle, "Restored checkpoint mismatch");
  const root = await client.get(space, checkpoint.data.premise as string);
  const derived = await client.get(space, checkpoint.data.derived as string);
  require(root.version === 2 && root.content === `/v2 for task ${cycle}`, "Corrected premise lost");
  require(derived.freshness === "stale" &&
    derived.content === `/v1 conclusion for task ${cycle}`, "Dependent correction metadata lost");
  require((await client.query(space, { subject: `task:${cycle}` })).results.length ===
    1, "Stale conclusion leaked into default retrieval");
  let after = 0,
    count = 0;
  for (;;) {
    const page = await client.sources(space, after, 100);
    count += page.sources.length;
    if (!page.sources.length) break;
    after = page.sources.at(-1)!.seq;
  }
  require(count === cycle * 2, "Duplicated or missing source writes");
  const storage = await client.usage();
  require(storage.usage.sources === count &&
    storage.usage.revisions === cycle * 3 &&
    storage.usage.spaces === 1, "Storage accounting did not survive restart/restore");
  require(storage.over_limit.length === 0 &&
    storage.usage.logical_bytes > 0, "Unexpected storage admission state");
  require((await client.sourceRange(space, checkpoint.data.original as string)).text ===
    original(cycle), "Original bytes lost");
  console.log(
    JSON.stringify({
      passed: true,
      checkpoint_version: checkpoint.version,
      sources: count,
      storage: storage.usage,
      root_version: root.version,
      derived: derived.freshness,
    }),
  );
} else {
  if (cycle > 1) {
    const previous = await client.checkpoint(space, "continuity");
    require(previous.version === cycle - 1 &&
      previous.data.cycle === cycle - 1, "Fresh agent could not resume previous task");
    require((await client.sourceRange(space, previous.data.original as string)).text ===
      original(cycle - 1), "Previous source changed");
  }
  const prefix = `task-${cycle}`;
  const batch = await client.captureBatch(
    space,
    [
      { content: original(cycle), key: `${prefix}-original`, session_id: prefix },
      {
        content: { correction: "/v1 → /v2", cycle },
        key: `${prefix}-correction`,
        session_id: prefix,
      },
    ],
    `${prefix}-batch`,
  );
  const premise = await client.remember(
    space,
    {
      content: `/v1 for task ${cycle}`,
      subject: `task:${cycle}`,
      source_ids: [batch.receipts[0]!.id],
    },
    `${prefix}-premise`,
  );
  const derived = await client.remember(
    space,
    {
      content: `/v1 conclusion for task ${cycle}`,
      subject: `task:${cycle}`,
      depends_on: [premise.id],
      dependency_versions: { [premise.id]: 1 },
    },
    `${prefix}-derived`,
  );
  await client.revise(
    space,
    premise.id,
    1,
    { content: `/v2 for task ${cycle}`, source_ids: [batch.receipts[1]!.id] },
    `${prefix}-revise`,
  );
  try {
    await client.revise(
      space,
      derived.id,
      1,
      { content: "blind retry", dependency_versions: { [premise.id]: 1 } },
      `${prefix}-invalid-review`,
    );
    throw new Error("Stale dependency version was accepted");
  } catch (error) {
    if (!(error instanceof MemoryClientError) || error.code !== "dependency_changed") throw error;
  }
  const result = await client.saveCheckpoint(
    space,
    "continuity",
    cycle - 1,
    { cycle, premise: premise.id, derived: derived.id, original: batch.receipts[0]!.id },
    batch.seq!,
    `${prefix}-checkpoint`,
    batch.receipts.map((r) => r.id),
  );
  require(result.version === cycle, "Checkpoint did not advance exactly once");
  console.log(JSON.stringify({ passed: true, cycle, source_count: batch.receipts.length }));
}
