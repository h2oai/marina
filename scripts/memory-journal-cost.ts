// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory requests and wall time per journaled resident message.
 *
 *   bun run scripts/memory-journal-cost.ts [messages] [--unlimited]
 *
 * Drives DurableResidentMemory against an in-process memory service on a
 * temporary database and counts requests by operation. Rate-limit waits
 * happen inside the in-process path and show in the time per message;
 * `--unlimited` lifts the per-principal memory request budget to show the
 * service cost alone. No server, no model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableResidentMemory } from "../src/agent/durable-memory";
import { RateLimiter } from "../src/auth/rate-limiter";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";

const messages = Number(process.argv[2] ?? 200);
RateLimiter.bypass = process.argv.includes("--unlimited");
const directory = mkdtempSync(join(tmpdir(), "marina-journal-cost-"));
const db = new MarinaDB(join(directory, "memory.db"), { durability: "full" });
try {
  db.createUser({ id: crypto.randomUUID(), name: "CostResident" });
  const counts = new Map<string, number>();
  const client = {
    memoryService: async (request: MemoryOperationRequest) => {
      counts.set(request.operation, (counts.get(request.operation) ?? 0) + 1);
      return residentMemoryOperation(db, "CostResident", request);
    },
  };
  const memory = new DurableResidentMemory(client);
  await memory.save({ lastIntent: "measure" });
  counts.clear();
  const started = performance.now();
  for (let i = 0; i < messages; i++)
    await memory.journal({ role: "assistant", content: [{ type: "text", text: `message ${i}` }] });
  const elapsed = performance.now() - started;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(
    JSON.stringify(
      {
        messages,
        requests: total,
        requests_per_message: +(total / messages).toFixed(2),
        ms_per_message: +(elapsed / messages).toFixed(2),
        by_operation: Object.fromEntries(counts),
      },
      null,
      1,
    ),
  );
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
