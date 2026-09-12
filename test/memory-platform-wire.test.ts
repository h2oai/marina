// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { Engine } from "../src/engine/engine";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { MarinaClient } from "../src/sdk/client";
import { roomId } from "../src/types";
import { makeTestRoom } from "./helpers";

it("carries full memory over the real SDK/WebSocket path across a clean server restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-memory-wire-"));
  function start() {
    const db = new MarinaDB(join(directory, "wire.db"));
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    const server = new WebSocketServer(engine, 0);
    server.setDb(db);
    server.start();
    engine.start();
    const client = new MarinaClient(`ws://localhost:${server.getPort()}`, {
      autoReconnect: false,
      pingInterval: 0,
      connectTimeout: 2000,
      commandDrainTimeout: 150,
    });
    return { db, engine, server, client, memory: new PlatformMemoryBackend(client) };
  }
  async function stop(runtime: ReturnType<typeof start>) {
    runtime.client.disconnect();
    runtime.server.stop();
    await Bun.sleep(30); // Drain socket close handlers before closing persistence.
    runtime.engine.stop();
    runtime.db.close();
  }
  let runtime: ReturnType<typeof start> | undefined;
  try {
    runtime = start();
    await runtime.client.connect("MemoryWireResident");
    const evidence = `wireneedle ${"supporting evidence ".repeat(20)}FINAL_DETAIL`;
    const skill = `[Skill: wireneedle] ${"description ".repeat(20)} || Actions: inspect; verify; report`;
    runtime.db.createNote("MemoryWireResident", evidence);
    runtime.db.createNote("MemoryWireResident", skill, undefined, { noteType: "skill" });
    runtime.db.createMemoryPool("shared", "shared", "MemoryWireResident");
    runtime.db.addPoolNote("shared", "MemoryWireResident", evidence);
    const focus = { description: "Finish  the evidence audit", startedAt: 42 };
    const checkpoint = { lastIntent: "artifact not found  — inspect", cursor: 73 };
    expect((await runtime.memory.saveFocus(focus)).success).toBe(true);
    expect((await runtime.memory.saveCheckpoint(checkpoint)).success).toBe(true);
    expect(
      (await runtime.memory.search("wireneedle")).results?.some(
        (note) => note.content === evidence,
      ),
    ).toBe(true);
    expect((await runtime.memory.searchSkills("wireneedle")).results?.[0]?.content).toBe(skill);
    expect((await runtime.memory.importShared("shared", "wireneedle")).results?.[0]?.content).toBe(
      evidence,
    );
    const originals = [
      { role: "user", content: `originalwire ${"unabridged α ".repeat(3000)}END` },
    ];
    await runtime.memory.archiveContext(originals, "Archived complete wire evidence", "shared");
    const sharedArchive = (await runtime.client.command("pool shared list"))
      .map((perception) => perception.data?.text ?? "")
      .join("\n");
    expect(sharedArchive).toContain("[compaction] Archived complete wire evidence");
    expect(sharedArchive).not.toContain("originalwire");
    const completed = { role: "assistant", content: "completed after compaction" };
    await runtime.memory.journalMessage(completed);
    const previous = runtime;
    runtime = undefined;
    await stop(previous);
    runtime = start();
    await runtime.client.connect("MemoryWireResident");
    expect(await runtime.memory.getFocus()).toEqual(focus);
    const resumed = await runtime.memory.getCheckpoint();
    expect(resumed).toMatchObject(checkpoint);
    const archive = resumed!.archive as { source_ids: string[] };
    let restored = "";
    for (const id of archive.source_ids) {
      const reply = await runtime.client.memoryService({ operation: "source_range", id });
      expect(reply.ok).toBe(true);
      if (reply.ok) restored += (reply.result as { text: string }).text;
    }
    expect(restored).toBe(JSON.stringify(originals));
    const journal = resumed!.journal as { source_ids: string[] };
    let journalText = "";
    for (const id of journal.source_ids) {
      const reply = await runtime.client.memoryService({ operation: "source_range", id });
      expect(reply.ok).toBe(true);
      if (reply.ok) journalText += (reply.result as { text: string }).text;
    }
    expect(JSON.parse(journalText)).toEqual([completed]);
    expect(
      (await runtime.memory.search("wireneedle")).results?.some(
        (note) => note.content === evidence,
      ),
    ).toBe(true);
  } finally {
    if (runtime) await stop(runtime);
    rmSync(directory, { recursive: true });
  }
}, 10_000);
