// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { ENVIRONMENT_REFERENCE_PATH, environmentCatalog } from "../src/config/environment";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { HOT_RELOADABLE_VARS, PROTECTED_ENV_KEYS } from "../src/net/dashboard-api/keys";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_env_config.db";

interface EnvEntry {
  key: string;
  editable: boolean;
  source: "env" | "file" | "unset";
  isSet: boolean;
  protected: boolean;
  restart: boolean;
}

describe("env config editability", () => {
  let db: MarinaDB;
  let engine: Engine;
  let savedDesktopToken: string | undefined;
  // GET /api/env now requires an operator capability; the desktop operator
  // token is the zero-config local-operator credential the panel uses.
  const DESKTOP_TOKEN = "desktop-capability-token-at-least-32-chars";

  beforeEach(() => {
    savedDesktopToken = process.env.MARINA_DESKTOP_API_TOKEN;
    process.env.MARINA_DESKTOP_API_TOKEN = DESKTOP_TOKEN;
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    if (savedDesktopToken === undefined) delete process.env.MARINA_DESKTOP_API_TOKEN;
    else process.env.MARINA_DESKTOP_API_TOKEN = savedDesktopToken;
  });

  async function getEnv(): Promise<EnvEntry[]> {
    const url = new URL("http://localhost:3300/api/env");
    const req = new Request(url.toString(), {
      method: "GET",
      headers: { "X-Marina-Desktop-Token": DESKTOP_TOKEN },
    });
    const resp = await handleDashboardApi(req, url, "GET", engine, db);
    return (await resp!.json()) as EnvEntry[];
  }

  it("reports unset schema vars as editable (source=unset)", async () => {
    const candidate = (await getEnv()).find((e) => e.source === "unset" && !e.protected);
    // A populated environment could leave none unset; only assert when present.
    if (candidate) {
      expect(candidate.editable).toBe(true);
      expect(candidate.isSet).toBe(false);
    }
  });

  it("flips a var to read-only (source=env) when set in the live environment", async () => {
    // Pick a var that's genuinely unset (not in .env file, not in process.env),
    // so the test is independent of any local .env contents.
    const candidate = (await getEnv()).find((e) => e.source === "unset" && !e.protected);
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

  async function putEnv(vars: Record<string, string>): Promise<number> {
    const url = new URL("http://localhost:3300/api/env");
    const req = new Request(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Marina-Desktop-Token": DESKTOP_TOKEN },
      body: JSON.stringify({ vars }),
    });
    return (await handleDashboardApi(req, url, "PUT", engine, db))!.status;
  }

  it("hides @internal keys and marks protected keys read-only", async () => {
    const entries = await getEnv();
    const keys = new Set(entries.map((e) => e.key));
    expect(keys.has("MARINA_COLLECTIVE_CHILD")).toBe(false);
    expect(keys.has("MARINA_LOCAL_API_KEY")).toBe(false);
    for (const key of ["WS_HOST", "MARINA_URL_GUARD_DNS_FAIL_OPEN", "MARINA_AUTONOMY"]) {
      const entry = entries.find((e) => e.key === key)!;
      expect(entry.protected).toBe(true);
      expect(entry.editable).toBe(false);
    }
    // SDK example knobs are no longer offered as server settings.
    expect(keys.has("DEBATE_JUDGE")).toBe(false);
  });

  it.each([
    "MARINA_URL_GUARD_DNS_FAIL_OPEN",
    "MARINA_OTLP_ALLOW_INSECURE",
    "MARINA_MCP_ALLOWED_HOSTS",
    "MARINA_KEY_SECRET",
    "WS_HOST",
    "MARINA_DASHBOARD_CSP",
    "MARINA_EVOLVE_TRIALS",
    "MARINA_COLLECTIVE_CHILD",
    "MARINA_LOCAL_API_KEY",
  ])("refuses a dashboard write to %s (tagged in the reference)", async (key) => {
    const before = process.env[key];
    expect(await putEnv({ [key]: "attacker" })).toBe(403);
    expect(process.env[key]).toBe(before);
  });
});

describe("environment reference tags", () => {
  const catalog = environmentCatalog(readFileSync(ENVIRONMENT_REFERENCE_PATH, "utf8"));

  it("tags every hard-coded protected key that it documents", () => {
    const untagged = catalog.filter((s) => PROTECTED_ENV_KEYS.has(s.key) && !s.protected);
    expect(untagged.map((s) => s.key)).toEqual([]);
  });

  it("never reports a @restart key as hot-reloadable", () => {
    const restart = catalog.filter((s) => s.restart).map((s) => s.key);
    expect(restart.filter((key) => HOT_RELOADABLE_VARS.has(key))).toEqual([]);
  });
});
