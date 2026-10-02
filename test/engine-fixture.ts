// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { closeWorldMemoryService } from "../src/memory/world-service";
import { MarinaDB } from "../src/persistence/database";
import type { StorageProvider } from "../src/storage/provider";
import { type RoomModule, roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

/** Independent world, registry and persistence; no listener, timers or profile mutation.
 * Use disk storage for WAL/external-writer/reopen tests. Always await dispose(). */
export function createTestEngine(
  options: {
    storage?: "memory" | "disk";
    assetStorage?: StorageProvider;
    room?: Partial<RoomModule>;
  } = {},
) {
  const directory =
    options.storage === "disk" ? mkdtempSync(join(tmpdir(), "marina-test-")) : undefined;
  const path = directory ? join(directory, "world.db") : ":memory:";
  const db = new MarinaDB(path);
  const engine = new Engine({
    db,
    storage: options.assetStorage,
    startRoom: roomId("test/start"),
    tickInterval: 60_000,
  });
  engine.registerRoom(roomId("test/start"), makeTestRoom(options.room));
  let disposal: Promise<void> | undefined;
  return {
    db,
    engine,
    path,
    login(name: string) {
      const connection = new MockConnection(crypto.randomUUID());
      engine.addConnection(connection);
      const result = engine.login(connection.id, name);
      if ("error" in result) throw new Error(result.error);
      return { connection, entityId: result.entityId };
    },
    dispose(): Promise<void> {
      disposal ??= (async () => {
        engine.stop();
        await engine.agentRuntime.stopAll();
        await engine.drainCommands();
        await engine.shutdown();
        await closeWorldMemoryService(db);
        db.close();
        if (directory) rmSync(directory, { recursive: true, force: true });
      })();
      return disposal;
    },
  };
}
