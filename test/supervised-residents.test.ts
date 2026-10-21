// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { respawnsOnBoot } from "../src/engine/auto-respawn";
import {
  listAnswerable,
  listRaisedBy,
  principalKind,
  raiseForCommand,
  resetChallengesForTests,
  settleChallenge,
} from "../src/engine/challenges";
import { Engine } from "../src/engine/engine";
import { grantGatesForRank } from "../src/engine/safety-gates";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { MarinaDB } from "../src/persistence/database";
import type { AgentAdapter, AgentOptions } from "../src/routing/agent-adapters";
import { type ResidentConnector, relayText } from "../src/routing/resident-connection";
import {
  generateResidentName,
  nameMentionsVendor,
  RESIDENT_NAME_WORDS,
} from "../src/routing/resident-name";
import { openResidentRelay, type RelayReply, relayCommand } from "../src/routing/resident-relay";
import { ResidentService, residentLabeler } from "../src/routing/residents";
import { RoutingService } from "../src/routing/service";
import { MarinaSupervisor } from "../src/routing/supervisor";
import { formatResidentLabel } from "../src/sdk/resident-label";
import { MarinaRoutingClient, RoutingApiError } from "../src/sdk/routing-client";
import type { RuntimeControl } from "../src/sdk/routing-runtime-types";
import type { RoutingSession } from "../src/sdk/routing-types";
import { type EntityId, roomId } from "../src/types";
import { git, gitInit } from "./git-helpers";
import { MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";
import { scopeProcessState } from "./process-state";

const ON = { MARINA_SUPERVISED_RESIDENTS: "on" };
const OFF = { MARINA_SUPERVISED_RESIDENTS: undefined };

let directory: string;
let db: MarinaDB;
let engine: Engine;

beforeEach(() => {
  resetChallengesForTests();
  directory = mkdtempSync(join(tmpdir(), "marina-residents-"));
  db = new MarinaDB(join(directory, "world.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  engine.registerRoom(roomId("test/lab"), makeTestRoom({ short: "Lab" }));
  resetHttpRateLimitersForTests();
});
afterEach(async () => {
  await engine.shutdown();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

/** A logged-in person; `gates` gives the rank-9 grants (agent.spawn, code.exec). */
function person(name: string, gates = true, conn = new MockConnection(`c-${name}`)) {
  engine.addConnection(conn);
  const login = engine.login(conn.id, name);
  if ("error" in login) throw new Error(login.error);
  const entity = engine.entities.get(login.entityId)!;
  if (gates) {
    entity.properties.rank = 9;
    grantGatesForRank(db, entity.id, 9);
  }
  return { conn, entity, token: login.token };
}

/** A routing client whose requests reach the real dashboard API in-process. */
function routingClient(token: string, log?: string[]) {
  return new MarinaRoutingClient({
    url: "http://local.test",
    token,
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      log?.push(new URL(req.url).pathname);
      return (await handleDashboardApi(req, new URL(req.url), req.method, engine, db))!;
    }) as typeof fetch,
  });
}

async function post(token: string, path: string, body: unknown) {
  const req = new Request(`http://local.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = (await handleDashboardApi(req, new URL(req.url), "POST", engine, db))!;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A relay runner over a test connection: the command's own replies, as `marina connect` prints them. */
function relayThrough(conn: MockConnection, entityId: EntityId) {
  return async (input: string): Promise<RelayReply> => {
    const before = conn.messages.length;
    await engine.processCommand(entityId, input);
    return { ok: true, output: relayText(conn.messages.slice(before)) };
  };
}

/** Log the resident in the way the supervisor's connector does: its own credential. */
function residentLogin(name: string, token: string, conn = new MockConnection(`r-${name}`)) {
  engine.addConnection(conn);
  const login = engine.login(conn.id, name, token);
  if ("error" in login) throw new Error(login.error);
  return { conn, entity: engine.entities.get(login.entityId)! };
}

describe("switch off", () => {
  it("leaves the resident endpoints byte-identical to an unknown routing endpoint", async () => {
    using _state = scopeProcessState({ env: OFF, rateLimitBypass: true });
    const owner = person("Owner");
    const unknown = await post(owner.token, "/api/routing/nonexistent", {});
    for (const path of [
      "/api/routing/residents",
      "/api/routing/residents/Wren/renew",
      "/api/routing/residents/Wren/revoke",
    ])
      expect(await post(owner.token, path, { sessionId: "x" })).toEqual(unknown);
    expect(residentLabeler(db)!("Owner")).toBe("Owner");
    expect(db.getAllAgentConfigs()).toEqual([]);
  });

  it("starts native processes with the supervisor's environment unchanged", async () => {
    using _state = scopeProcessState({ env: OFF, rateLimitBypass: true });
    const owner = person("Owner");
    const log: string[] = [];
    const client = routingClient(owner.token, log);
    let env: NodeJS.ProcessEnv | undefined;
    const prompts: string[] = [];
    const adapter: AgentAdapter & { executable: string } = {
      id: "claude",
      label: "Fixture",
      executable: "fixture",
      start: async (options) => {
        env = options.env;
        return {
          prompt: async (text) => void prompts.push(text),
          interrupt: async () => undefined,
          stop: () => undefined,
        };
      },
    };
    const supervisor = new MarinaSupervisor({
      client,
      root: directory,
      stateDirectory: directory,
      binding: "off",
      label: "off",
      adapters: [adapter],
      agentEnvironment: { MARINA_URL: "http://local.test", MARINA_TOKEN: owner.token },
      secrets: [owner.token],
    });
    const router = new RoutingService(db, db.durableEntityKey(owner.entity.id));
    try {
      const supervisorSession = await supervisor.start();
      router.control(supervisorSession.id, {
        targetId: supervisorSession.id,
        clientMessageId: "launch",
        control: {
          action: "launch",
          adapter: "claude",
          label: "worker",
          workspace: "shared",
          prompt: "hello",
        },
      });
      await supervisor.tick();
      await until(() => prompts.length === 1);
      const run = router.list().sessions.find((s) => s.kind === "claude")!;
      expect(env).toEqual({
        MARINA_URL: "http://local.test",
        MARINA_TOKEN: owner.token,
        MARINA_SESSION_ID: run.id,
      });
      expect(prompts).toEqual(["\n\nhello"]);
      expect(log.some((path) => path.includes("/residents"))).toBe(false);
      expect(db.getAllAgentConfigs()).toEqual([]);
    } finally {
      await supervisor.stop();
      supervisor.close();
    }
  });
});

describe("naming", () => {
  it("picks pronounceable free names that never contain the vendor", () => {
    for (const vendor of ["claude", "codex", "pi"]) {
      for (let i = 0; i < 50; i++) {
        const name = generateResidentName(vendor, () => false)!;
        expect(nameMentionsVendor(name, vendor)).toBe(false);
        expect(name).toMatch(/^[A-Za-z0-9_]{2,20}$/);
      }
    }
    expect(RESIDENT_NAME_WORDS.filter((w) => nameMentionsVendor(w, "pi"))).toContain("Pike");
    const taken = new Set(RESIDENT_NAME_WORDS);
    const suffixed = generateResidentName("claude", (n) => taken.has(n))!;
    expect(suffixed).toMatch(/^[A-Za-z]+\d{2}$/);
    expect(generateResidentName("claude", () => true)).toBeUndefined();
    expect(formatResidentLabel("Wren", "claude")).toBe("Wren [claude]");
    expect(formatResidentLabel("Wren", null)).toBe("Wren");
  });
});

describe("enrolment", () => {
  it("enrols, renews and revokes a resident owned by the launching person", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const owner = person("Owner");
    const router = new RoutingService(db, db.durableEntityKey(owner.entity.id));
    const run = router.join({ clientKey: "run:1", kind: "claude", label: "worker" });
    const enrolled = await post(owner.token, "/api/routing/residents", { sessionId: run.id });
    expect(enrolled.status).toBe(200);
    const name = enrolled.body.name as string;
    const credential = enrolled.body.credential as { token: string; expiresAt: number };
    expect(nameMentionsVendor(name, "claude")).toBe(false);
    expect(enrolled.body).toMatchObject({ vendor: "claude", room: "test/start", reused: false });
    expect(credential.token.startsWith("marina-agent-")).toBe(true);
    expect(credential.expiresAt - Date.now()).toBeLessThanOrEqual(24 * 60 * 60_000);
    const config = db.getAgentConfig(name)!;
    expect(config).toMatchObject({
      runtime: "supervised",
      vendor: "claude",
      spawned_by: "Owner",
      run_session: run.id,
      room: "test/start",
    });
    const principal = db.verifyWorkloadCredential(credential.token)!;
    expect(principal.display_name).toBe(name);
    expect(principal.owner_principal_id).toBe(db.getPrincipal("human", "Owner")!.principal_id);
    // Lineage resolves the person through the existing paths.
    expect(db.spawnLineage(name)).toEqual([name.toLowerCase(), "owner"]);

    // Renew: only the run that holds the resident; the old credential stops working.
    const other = router.join({ clientKey: "run:2", kind: "claude", label: "other" });
    expect(
      (await post(owner.token, `/api/routing/residents/${name}/renew`, { sessionId: other.id }))
        .body.code,
    ).toBe("run_mismatch");
    const renewed = await post(owner.token, `/api/routing/residents/${name}/renew`, {
      sessionId: run.id,
    });
    const next = (renewed.body.credential as { token: string }).token;
    expect(next).not.toBe(credential.token);
    expect(db.verifyWorkloadCredential(credential.token)).toBeUndefined();
    expect(db.verifyWorkloadCredential(next)?.display_name).toBe(name);

    // A stale run's revoke never ends the live run's credential.
    expect(
      (await post(owner.token, `/api/routing/residents/${name}/revoke`, { sessionId: other.id }))
        .body,
    ).toEqual({ name, revoked: 0 });
    expect(db.verifyWorkloadCredential(next)).toBeDefined();
    const revoked = await post(owner.token, `/api/routing/residents/${name}/revoke`, {
      sessionId: run.id,
    });
    expect(revoked.body).toEqual({ name, revoked: 1 });
    expect(db.verifyWorkloadCredential(next)).toBeUndefined();
    expect(db.getAgentConfig(name)!.run_session).toBeNull();

    // Relaunching the same name by the same person reuses the account.
    const again = await post(owner.token, "/api/routing/residents", {
      sessionId: other.id,
      name,
      room: "test/lab",
    });
    expect(again.body).toMatchObject({ name, reused: true, room: "test/lab" });
    expect(db.getAgentConfig(name)!.run_session).toBe(other.id);
  });

  it("refuses names held by other accounts and other owners' residents", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const owner = person("Owner");
    const rival = person("Rival");
    const ownerRouter = new RoutingService(db, db.durableEntityKey(owner.entity.id));
    const rivalRouter = new RoutingService(db, db.durableEntityKey(rival.entity.id));
    const run = ownerRouter.join({ clientKey: "run", kind: "codex", label: "w" });
    const rivalRun = rivalRouter.join({ clientKey: "run", kind: "codex", label: "w" });
    expect(
      (await post(owner.token, "/api/routing/residents", { sessionId: run.id, name: "Wren" }))
        .status,
    ).toBe(200);
    // Another person's resident, a person's account (any case), an in-process agent.
    db.saveAgentConfig({ name: "Helper", model: "marina/default", spawnedBy: "Rival" });
    for (const name of ["Wren", "wren", "Owner", "owner", "Helper"]) {
      const res = await post(rival.token, "/api/routing/residents", {
        sessionId: rivalRun.id,
        name,
      });
      expect([res.status, res.body.code]).toEqual([409, "name_taken"]);
    }
    // Renew / revoke another person's resident: not found, nothing revealed.
    for (const action of ["renew", "revoke"]) {
      const res = await post(rival.token, `/api/routing/residents/Wren/${action}`, {
        sessionId: rivalRun.id,
      });
      expect([res.status, res.body.code]).toEqual([404, "not_found"]);
    }
    // Enrolling against someone else's session is refused.
    expect((await post(rival.token, "/api/routing/residents", { sessionId: run.id })).status).toBe(
      404,
    );
    // A supervisor session is not an agent run.
    const sup = ownerRouter.join({ clientKey: "sup", kind: "supervisor", label: "s" });
    expect((await post(owner.token, "/api/routing/residents", { sessionId: sup.id })).status).toBe(
      400,
    );
    // Invalid requested names.
    for (const name of ["a", "has space", "x".repeat(21), "System"])
      expect(
        (await post(owner.token, "/api/routing/residents", { sessionId: run.id, name })).body.code,
      ).toBe("invalid_name");
  });

  it("needs the caller's own agent.spawn gate and a person", async () => {
    using _state = scopeProcessState({ env: ON, trustProfile: "shared" });
    const plain = person("Plain", false);
    const router = new RoutingService(db, db.durableEntityKey(plain.entity.id));
    const run = router.join({ clientKey: "run", kind: "claude", label: "w" });
    const denied = await post(plain.token, "/api/routing/residents", { sessionId: run.id });
    expect(denied.status).toBe(403);
    expect(denied.body.gate).toBe("agent.spawn");
    expect(db.getAllAgentConfigs()).toEqual([]);

    // An agent account never launches residents, even holding the gate.
    const agent = person("Robo");
    db.saveAgentConfig({ name: "Robo", model: "marina/default", spawnedBy: "Owner" });
    const agentRouter = new RoutingService(db, db.durableEntityKey(agent.entity.id));
    const agentRun = agentRouter.join({ clientKey: "run", kind: "claude", label: "w" });
    const refused = await post(agent.token, "/api/routing/residents", { sessionId: agentRun.id });
    expect([refused.status, refused.body.code]).toEqual([403, "person_required"]);
  });
});

describe("a resident in the world", () => {
  async function enrolResident(name = "Wren") {
    const owner = person("Owner");
    const router = new RoutingService(db, db.durableEntityKey(owner.entity.id));
    const run = router.join({ clientKey: `run:${name}`, kind: "claude", label: "worker" });
    const res = await post(owner.token, "/api/routing/residents", { sessionId: run.id, name });
    return {
      owner,
      router,
      run,
      token: (res.body.credential as { token: string }).token,
    };
  }

  it("is an agent: never sovereign under local, never an approver; its owner answers for it", async () => {
    using _state = scopeProcessState({ env: ON, trustProfile: "local", rateLimitBypass: true });
    const { owner, token } = await enrolResident();
    const resident = residentLogin("Wren", token);
    expect(resident.conn.internal).toBe(true);
    expect((resident.entity.properties.rank as number) ?? 0).toBeLessThan(9);
    expect(db.getUserByName("Wren")!.rank).toBeLessThan(9);
    expect(principalKind(resident.entity)).toBe("agent");

    // A person's held command: the resident can never answer it.
    const asker = person("Asker", false);
    const held = raiseForCommand({
      requesterId: asker.entity.id,
      command: "agent spawn Helper",
      reason: "needs a gate",
      gateId: "agent.spawn",
    });
    expect(held).toContain("challenge");
    const token1 = listRaisedBy(asker.entity.id)[0]!.token;
    expect(settleChallenge(token1, resident.entity, "once")).toMatchObject({
      ok: false,
      error: "agent",
    });
    // The resident's own hold is answered by the person who launched it.
    raiseForCommand({
      requesterId: resident.entity.id,
      command: "agent spawn Helper",
      reason: "needs a gate",
      gateId: "agent.spawn",
    });
    const own = listRaisedBy(resident.entity.id)[0]!;
    expect(own.creatorName).toBe("Owner");
    expect(listAnswerable(owner.entity).map((c) => c.token)).toContain(own.token);
  });

  it("a remote supervisor's resident is authenticated but not a host-trusted connection", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const { token } = await enrolResident();
    const remote = new MockConnection("remote");
    remote.peerIp = "203.0.113.9";
    const resident = residentLogin("Wren", token, remote);
    expect(resident.entity.name).toBe("Wren");
    expect(remote.internal).toBeFalsy();
    expect(principalKind(resident.entity)).toBe("agent");
  });

  it("its credential never upgrades another account's reconnect", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const { token } = await enrolResident();
    // Another account's session (a remote, rank-capped login).
    const remote = new MockConnection("remote-person");
    remote.peerIp = "203.0.113.10";
    engine.addConnection(remote);
    const login = engine.login(remote.id, "Victim");
    if ("error" in login) throw new Error(login.error);
    engine.removeConnection(remote.id, "explicit");
    const again = new MockConnection("again");
    again.peerIp = "203.0.113.10";
    engine.addConnection(again);
    const result = engine.reconnect(again.id, login.token, token);
    expect(result).toEqual({
      error: "Workload credential subject does not match the requested identity.",
    });
    expect(again.internal).toBeFalsy();
  });

  it("is never respawned or run by the in-process runtime", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    await enrolResident();
    expect(respawnsOnBoot(db.getAgentConfig("Wren")!)).toBe(false);
    expect(respawnsOnBoot({ runtime: "internal" })).toBe(true);
    await expect(engine.agentRuntime.spawn({ name: "Wren", spawnedBy: "Owner" })).rejects.toThrow(
      "supervised resident",
    );
    expect(await engine.agentRuntime.init()).toBe(0);
    expect(engine.agentRuntime.get("Wren")).toBeUndefined();
  });

  it("telnet cannot launch it: the in-world spawn path refuses the account", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    await enrolResident();
    const telnet = new MockConnection("telnet");
    (telnet as { protocol: string }).protocol = "telnet";
    const op = person("Telly", true, telnet);
    const available = engine.agentRuntime.isAvailable;
    engine.agentRuntime.isAvailable = () => true;
    try {
      await engine.processCommand(op.entity.id, "agent spawn Wren");
    } finally {
      engine.agentRuntime.isAvailable = available;
    }
    expect(stripAnsi(telnet.allText().join("\n"))).toContain("supervised resident");
    expect(engine.agentRuntime.get("Wren")).toBeUndefined();
    expect(db.getAgentConfig("Wren")!.spawned_by).toBe("Owner");
  });

  it("`agent stop` sends a stop control to the owner's supervisor; others are refused", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const { owner, router, run } = await enrolResident();
    const rival = person("Rival");
    await engine.processCommand(rival.entity.id, "agent stop Wren");
    expect(stripAnsi(rival.conn.lastText())).toContain("owner");
    expect(router.inbox(run.id)).toHaveLength(0);
    await engine.processCommand(owner.entity.id, "agent stop Wren");
    expect(stripAnsi(owner.conn.lastText())).toContain("Stop sent");
    expect(router.inbox(run.id).map((m) => [m.kind, m.payload])).toEqual([
      ["marina.control", { action: "stop" }],
    ]);
  });

  it("shows as `Wren [claude]` in rosters while commands keep the plain name", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const { owner, token } = await enrolResident();
    const resident = residentLogin("Wren", token);
    await engine.processCommand(owner.entity.id, "who");
    expect(stripAnsi(owner.conn.lastText())).toContain("Wren [claude]");
    await engine.processCommand(owner.entity.id, "look");
    expect(stripAnsi(owner.conn.lastText())).toContain("Wren [claude]");
    await engine.processCommand(owner.entity.id, "agent list");
    expect(stripAnsi(owner.conn.lastText())).toMatch(/Wren \[claude\] \[online\] owner:Owner/);
    await engine.processCommand(resident.entity.id, "orient");
    expect(stripAnsi(resident.conn.lastText())).toContain("Wren [claude] — owned by Owner");
    expect(residentLabeler(db)!("Owner")).toBe("Owner");
  });
});

describe("supervisor", () => {
  it("runs the agent as its resident: own credential in the child env, never the operator's", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const owner = person("Owner");
    const client = routingClient(owner.token);
    let env: NodeJS.ProcessEnv | undefined;
    let native: AgentOptions | undefined;
    const prompts: string[] = [];
    const residentConns: MockConnection[] = [];
    let credential = "";
    const connector: ResidentConnector = async ({ name, token, room }) => {
      credential = token;
      const { conn, entity } = residentLogin(name, token);
      residentConns.push(conn);
      if (room) await engine.processCommand(entity.id as EntityId, `goto ${room}`);
      return {
        setCredential: () => undefined,
        command: relayThrough(conn, entity.id as EntityId),
        close: () => engine.removeConnection(conn.id, "explicit"),
      };
    };
    const adapter: AgentAdapter & { executable: string } = {
      id: "claude",
      label: "Fixture",
      executable: "fixture",
      start: async (options) => {
        env = options.env;
        native = options;
        return {
          prompt: async (text) => {
            prompts.push(text);
            options.emit("output", { text: `leak ${credential}` });
          },
          interrupt: async () => undefined,
          stop: () => undefined,
        };
      },
    };
    const supervisor = new MarinaSupervisor({
      client,
      root: directory,
      stateDirectory: directory,
      binding: "on",
      label: "on",
      adapters: [adapter],
      agentEnvironment: {
        MARINA_URL: "http://local.test",
        MARINA_TOKEN: owner.token,
        COPY_OF_TOKEN: `Bearer ${owner.token}`,
        HOME: "/home/test",
      },
      secrets: [owner.token],
      residents: { connect: connector },
    });
    const router = new RoutingService(db, db.durableEntityKey(owner.entity.id));
    try {
      const sup = await supervisor.start();
      const control = (target: RoutingSession, value: RuntimeControl) =>
        router.control(sup.id, {
          targetId: target.id,
          clientMessageId: crypto.randomUUID(),
          control: value,
        });
      control(sup, {
        action: "launch",
        adapter: "claude",
        label: "worker",
        workspace: "shared",
        name: "Wren",
        room: "test/lab",
        prompt: "hello",
      });
      await supervisor.tick();
      await until(() => prompts.length === 1);
      const run = router.list().sessions.find((s) => s.kind === "claude")!;
      expect(credential.startsWith("marina-agent-")).toBe(true);
      expect(db.verifyWorkloadCredential(credential)?.display_name).toBe("Wren");
      // The child holds no world credential at all: only the relay's path.
      for (const value of Object.values(env!)) {
        expect(value).not.toContain(owner.token);
        expect(value).not.toContain(credential);
      }
      const socket = env!.MARINA_RELAY_SOCKET!;
      expect(env).toEqual({
        MARINA_URL: "http://local.test",
        HOME: "/home/test",
        MARINA_SESSION_ID: run.id,
        MARINA_RELAY_SOCKET: socket,
      });
      expect(statSync(socket).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(socket)).mode & 0o777).toBe(0o700);
      // A relay command runs on the resident's own connection, as the resident.
      const peer = person("Peer", false);
      const sent = await relayCommand(socket, "tell Peer hello from the relay");
      expect(sent.ok).toBe(true);
      await until(() =>
        peer.conn.allText().some((t) => stripAnsi(t).includes("hello from the relay")),
      );
      expect(peer.conn.allText().find((t) => t.includes("hello from the relay"))).toContain("Wren");
      expect(prompts[0]).toContain("Your Marina world name is Wren.");
      const wren = engine.entities.findAgentByName("Wren")!;
      expect(wren.room as string).toBe("test/lab");
      // The resident's credential is redacted from published output.
      await until(async () => {
        await supervisor.tick();
        return router.events(run.id).events.some((e) => e.kind === "output");
      });
      const output = router.events(run.id).events.find((e) => e.kind === "output")!;
      expect(JSON.stringify(output.payload)).not.toContain(credential);
      expect(JSON.stringify(router.events(run.id).events)).not.toContain(credential);

      // Stop: the resident disconnects and its credential is revoked.
      control(run, { action: "stop" });
      await until(async () => {
        await supervisor.tick();
        return !db.verifyWorkloadCredential(credential);
      });
      expect(db.getAgentConfig("Wren")!.run_session).toBeNull();
      expect(engine.getConnectionForEntity(wren.id)).toBeUndefined();
      // Revocation closes the relay with the connection.
      expect(existsSync(socket)).toBe(false);
      await expect(relayCommand(socket, "who")).rejects.toThrow("relay unavailable");
      expect(native).toBeDefined();
    } finally {
      await supervisor.stop();
      supervisor.close();
    }
  });

  it("keeps the relay through a credential renewal; the child never sees either credential", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const owner = person("Owner");
    const real = routingClient(owner.token);
    const client = Object.assign(Object.create(real) as MarinaRoutingClient, {
      enrolResident: async (input: Parameters<MarinaRoutingClient["enrolResident"]>[0]) => {
        const result = await real.enrolResident(input);
        return { ...result, credential: { ...result.credential, expiresAt: Date.now() + 400 } };
      },
    });
    const credentials: string[] = [];
    let env: NodeJS.ProcessEnv | undefined;
    const supervisor = new MarinaSupervisor({
      client,
      root: directory,
      stateDirectory: directory,
      binding: "relay",
      label: "relay",
      adapters: [
        {
          id: "claude",
          label: "Fixture",
          executable: "fixture",
          start: async (options) => {
            env = options.env;
            return {
              prompt: async () => undefined,
              interrupt: async () => undefined,
              stop: () => undefined,
            };
          },
        },
      ],
      agentEnvironment: { MARINA_TOKEN: owner.token },
      secrets: [owner.token],
      residents: {
        connect: async ({ name, token }) => {
          credentials.push(token);
          const { conn, entity } = residentLogin(name, token);
          return {
            setCredential: (next) => void credentials.push(next),
            command: relayThrough(conn, entity.id as EntityId),
            close: () => engine.removeConnection(conn.id, "explicit"),
          };
        },
      },
    });
    const router = new RoutingService(db, db.durableEntityKey(owner.entity.id));
    try {
      const sup = await supervisor.start();
      router.control(sup.id, {
        targetId: sup.id,
        clientMessageId: "launch",
        control: { action: "launch", adapter: "claude", label: "w", workspace: "shared" },
      });
      await supervisor.tick();
      await until(() => !!env?.MARINA_RELAY_SOCKET);
      const socket = env!.MARINA_RELAY_SOCKET!;
      const run = router.list().sessions.find((s) => s.kind === "claude")!;
      await until(async () => {
        await supervisor.tick();
        return router.events(run.id).events.some((e) => e.kind === "resident.renewed");
      });
      expect(credentials).toHaveLength(2);
      const reply = await relayCommand(socket, "who");
      expect(reply.ok).toBe(true);
      expect(reply.output).toContain("Owner");
      for (const value of Object.values(env!))
        for (const credential of [owner.token, ...credentials])
          expect(value).not.toContain(credential);
    } finally {
      await supervisor.stop();
      supervisor.close();
    }
  });

  it("stops delivering when renewal fails and never falls back to the operator token", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const owner = person("Owner");
    const real = routingClient(owner.token);
    let failRenewal = true;
    const credentials: string[] = [];
    // Real enrolment, then a renewal the server cannot answer; short expiry.
    const client = Object.assign(Object.create(real) as MarinaRoutingClient, {
      enrolResident: async (input: Parameters<MarinaRoutingClient["enrolResident"]>[0]) => {
        const result = await real.enrolResident(input);
        return { ...result, credential: { ...result.credential, expiresAt: Date.now() + 300 } };
      },
      renewResident: async (name: string, sessionId: string) => {
        if (failRenewal) throw new RoutingApiError(503, "unavailable", "renewal unavailable");
        return real.renewResident(name, sessionId);
      },
    });
    const prompts: string[] = [];
    const supervisor = new MarinaSupervisor({
      client,
      root: directory,
      stateDirectory: directory,
      binding: "renew",
      label: "renew",
      adapters: [
        {
          id: "claude",
          label: "Fixture",
          executable: "fixture",
          start: async () => ({
            prompt: async (text) => void prompts.push(text),
            interrupt: async () => undefined,
            stop: () => undefined,
          }),
        },
      ],
      agentEnvironment: { MARINA_TOKEN: owner.token },
      secrets: [owner.token],
      residents: {
        connect: async ({ token }) => {
          credentials.push(token);
          return {
            setCredential: (next) => void credentials.push(next),
            command: async (input) => ({ ok: true, output: `ran ${input}` }),
            close: () => undefined,
          };
        },
      },
    });
    const router = new RoutingService(db, db.durableEntityKey(owner.entity.id));
    try {
      const sup = await supervisor.start();
      router.control(sup.id, {
        targetId: sup.id,
        clientMessageId: "launch",
        control: { action: "launch", adapter: "claude", label: "w", workspace: "shared" },
      });
      await supervisor.tick();
      const run = await (async () => {
        await until(() => router.list().sessions.some((s) => s.kind === "claude"));
        return router.list().sessions.find((s) => s.kind === "claude")!;
      })();
      await until(async () => {
        await supervisor.tick();
        return router.events(run.id).events.some((e) => e.kind === "resident.renewal_failed");
      });
      router.control(sup.id, {
        targetId: run.id,
        clientMessageId: "p1",
        control: { action: "prompt", text: "must wait" },
      });
      for (let i = 0; i < 3; i++) await supervisor.tick();
      expect(prompts).toEqual([]);
      expect(credentials).not.toContain(owner.token);
      expect(credentials).toHaveLength(1);
      failRenewal = false;
    } finally {
      await supervisor.stop();
      supervisor.close();
    }
  });

  it("fails the launch, never the operator's token, when the server has residents off", async () => {
    const owner = (() => {
      using _off = scopeProcessState({ env: OFF, rateLimitBypass: true });
      return person("Owner");
    })();
    using _state = scopeProcessState({ env: OFF, rateLimitBypass: true });
    let started = false;
    const supervisor = new MarinaSupervisor({
      client: routingClient(owner.token),
      root: directory,
      stateDirectory: directory,
      binding: "mismatch",
      label: "mismatch",
      adapters: [
        {
          id: "claude",
          label: "Fixture",
          executable: "fixture",
          start: async () => {
            started = true;
            return {
              prompt: async () => undefined,
              interrupt: async () => undefined,
              stop: () => {},
            };
          },
        },
      ],
      agentEnvironment: { MARINA_TOKEN: owner.token },
      secrets: [owner.token],
      residents: {
        connect: async () => ({
          setCredential: () => {},
          command: async () => ({ ok: true, output: "" }),
          close: () => {},
        }),
      },
    });
    const router = new RoutingService(db, db.durableEntityKey(owner.entity.id));
    try {
      const sup = await supervisor.start();
      router.control(sup.id, {
        targetId: sup.id,
        clientMessageId: "launch",
        control: { action: "launch", adapter: "claude", label: "w", workspace: "shared" },
      });
      await supervisor.tick();
      await until(async () => {
        await supervisor.tick();
        const run = router.list().sessions.find((s) => s.kind === "claude");
        return !!run && (router.runtime(run.id) as { status?: string } | null)?.status === "failed";
      });
      const run = router.list().sessions.find((s) => s.kind === "claude")!;
      expect((router.runtime(run.id) as { error: string }).error).toContain(
        "MARINA_SUPERVISED_RESIDENTS",
      );
      expect(started).toBe(false);
    } finally {
      await supervisor.stop();
      supervisor.close();
    }
  });
});

describe("command relay", () => {
  it("returns each reply, refusals included, and rejects malformed requests", async () => {
    const seen: string[] = [];
    const relay = await openResidentRelay(async (command) => {
      seen.push(command);
      return command === "bad"
        ? { ok: false, output: "Unknown command" }
        : { ok: true, output: "ok" };
    });
    try {
      expect(await relayCommand(relay.path, "  look ")).toEqual({ ok: true, output: "ok" });
      expect(await relayCommand(relay.path, "bad")).toEqual({
        ok: false,
        output: "Unknown command",
      });
      expect((await relayCommand(relay.path, "   ")).ok).toBe(false);
      expect(seen).toEqual(["look", "bad"]);
    } finally {
      relay.close();
    }
    await expect(relayCommand(relay.path, "look")).rejects.toThrow("relay unavailable");
  });
});

describe("service", () => {
  it("caps credential lifetime at 24 hours", () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const owner = person("Owner");
    const key = db.durableEntityKey(owner.entity.id);
    const router = new RoutingService(db, key);
    const run = router.join({ clientKey: "run", kind: "pi", label: "w" });
    const world = {
      findLive: () => undefined,
      isConnected: () => false,
      hasRoom: () => true,
      roomOf: () => undefined,
      revokeSessions: () => undefined,
    };
    const service = new ResidentService(db, key, owner.entity.id, world, {
      ttlMs: 7 * 24 * 60 * 60_000,
    });
    const enrolled = service.enrol({ sessionId: run.id });
    expect(enrolled.credential.expiresAt - Date.now()).toBeLessThanOrEqual(24 * 60 * 60_000);
    expect(nameMentionsVendor(enrolled.name, "pi")).toBe(false);
  });
});

describe("review snapshots through the relay", () => {
  it("attaches the worktree's changes to a resident's review request", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const repo = join(directory, "repo");
    mkdirSync(repo);
    gitInit(repo);
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "new.ts"), "export const fresh = true;\n");
    const owner = person("Owner");
    person("Peer", false);
    let env: NodeJS.ProcessEnv | undefined;
    const connector: ResidentConnector = async ({ name, token }) => {
      const { conn, entity } = residentLogin(name, token);
      return {
        setCredential: () => undefined,
        command: relayThrough(conn, entity.id as EntityId),
        close: () => engine.removeConnection(conn.id, "explicit"),
      };
    };
    const adapter: AgentAdapter & { executable: string } = {
      id: "claude",
      label: "Fixture",
      executable: "fixture",
      start: async (options) => {
        env = options.env;
        return { prompt: async () => undefined, interrupt: async () => undefined, stop: () => {} };
      },
    };
    const supervisor = new MarinaSupervisor({
      client: routingClient(owner.token),
      root: directory,
      stateDirectory: directory,
      binding: "review",
      label: "review",
      adapters: [adapter],
      agentEnvironment: { HOME: "/home/test" },
      secrets: [owner.token],
      residents: { connect: connector },
    });
    const router = new RoutingService(db, db.durableEntityKey(owner.entity.id));
    try {
      const sup = await supervisor.start();
      router.control(sup.id, {
        targetId: sup.id,
        clientMessageId: crypto.randomUUID(),
        control: {
          action: "launch",
          adapter: "claude",
          label: "worker",
          workspace: "shared",
          directory: "repo",
          name: "Wren",
        },
      });
      await supervisor.tick();
      await until(() => !!env?.MARINA_RELAY_SOCKET);
      const reply = await relayCommand(
        env!.MARINA_RELAY_SOCKET!,
        "code review request Peer snapshot:forged -- bumped a",
      );
      expect(reply.ok).toBe(true);
      const id = /review_[a-z0-9]{12}/.exec(reply.output)?.[0];
      expect(id).toBeDefined();
      const meta = JSON.parse(db.getCodingArtifact(id!)!.metadata_json);
      const snapshot = db.getCodingArtifact(meta.snapshots[0])!;
      expect(snapshot.content_text).toContain("+export const a = 2;");
      expect(snapshot.content_text).toContain("+export const fresh = true;");
      expect(JSON.parse(snapshot.metadata_json)).toMatchObject({
        source: "supervisor",
        claims: "bumped a",
      });
      expect(meta).toMatchObject({ author: "Wren", reviewer: "Peer" });
    } finally {
      await supervisor.stop();
      supervisor.close();
    }
  });
});

describe("Streams room and residents views", () => {
  async function get(token: string, path: string) {
    const req = new Request(`http://local.test${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = (await handleDashboardApi(req, new URL(req.url), "GET", engine, db))!;
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("lists the caller's residents with presence and wakes, and nobody else's", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const owner = person("Owner");
    const other = person("Other");
    const router = new RoutingService(db, db.durableEntityKey(owner.entity.id));
    const run = router.join({ clientKey: "run:v", kind: "codex", label: "worker" });
    const enrolled = await post(owner.token, "/api/routing/residents", { sessionId: run.id });
    const name = enrolled.body.name as string;
    residentLogin(name, (enrolled.body.credential as { token: string }).token);
    engine.logEvent({
      type: "agent_status",
      name,
      status: "waiting",
      steer: "mid-turn",
      timestamp: Date.now(),
    });
    db.recordAttentionWakes([
      {
        entity: name,
        source: "tell",
        decision: "now",
        reason: "request",
        hop: 1,
        steered: true,
        at: 1,
      },
    ]);
    const mine = await get(owner.token, "/api/routing/residents");
    expect(mine.status).toBe(200);
    expect(mine.body.residents).toEqual([
      {
        name,
        vendor: "codex",
        presence: "needs_you",
        room: "test/start",
        wakes: [
          { source: "tell", decision: "now", reason: "request", hop: 1, steered: true, at: 1 },
        ],
      },
    ]);
    expect((await get(other.token, "/api/routing/residents")).body.residents).toEqual([]);
  });

  it("serves the room log only to those present", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const owner = person("Owner");
    const away = person("Away");
    engine.entities.move(away.entity.id, roomId("test/lab"));
    await engine.processCommand(owner.entity.id, "say hello room");
    const here = await get(owner.token, "/api/routing/room-log");
    expect(here.status).toBe(200);
    expect(here.body.room).toBe("test/start");
    expect(JSON.stringify(here.body.entries)).toContain("Owner says: hello room");
    const peek = await get(away.token, "/api/routing/room-log?room=test/start");
    expect(peek.status).toBe(403);
    expect(peek.body.code).toBe("not_present");
  });
});
