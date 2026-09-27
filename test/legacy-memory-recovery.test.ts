// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDurableTwin } from "../src/memory/legacy-projection";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { closeWorldMemoryService } from "../src/memory/world-service";
import { handleMemApi } from "../src/net/mem-api";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryRecord } from "../src/sdk/memory-types";

const original = process.env.MEM_API_KEYS;
afterEach(() => {
  if (original === undefined) delete process.env.MEM_API_KEYS;
  else process.env.MEM_API_KEYS = original;
});

test("authenticated REST create and delete share the durable lifecycle; open names never mint principals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-bridge-rest-"));
  const db = new MarinaDB(join(dir, "world.db"));
  process.env.MEM_API_KEYS = "fixture-token:Alice,ghost-token:Ghost";
  db.createUser({ id: crypto.randomUUID(), name: "Alice" });
  async function request(method: string, path: string, body?: unknown, token = "fixture-token") {
    const url = new URL(path, "http://local.test");
    const response = await handleMemApi(
      url,
      method,
      new Request(url, {
        method,
        headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      db,
    );
    return {
      status: response!.status,
      body: (await response!.json()) as { id: number; durable: string },
    };
  }
  try {
    const created = await request("POST", "/mem/notes", {
      content: "cobalt protocol listens on 7420",
    });
    expect(created.status).toBe(201);
    expect(created.body.durable).toBe("synced");
    const twin = findDurableTwin(db, created.body.id)!;
    expect(twin).toBeDefined();
    expect((await request("DELETE", `/mem/notes/${created.body.id}`)).status).toBe(200);
    const record = (
      await residentMemoryOperation(db, "Alice", { operation: "get", id: twin.recordId })
    ).result as MemoryRecord;
    expect(record.content).toContain("[deleted legacy note #");
    expect(record.valid_time?.until).toBeNumber();
    const ghost = await request("POST", "/mem/notes", { content: "legacy client" }, "ghost-token");
    expect(ghost.body.durable).toBe("synced");
    expect(db.getPrincipal("human", "Ghost")).toBeUndefined();
    expect(db.getUserByName("Ghost")).toBeUndefined();
  } finally {
    await closeWorldMemoryService(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("committed create and delete intents replay after reopening without the original command process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-bridge-recovery-"));
  const path = join(dir, "world.db");
  let db = new MarinaDB(path);
  try {
    db.createUser({ id: crypto.randomUUID(), name: "Alice" });
    const id = db.createNote("Alice", "durable retry evidence");
    expect(findDurableTwin(db, id)).toBeDefined();
    db.close();
    db = new MarinaDB(path);
    const twin = findDurableTwin(db, id)!;
    expect(twin).toBeDefined();
    expect(
      db
        .memoryRepository()
        .raw.query("SELECT 1 FROM sqlite_schema WHERE name='legacy_memory_outbox'")
        .get(),
    ).toBeNull();
    db.deleteNote(id, "Alice");
    await closeWorldMemoryService(db);
    db.close();
    db = new MarinaDB(path);
    expect(
      db
        .memoryRepository()
        .raw.query("SELECT 1 FROM sqlite_schema WHERE name='legacy_memory_outbox'")
        .get(),
    ).toBeNull();
    const record = (
      await residentMemoryOperation(db, "Alice", { operation: "get", id: twin.recordId })
    ).result as MemoryRecord;
    expect(record.content).toContain("[deleted legacy note #");
  } finally {
    await closeWorldMemoryService(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
