// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { handleMemoryServiceApi } from "../net/memory-service-api";
import { RequestDrain } from "../net/request-drain";
import { MarinaDB } from "../persistence/database";
import { acquireDatabaseLease } from "../persistence/database-lease";
import type { EmbeddingProvider } from "./embeddings";
import { MemoryService } from "./service";

/** Standalone memory deployment: no Engine, rooms, resident models or standing. */
export function serveMemory(options: {
  dbPath: string;
  hostname?: string;
  port?: number;
  embeddings?: EmbeddingProvider;
}) {
  mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
  const releaseLease = acquireDatabaseLease(options.dbPath);
  const db = new MarinaDB(options.dbPath, { durability: "full" });
  chmodSync(options.dbPath, 0o600);
  const service = new MemoryService(db, options.embeddings);
  const requests = new RequestDrain();
  let draining = false;
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 3301,
    maxRequestBodySize: 2 * 1024 * 1024,
    idleTimeout: 60,
    fetch: async (req) => {
      if (draining) return Response.json({ error: "Instance is draining" }, { status: 503 });
      const leave = requests.enter();
      try {
        return await handleMemoryServiceApi(req, service);
      } finally {
        leave();
      }
    },
  });
  service.startWorker();
  return {
    server,
    service,
    db,
    async close() {
      draining = true;
      await requests.wait();
      await server.stop(true);
      await service.close();
      db.close();
      releaseLease();
    },
  };
}
