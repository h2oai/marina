// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The journal and compaction archives share stored parts: a message has the
 * same bytes in an archive as in the journal entry that already stored it, so
 * an archive stores only what the journal has not (its comma separator and
 * manifest). Tool-result `details` — the harness's live bookkeeping — are not
 * stored at all.
 */

import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableResidentMemory, forJournal } from "../src/agent/durable-memory";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";

let directory: string;
let db: MarinaDB;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-journal-dedup-"));
  db = new MarinaDB(join(directory, "memory.db"), { durability: "full" });
  db.createUser({ id: crypto.randomUUID(), name: "Journaler" });
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});

const client = () => ({
  memoryService: (request: MemoryOperationRequest) =>
    residentMemoryOperation(db, "Journaler", request),
});

const sourceCount = () =>
  (
    db.memoryRepository().raw.query("SELECT count(*) AS n FROM memory_sources").get() as {
      n: number;
    }
  ).n;

async function reassemble(sourceIds: readonly string[]): Promise<unknown[]> {
  let text = "";
  for (const id of sourceIds)
    text += (
      (await residentMemoryOperation(db, "Journaler", { operation: "source_range", id }))
        .result as {
        text: string;
      }
    ).text;
  return JSON.parse(text) as unknown[];
}

const messages = [
  { role: "user", content: [{ type: "text", text: "count the groups" }], timestamp: 1 },
  {
    role: "assistant",
    content: [
      { type: "toolCall", id: "c1", name: "marina_command", arguments: { command: "look" } },
    ],
    timestamp: 2,
  },
  {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "marina_command",
    content: [{ type: "text", text: "Workbench. Exits: south." }],
    details: { command: "look", perceptionCount: 1, deliveries: [], contextBlocks: [] },
    isError: false,
    timestamp: 3,
  },
  { role: "assistant", content: [{ type: "text", text: "Eight groups." }], timestamp: 4 },
];

it("an archive reuses every message the journal stored", async () => {
  const durable = new DurableResidentMemory(client());
  for (const message of messages) await durable.journal(message);
  const afterJournal = sourceCount();

  await durable.archive(messages, "counted the groups");
  // Only the shared comma separator and the archive manifest are new.
  expect(sourceCount() - afterJournal).toBe(2);

  const archive = (await durable.checkpoint())!.data.archive as { source_ids: string[] };
  expect(await reassemble(archive.source_ids)).toEqual(
    JSON.parse(JSON.stringify(messages, forJournal)),
  );
});

it("a tool result is stored without its details", async () => {
  const durable = new DurableResidentMemory(client());
  await durable.journal(messages[2]);
  const journal = (await durable.checkpoint())!.data.journal as { source_ids: string[] };
  const [stored] = (await reassemble(journal.source_ids)) as Array<Record<string, unknown>>;
  expect(stored).toMatchObject({ role: "toolResult", toolName: "marina_command" });
  expect(stored!.content).toEqual(messages[2]!.content);
  expect(stored).not.toHaveProperty("details");
});

it("details stay on any other object, and image bytes are still left out", () => {
  const assistant = { role: "assistant", details: { keep: true } };
  expect(JSON.parse(JSON.stringify(assistant, forJournal))).toEqual(assistant);
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  expect(JSON.parse(JSON.stringify([image], forJournal))).toEqual([
    { type: "text", text: "[image image/png not recorded]" },
  ]);
});

it("a resumed agent's excerpt is the newest message, never a separator part", async () => {
  const adapter = new LeanAgentAdapter({ name: "Journaler" }, "ws://127.0.0.1:3300", null);
  const parts: Record<string, string> = {
    open: "[",
    first: '{"role":"user","content":"count"}',
    comma: ",",
    last: '{"role":"assistant","content":"Eight groups."}',
    close: "]",
  };
  const internal = adapter as unknown as {
    platformMemory: { readSourceExcerpt(id: string): Promise<string | null> };
    recoverPreservedExcerpt(ids: string[]): Promise<string>;
  };
  internal.platformMemory.readSourceExcerpt = async (id) => parts[id] ?? null;
  expect(await internal.recoverPreservedExcerpt(["open", "first", "comma", "last", "close"])).toBe(
    parts.last!,
  );
  expect(await internal.recoverPreservedExcerpt(["open", "close"])).toBe("");
});
