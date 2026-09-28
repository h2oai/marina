// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /mem under the local profile accepts the local model-API key (the same
 * generated key /v1 accepts), naming the agent with X-Agent-Name; any other
 * profile refuses that key.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTrustProfile } from "../src/engine/trust-profile";
import { handleMemApi } from "../src/net/mem-api";
import { MarinaDB } from "../src/persistence/database";
import { scopeProcessState } from "./process-state";

const KEY = "mk_local_abcdefghijklmnopqrstuvwxyz0123456789";
let dir: string;
let db: MarinaDB;
let state: DisposableStack;

beforeEach(() => {
  state = scopeProcessState({
    env: { MARINA_LOCAL_API_KEY: KEY, MEM_API_KEYS: undefined, MARINA_OPEN_API: undefined },
  });
  dir = mkdtempSync(join(tmpdir(), "mem-local-"));
  db = new MarinaDB(join(dir, "w.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  state.dispose();
});

async function stats(headers: Record<string, string>) {
  const url = new URL("http://127.0.0.1:3300/mem/stats");
  const response = await handleMemApi(url, "GET", new Request(url, { headers }), db);
  return response!;
}

describe("/mem and the local model-API key", () => {
  it("local profile: the key plus X-Agent-Name is accepted", async () => {
    setTrustProfile("local");
    const ok = await stats({ Authorization: `Bearer ${KEY}`, "X-Agent-Name": "Alice" });
    expect(ok.status).toBe(200);
    const missing = await stats({ Authorization: `Bearer ${KEY}` });
    expect(missing.status).toBe(400);
    expect(await stats({ Authorization: "Bearer wrong" })).toHaveProperty("status", 401);
  });

  it("shared and public profiles refuse the same key", async () => {
    for (const profile of ["shared", "public"] as const) {
      setTrustProfile(profile);
      const refused = await stats({ Authorization: `Bearer ${KEY}`, "X-Agent-Name": "Alice" });
      expect(refused.status).toBe(401);
    }
  });
});
