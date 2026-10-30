// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { MarinaMemoryClient } from "../src/sdk/memory-client";

let directory: string;
let db: MarinaDB;
let service: MemoryService;
let token: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-pacing-"));
  db = new MarinaDB(join(directory, "memory.db"));
  service = new MemoryService(db);
  token = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "pacing" }).principal_id,
  ).token;
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});

const clientVia = (peer?: string) =>
  new MarinaMemoryClient("http://memory.test", token, 30000, (req) =>
    handleMemoryServiceApi(req, service, peer),
  );

describe("the per-principal memory budget paces network clients only", () => {
  it("an in-process caller (no peer) is never queued behind a token", async () => {
    const client = clientVia();
    const started = performance.now();
    for (let i = 0; i < 150; i++) await client.spaces();
    // 150 calls past the 100-token burst: no 429, and no retry sleep (40 ms a token).
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("a network client is refused past its burst, naming the wait", async () => {
    const client = clientVia("10.0.0.7");
    for (let i = 0; i < 100; i++) await client.spaces();
    await expect(client.spaces()).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });
});
