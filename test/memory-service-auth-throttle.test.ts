// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MemoryService } from "../src/memory/service";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { handleMemoryServiceApi } from "../src/net/memory/memory-service-api";
import { MarinaDB } from "../src/persistence/database";

describe("memory service API failed credentials", () => {
  let db: MarinaDB;
  let service: MemoryService;
  beforeEach(() => {
    resetHttpRateLimitersForTests();
    db = new MarinaDB(":memory:");
    service = new MemoryService(db);
  });
  afterEach(() => {
    resetHttpRateLimitersForTests();
    db.close();
  });

  const call = (token: string, peer?: string) =>
    handleMemoryServiceApi(
      new Request("http://test/v1/memory/spaces", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      service,
      peer,
    );

  it("spend a per-address budget, checked before the credential", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await call(`wrong-${i}`, "198.51.100.7")).status);
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);

    // Even a valid credential from that address waits for the budget to refill.
    const principal = db.ensurePrincipal({ type: "service", displayName: "svc" });
    const valid = db.issueMemoryCredential(principal.principal_id).token;
    expect((await call(valid, "198.51.100.7")).status).toBe(429);
    // Another address is unaffected, and in-process callers are not counted.
    expect((await call(valid, "198.51.100.8")).status).not.toBe(429);
    expect((await call(valid)).status).not.toBe(429);
  });
});
