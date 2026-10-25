// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The in-world supervisor: the native agent supervisor run by the server,
// started by a person with `supervisor start`, holding a routing-only
// supervision credential issued to that person (renewed, revoked on stop),
// reported by readiness and resumed on boot.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { supervisedResidentsCheck } from "../src/engine/readiness";
import { grantGatesForRank } from "../src/engine/safety-gates";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { MarinaDB } from "../src/persistence/database";
import type { AgentAdapter } from "../src/routing/agent-adapters";
import {
  autostartWorldSupervisor,
  resolveSupervisorRoot,
  savedWorldSupervisor,
  supervisorAgentEnvironment,
  supervisorAutostart,
} from "../src/routing/world-supervisor";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";
import { scopeProcessState } from "./process-state";

let directory: string;
let root: string;
let db: MarinaDB;
let engine: Engine;

const inProcess = (async (input, init) => {
  const req = new Request(input, init);
  return (await handleDashboardApi(req, new URL(req.url), req.method, engine, db))!;
}) as typeof fetch;

/** A native agent that is never launched in these tests. */
const fakeAdapter: AgentAdapter & { executable: string } = {
  id: "fake",
  label: "Fake agent",
  executable: "/nonexistent/fake-agent",
  start: async () => {
    throw new Error("not launched in this test");
  },
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-world-supervisor-"));
  root = join(directory, "project");
  mkdirSync(root);
  db = new MarinaDB(join(directory, "world.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  engine.worldSupervisor.setStartDefaultsForTests({
    url: "http://local.test",
    fetch: inProcess,
    adapters: [fakeAdapter],
    stateDirectory: join(directory, "supervisor"),
  });
  resetHttpRateLimitersForTests();
});
afterEach(async () => {
  await engine.shutdown();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function person(name: string, conn = new MockConnection(`c-${name}`)) {
  engine.addConnection(conn);
  const login = engine.login(conn.id, name);
  if ("error" in login) throw new Error(login.error);
  const entity = engine.entities.get(login.entityId)!;
  entity.properties.rank = 9;
  grantGatesForRank(db, entity.id, 9);
  return { conn, entity };
}

const env = () => ({
  MARINA_SUPERVISED_RESIDENTS: "on",
  MARINA_CODE_ROOTS: root,
  MARINA_SUPERVISOR_AUTOSTART: undefined,
});

describe("in-world supervisor", () => {
  it("a person starts it in a code root; it holds a supervision credential until stopped", async () => {
    using _state = scopeProcessState({ env: env(), rateLimitBypass: true });
    const owner = person("Owner");
    await engine.processCommand(owner.entity.id, "supervisor start label:Desk");
    expect(owner.conn.lastText()).toContain("Supervisor started");
    const status = engine.worldSupervisor.status();
    expect(status).toMatchObject({ running: true, owner: "Owner", label: "Desk" });
    expect(status.adapters).toEqual(["Fake agent"]);

    // Its supervisor session joined the routing API as the person.
    const raw = (db as unknown as { db: Database }).db;
    const session = raw
      .query("SELECT kind, label FROM routing_sessions WHERE id = ?")
      .get(status.sessionId!) as { kind: string; label: string } | null;
    expect(session).toMatchObject({ kind: "supervisor", label: "Desk" });
    const live = () =>
      (
        raw
          .query(
            "SELECT COUNT(*) AS n FROM principal_credentials WHERE audience = 'marina:routing' AND revoked_at IS NULL",
          )
          .get() as { n: number }
      ).n;
    expect(live()).toBe(1);

    // Readiness says it runs.
    const check = supervisedResidentsCheck(engine, env());
    expect(check.detail).toContain("in-world supervisor running for Owner");
    await engine.processCommand(owner.entity.id, "supervisor");
    expect(owner.conn.lastText()).toContain("Desk");

    // The boot record names it; an explicit stop clears it and revokes the credential.
    expect(savedWorldSupervisor(db)).toMatchObject({ owner: "Owner", label: "Desk" });
    await engine.processCommand(owner.entity.id, "supervisor stop");
    expect(owner.conn.lastText()).toContain("Supervisor stopped");
    expect(engine.worldSupervisor.running).toBe(false);
    expect(live()).toBe(0);
    expect(savedWorldSupervisor(db)).toBeUndefined();
    expect(supervisedResidentsCheck(engine, env()).detail).toContain("not running");
  });

  it("an agent never starts it", async () => {
    using _state = scopeProcessState({ env: env(), rateLimitBypass: true });
    const conn = new MockConnection("c-bot");
    (conn as MockConnection & { agent?: boolean }).agent = true;
    const bot = person("Bot", conn);
    await engine.processCommand(bot.entity.id, "supervisor start");
    expect(bot.conn.lastText()).toContain("Only a person");
    expect(engine.worldSupervisor.running).toBe(false);
  });

  it("refuses without a code root, over telnet, and with residents off", async () => {
    {
      using _state = scopeProcessState({
        env: { ...env(), MARINA_CODE_ROOTS: undefined, MARINA_CODE_DEFAULT_ROOT: undefined },
        rateLimitBypass: true,
      });
      const owner = person("Owner");
      await engine.processCommand(owner.entity.id, "supervisor start");
      expect(owner.conn.lastText()).toContain("No code root is configured");
    }
    {
      using _state = scopeProcessState({ env: env(), rateLimitBypass: true });
      const conn = new MockConnection("c-telnet");
      (conn as unknown as { protocol: string }).protocol = "telnet";
      const telnet = person("Teller", conn);
      await engine.processCommand(telnet.entity.id, "supervisor start");
      expect(telnet.conn.lastText()).toContain("not available over telnet");
    }
    {
      using _state = scopeProcessState({
        env: { ...env(), MARINA_SUPERVISED_RESIDENTS: "off" },
        rateLimitBypass: true,
      });
      const owner = person("Other");
      await engine.processCommand(owner.entity.id, "supervisor start");
      expect(owner.conn.lastText()).toContain("needs supervised residents");
    }
    expect(engine.worldSupervisor.running).toBe(false);
  });

  it("only its owner or an operator stops it", async () => {
    using _state = scopeProcessState({ env: env(), rateLimitBypass: true });
    const owner = person("Owner");
    const other = person("Other");
    other.entity.properties.rank = 5;
    await engine.processCommand(owner.entity.id, "supervisor start");
    await engine.processCommand(other.entity.id, "supervisor stop");
    expect(other.conn.lastText()).toContain("belongs to Owner");
    expect(engine.worldSupervisor.running).toBe(true);
    await engine.processCommand(owner.entity.id, "supervisor start");
    expect(owner.conn.lastText()).toContain("already runs");
  });

  it("a shutdown keeps its record; the next boot resumes it", async () => {
    using _state = scopeProcessState({ env: env(), rateLimitBypass: true });
    const owner = person("Owner");
    await engine.processCommand(owner.entity.id, "supervisor start");
    await engine.worldSupervisor.stop({ keep: true });
    expect(engine.worldSupervisor.running).toBe(false);
    expect(savedWorldSupervisor(db)?.owner).toBe("Owner");
    const resumed = await autostartWorldSupervisor(engine.worldSupervisor, db, env());
    expect(resumed).toMatchObject({ running: true, owner: "Owner" });
    // Off: nothing starts.
    await engine.worldSupervisor.stop({ keep: true });
    expect(
      await autostartWorldSupervisor(engine.worldSupervisor, db, {
        ...env(),
        MARINA_SUPERVISOR_AUTOSTART: "off",
      }),
    ).toBeUndefined();
  });
});

describe("in-world supervisor helpers", () => {
  it("native agents never inherit server secrets", () => {
    const out = supervisorAgentEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/x",
      LC_ALL: "C",
      XDG_CONFIG_HOME: "/home/x/.config",
      ANTHROPIC_API_KEY: "placeholder",
      OPENROUTER_API_KEY: "placeholder",
      MODEL_API_KEYS: "placeholder",
      GATEWAY_SECRET: "placeholder",
      MARINA_TOKEN: "placeholder",
      DB_PATH: "/srv/marina.db",
    });
    expect(Object.keys(out).sort()).toEqual(["HOME", "LC_ALL", "PATH", "XDG_CONFIG_HOME"]);
  });

  it("parses MARINA_SUPERVISOR_AUTOSTART", () => {
    expect(supervisorAutostart({})).toEqual({ mode: "resume" });
    expect(supervisorAutostart({ MARINA_SUPERVISOR_AUTOSTART: "off" })).toEqual({ mode: "off" });
    expect(supervisorAutostart({ MARINA_SUPERVISOR_AUTOSTART: "person:Ada" })).toEqual({
      mode: "person",
      owner: "Ada",
    });
    expect(supervisorAutostart({ MARINA_SUPERVISOR_AUTOSTART: "nonsense" })).toEqual({
      mode: "off",
    });
  });

  it("keeps the supervisor inside the configured code roots", () => {
    expect(resolveSupervisorRoot(undefined, {})).toMatchObject({
      error: expect.stringContaining("No code root"),
    });
    expect(resolveSupervisorRoot(undefined, { MARINA_CODE_ROOTS: root })).toEqual({
      root: expect.stringContaining("project"),
    });
    expect(resolveSupervisorRoot("/", { MARINA_CODE_ROOTS: root })).toMatchObject({
      error: expect.stringContaining("outside allowed roots"),
    });
  });
});
