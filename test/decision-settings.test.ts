// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Runtime decision settings: an operator turns decisions on and configures
// them from a running Marina (dashboard, console, CLI). Operator only, never an
// agent; the environment wins; base URLs and keys are never runtime; audited;
// re-applied at boot.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDecisionProvider } from "../src/decisions/config";
import {
  applyStoredDecisionSettings,
  changeDecisionSetting,
  DECISION_SETTINGS,
  decisionSettingsHistory,
  describeDecisionSettings,
  resetDecisionSettingsForTests,
} from "../src/decisions/settings";
import { adminDecisions } from "../src/engine/commands/admin-decisions";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests } from "../src/engine/trust-profile";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { MarinaDB } from "../src/persistence/database";
import type { Connection, Entity, EntityId } from "../src/types";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

const DESKTOP_TOKEN = "desktop-capability-token-at-least-32-chars";
const ENV = [
  ...DECISION_SETTINGS.map((s) => s.env),
  "OPENROUTER_API_KEY",
  "MARINA_DESKTOP_API_TOKEN",
  "MARINA_OPEN_API",
];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

let dir: string;
let db: MarinaDB;

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  resetDecisionSettingsForTests();
  dir = mkdtempSync(join(tmpdir(), "marina-dsettings-"));
  db = new MarinaDB(join(dir, "world.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetDecisionSettingsForTests();
});

describe("changing a setting", () => {
  it("takes effect on the next decision, persists, and is audited", () => {
    process.env.OPENROUTER_API_KEY = "k";
    resetDecisionSettingsForTests();
    expect(getDecisionProvider()).toBeUndefined();
    const v = changeDecisionSetting(db, "backend", "jev", "Operator");
    expect(v).toMatchObject({
      env: "MARINA_DECISIONS",
      value: "jev",
      source: "runtime",
      locked: false,
    });
    expect(getDecisionProvider()?.model).toBe("typesafe/jev-1.13");
    changeDecisionSetting(db, "MARINA_DECISION_GATE", "ON", "Operator");
    expect(process.env.MARINA_DECISION_GATE).toBe("on");
    changeDecisionSetting(db, "backend", null, "Operator");
    expect(getDecisionProvider()).toBeUndefined();
    expect(decisionSettingsHistory(db).map((c) => [c.by, c.setting, c.from, c.to])).toEqual([
      ["Operator", "backend", "jev", null],
      ["Operator", "gate", null, "on"],
      ["Operator", "backend", null, "jev"],
    ]);
  });

  it("validates every value, and knows nothing it may not set", () => {
    expect(() => changeDecisionSetting(db, "gate", "maybe", "Op")).toThrow(/one of: on, off/);
    expect(() => changeDecisionSetting(db, "samples", "99", "Op")).toThrow(/2–15/);
    expect(() => changeDecisionSetting(db, "calibration", "rel/cal.json", "Op")).toThrow(
      /absolute path/,
    );
    expect(() => changeDecisionSetting(db, "model", "bad model id!", "Op")).toThrow(/model id/);
    // Base URLs, paths and keys are never runtime settings.
    for (const k of [
      "MARINA_DECISION_BASE_URL",
      "MARINA_DECISION_API_KEY",
      "MARINA_DECISION_PATH",
    ]) {
      expect(() => changeDecisionSetting(db, k, "x", "Op")).toThrow(/never set at runtime/);
    }
    expect(decisionSettingsHistory(db)).toEqual([]);
  });

  it("the environment wins: a variable set at boot is locked", () => {
    process.env.MARINA_DECISION_GATE = "off";
    resetDecisionSettingsForTests();
    expect(() => changeDecisionSetting(db, "gate", "on", "Op")).toThrow(/environment, which wins/);
    expect(process.env.MARINA_DECISION_GATE).toBe("off");
    const view = describeDecisionSettings(db).find((s) => s.name === "gate")!;
    expect(view).toMatchObject({ value: "off", source: "environment", locked: true });
  });
});

describe("boot", () => {
  it("re-applies stored settings; the environment still wins; invalid values are skipped", () => {
    changeDecisionSetting(db, "gate", "on", "Op");
    changeDecisionSetting(db, "verify", "observe", "Op");
    db.setSetting("decision_setting:MARINA_DECISION_SAMPLES", "999"); // no longer valid
    for (const k of ENV) delete process.env[k];
    process.env.MARINA_DECISION_VERIFY = "off"; // set in the environment for this boot
    resetDecisionSettingsForTests();
    const result = applyStoredDecisionSettings(db);
    expect(result.applied).toEqual(["MARINA_DECISION_GATE"]);
    expect(result.shadowed).toEqual(["MARINA_DECISION_VERIFY"]);
    expect(process.env.MARINA_DECISION_GATE).toBe("on");
    expect(process.env.MARINA_DECISION_VERIFY).toBe("off");
    expect(process.env.MARINA_DECISION_SAMPLES).toBeUndefined();
  });
});

describe("console / CLI: admin decisions", () => {
  const person = { id: "e_op" as EntityId, name: "Operator" } as Entity;
  const conns = (internal = false) =>
    new Map<string, Connection>([["c1", { entity: person.id, internal } as unknown as Connection]]);

  it("shows every setting and where it comes from, then changes one", () => {
    const deps = { db, getConnections: () => conns() };
    const show = adminDecisions(deps, person, []);
    for (const s of DECISION_SETTINGS) expect(show).toContain(s.name);
    expect(show).toContain("never set at runtime");
    expect(adminDecisions(deps, person, ["set", "gate", "on"])).toContain(
      "gate (MARINA_DECISION_GATE) = on",
    );
    expect(adminDecisions(deps, person, ["history"])).toContain("Operator  gate: (default) → on");
    expect(adminDecisions(deps, person, ["unset", "gate"])).toContain("= (default)");
    expect(adminDecisions(deps, person, ["set", "gate", "maybe"])).toContain("one of: on, off");
  });

  it("refuses an agent: internal connection or a spawned agent's config", () => {
    const viaInternal = adminDecisions({ db, getConnections: () => conns(true) }, person, [
      "set",
      "gate",
      "off",
    ]);
    expect(viaInternal).toContain("Refused: an agent never changes");
    db.saveAgentConfig({ name: "Operator", model: "marina/default", spawnedBy: "system" });
    const viaConfig = adminDecisions({ db, getConnections: () => conns() }, person, [
      "set",
      "gate",
      "off",
    ]);
    expect(viaConfig).toContain("Refused: an agent never changes");
    expect(process.env.MARINA_DECISION_GATE).toBeUndefined();
    // Reading is fine.
    expect(adminDecisions({ db, getConnections: () => conns(true) }, person, [])).toContain(
      "Decision settings",
    );
  });
});

describe("dashboard: /api/ops/decisions/settings", () => {
  let engine: Engine;
  let resident: string;
  beforeEach(() => {
    process.env.MARINA_DESKTOP_API_TOKEN = DESKTOP_TOKEN;
    resetTrustProfileForTests();
    resetHttpRateLimitersForTests();
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    const conn = new MockConnection("dset-1");
    engine.addConnection(conn);
    const r = engine.login(conn.id, "Resident");
    if ("error" in r) throw new Error(r.error);
    resident = r.token;
  });
  afterEach(() => resetTrustProfileForTests());

  async function api(
    method: string,
    body?: unknown,
    auth: { desktop?: boolean; token?: string } = {},
  ) {
    const url = new URL("http://localhost:3300/api/ops/decisions/settings");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth.desktop) headers["X-Marina-Desktop-Token"] = DESKTOP_TOKEN;
    if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
    const req = new Request(url.toString(), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const res = await handleDashboardApi(req, url, method, engine, db);
    if (!res) throw new Error("no response");
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("the operator reads and changes settings; a resident can do neither", async () => {
    expect((await api("GET", undefined, { token: resident })).status).toBe(403);
    expect((await api("PUT", { setting: "gate", value: "on" }, { token: resident })).status).toBe(
      403,
    );
    expect(process.env.MARINA_DECISION_GATE).toBeUndefined();

    const read = await api("GET", undefined, { desktop: true });
    expect(read.status).toBe(200);
    expect((read.body.settings as unknown[]).length).toBe(DECISION_SETTINGS.length);

    const put = await api("PUT", { setting: "gate", value: "on" }, { desktop: true });
    expect(put.status).toBe(200);
    expect(process.env.MARINA_DECISION_GATE).toBe("on");
    const cleared = await api("PUT", { setting: "gate", value: null }, { desktop: true });
    expect(cleared.status).toBe(200);
    expect(process.env.MARINA_DECISION_GATE).toBeUndefined();
  });

  it("a sovereign-rank AGENT is still refused: it never reconfigures its own supervision", async () => {
    const conn = new MockConnection("dset-bot");
    engine.addConnection(conn);
    const r = engine.login(conn.id, "Bot");
    if ("error" in r) throw new Error(r.error);
    const bot = engine.entities.all().find((e) => e.name === "Bot")!;
    bot.properties.rank = 9; // passes authorizePrivileged on rank alone…
    db.saveAgentConfig({ name: "Bot", model: "marina/default", spawnedBy: "system" });
    const res = await api("PUT", { setting: "gate", value: "off" }, { token: r.token });
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain("An agent never changes");
    expect(process.env.MARINA_DECISION_GATE).toBeUndefined();
  });

  it("locked settings are 409, bad values 400, and nothing else is settable", async () => {
    process.env.MARINA_DECISION_MODEL = "typesafe/jev-1.13";
    resetDecisionSettingsForTests();
    expect((await api("PUT", { setting: "model", value: "x/y" }, { desktop: true })).status).toBe(
      409,
    );
    expect((await api("PUT", { setting: "gate", value: "maybe" }, { desktop: true })).status).toBe(
      400,
    );
    const url = await api(
      "PUT",
      { setting: "MARINA_DECISION_BASE_URL", value: "https://evil.example" },
      { desktop: true },
    );
    expect(url.status).toBe(400);
    expect(String(url.body.error)).toContain("never set at runtime");
    expect((await api("PUT", { nope: true }, { desktop: true })).status).toBe(400);
  });
});
