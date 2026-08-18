// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_env_config.db";

interface EnvEntry {
  key: string;
  editable: boolean;
  source: "env" | "file" | "unset";
  isSet: boolean;
}

describe("env config editability", () => {
  let db: MarinaDB;
  let engine: Engine;
  let savedOpenApi: string | undefined;

  beforeEach(() => {
    savedOpenApi = process.env.MARINA_OPEN_API;
    // Open API so the /api/env auth gate passes without a session token.
    process.env.MARINA_OPEN_API = "true";
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    if (savedOpenApi === undefined) delete process.env.MARINA_OPEN_API;
    else process.env.MARINA_OPEN_API = savedOpenApi;
  });

  async function getEnv(): Promise<EnvEntry[]> {
    const url = new URL("http://localhost:3300/api/env");
    const req = new Request(url.toString(), { method: "GET" });
    const resp = await handleDashboardApi(req, url, "GET", engine, db);
    return (await resp!.json()) as EnvEntry[];
  }

  it("reports unset schema vars as editable (source=unset)", async () => {
    const candidate = (await getEnv()).find((e) => e.source === "unset");
    // A populated environment could leave none unset; only assert when present.
    if (candidate) {
      expect(candidate.editable).toBe(true);
      expect(candidate.isSet).toBe(false);
    }
  });

  it("flips a var to read-only (source=env) when set in the live environment", async () => {
    // Pick a var that's genuinely unset (not in .env file, not in process.env),
    // so the test is independent of any local .env contents.
    const candidate = (await getEnv()).find((e) => e.source === "unset");
    if (!candidate) return; // nothing unset to exercise — skip rather than fail

    process.env[candidate.key] = "from-the-environment";
    try {
      const entry = (await getEnv()).find((e) => e.key === candidate.key)!;
      expect(entry.isSet).toBe(true);
      expect(entry.editable).toBe(false);
      expect(entry.source).toBe("env");
    } finally {
      delete process.env[candidate.key];
    }
  });
});
