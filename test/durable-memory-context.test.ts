// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { loadExtensions } from "../src/extensions/loader";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { closeWorldMemoryService } from "../src/memory/world-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryReceipt, MemoryRecord } from "../src/sdk/memory-types";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

test("command and extension contexts write canonical records without legacy copies or bridge jobs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-durable-context-"));
  const db = new MarinaDB(join(directory, "world.db"));
  const engine = new Engine({ db, startRoom: roomId("test/start") });
  engine.registerRoom(roomId("test/start"), makeTestRoom());
  let closeExtension: (() => Promise<void>) | undefined;
  try {
    const alice = new MockConnection("alice");
    const bob = new MockConnection("bob");
    engine.addConnection(alice);
    engine.addConnection(bob);
    const a = engine.login(alice.id, "Alice");
    const b = engine.login(bob.id, "Bob");
    if ("error" in a || "error" in b) throw new Error("Fixture login failed");
    const context = engine.buildCommandContext(roomId("test/start"), a.entityId)!;
    const saved = await context.durableMemory.run({
      operation: "remember",
      key: "context-write",
      input: { content: "canonical context evidence" },
    });
    const id = (saved.result as MemoryReceipt).id;
    const read = await residentMemoryOperation(db, "Alice", { operation: "get", id });
    expect((read.result as MemoryRecord).content).toBe("canonical context evidence");
    expect(db.getNotesByEntity("Alice")).toEqual([]);
    expect(
      db
        .memoryRepository()
        .raw.query("SELECT 1 FROM sqlite_schema WHERE name='legacy_memory_outbox'")
        .get(),
    ).toBeNull();
    const outsider = engine.buildCommandContext(roomId("test/start"), b.entityId)!;
    await expect(
      outsider.durableMemory.run({ operation: "get", space_id: saved.space_id, id }),
    ).rejects.toThrow();
    await context.durableMemory.run({
      operation: "revise",
      id,
      key: "context-revise",
      input: { expected_version: 1, content: "revised canonical evidence" },
    });
    expect(
      (
        (await residentMemoryOperation(db, "Alice", { operation: "get", id }))
          .result as MemoryRecord
      ).content,
    ).toBe("revised canonical evidence");

    writeFileSync(
      join(directory, "marina-plugin.json"),
      JSON.stringify({
        name: "memory-fixture",
        version: "1.0.0",
        apiVersion: 1,
        entry: "index.mjs",
      }),
    );
    writeFileSync(
      join(directory, "index.mjs"),
      `export default { activate(ctx) {
      ctx.registerCommand({ name: "keep-evidence", help: "Store evidence", minRank: 0,
        async run(caller) {
          const saved = await caller.durableMemory.run({ operation: "remember", key: "extension-write", input: { content: "extension evidence" } });
          caller.reply(saved.result.id);
        }
      });
    }};`,
    );
    closeExtension = await loadExtensions(engine, [directory]);
    await engine.processCommand(a.entityId, "keep-evidence");
    const query = await residentMemoryOperation(db, "Alice", {
      operation: "search",
      input: { query: "extension evidence" },
    });
    expect(JSON.stringify(query.result)).toContain("extension evidence");
    expect(db.getNotesByEntity("Alice")).toEqual([]);
    expect(
      db
        .memoryRepository()
        .raw.query("SELECT 1 FROM sqlite_schema WHERE name='legacy_memory_outbox'")
        .get(),
    ).toBeNull();
    engine.removeConnection(alice.id, "explicit");
    await expect(
      context.durableMemory.run({
        operation: "remember",
        key: "expired",
        input: { content: "must not persist" },
      }),
    ).rejects.toThrow("no longer active");
  } finally {
    await closeExtension?.();
    await engine.shutdown();
    await closeWorldMemoryService(db);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
