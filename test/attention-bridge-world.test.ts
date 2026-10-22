// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetChallengesForTests } from "../src/engine/challenges";
import { commandCompletion, withCommandResponse } from "../src/engine/command-response";
import {
  ownedMessageCause,
  resetDeliveredMessagesForTests,
} from "../src/engine/delivered-messages";
import { Engine } from "../src/engine/engine";
import { grantGatesForRank } from "../src/engine/safety-gates";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { handleParticipantMessage } from "../src/net/participant-messages";
import { MarinaDB } from "../src/persistence/database";
import type { AgentAdapter, AgentOptions } from "../src/routing/agent-adapters";
import { type ResidentConnector, relayText } from "../src/routing/resident-connection";
import { RoutingService } from "../src/routing/service";
import { MarinaSupervisor } from "../src/routing/supervisor";
import { MarinaRoutingClient } from "../src/sdk/routing-client";
import type { RuntimeControl } from "../src/sdk/routing-runtime-types";
import type { RoutingSession } from "../src/sdk/routing-types";
import { type EngineEvent, type EntityId, type Perception, roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";
import { scopeProcessState } from "./process-state";

const ON = { MARINA_SUPERVISED_RESIDENTS: "on" };
const OFF = { MARINA_SUPERVISED_RESIDENTS: "off" };

let directory: string;
let db: MarinaDB;
let engine: Engine;
let events: EngineEvent[];

beforeEach(() => {
  resetChallengesForTests();
  resetDeliveredMessagesForTests();
  directory = mkdtempSync(join(tmpdir(), "marina-attention-"));
  db = new MarinaDB(join(directory, "world.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  events = [];
  engine.addEventListener((event) => events.push(event));
  resetHttpRateLimitersForTests();
});
afterEach(async () => {
  await engine.shutdown();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

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

function routingClient(token: string) {
  return new MarinaRoutingClient({
    url: "http://local.test",
    token,
    fetch: (async (input, init) => {
      const req = new Request(input, init);
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

/** The result a correlated client (the relay, MCP, the SDK) receives for one command. */
async function correlated(conn: MockConnection, entityId: EntityId, input: string) {
  const completions: Perception[] = [];
  await withCommandResponse(
    conn.id,
    "req-1",
    () => engine.processCommand(entityId, input),
    (p) => completions.push(p),
  );
  return completions.at(-1)?.data.command_result as {
    request_id: string;
    ok: boolean;
    error?: string;
  };
}

describe("world messages the bridge relies on", () => {
  it("a refused tell fails the command result, so the relay reports it", async () => {
    const ann = person("Ann", false);
    const result = await correlated(ann.conn, ann.entity.id, "tell Nobody hello?");
    expect(result).toEqual({
      request_id: "req-1",
      ok: false,
      error: 'No one named "Nobody" is online.',
    });
    expect(stripAnsi(ann.conn.lastText())).toContain('No one named "Nobody" is online.');
    expect(commandCompletion("x").data.command_result).toEqual({ request_id: "x", ok: true });
  });

  it("`re #<id>` answers one tell, records it as the cause and acknowledges it", async () => {
    const ann = person("Ann", false);
    const bob = person("Bob", false);
    const fern = person("Fern", false);
    await engine.processCommand(ann.entity.id, "tell Fern which branch has the fix?");
    await engine.processCommand(bob.entity.id, "tell Fern lunch?");
    const first = db.listDirectMessageInbox(fern.entity.id).find((r) => r.sender_name === "Ann")!;
    await engine.processCommand(fern.entity.id, `re #${first.id} feat/parser`);
    const reply = db.listDirectMessageInbox(ann.entity.id)[0]!;
    expect(reply).toMatchObject({ sender_name: "Fern", content: "feat/parser", depth: 1 });
    expect(reply.cause).toBe(`tell:${first.id}`);
    expect(db.getDirectMessage(first.id)!.status).toBe("acknowledged");
    expect(db.listDirectMessageInbox(bob.entity.id)).toHaveLength(0);
    // Someone else's tell is not yours to answer.
    const bobs = db.listDirectMessageInbox(fern.entity.id).find((r) => r.sender_name === "Bob")!;
    const result = await correlated(ann.conn, ann.entity.id, `re #${bobs.id} mine now`);
    expect(result.ok).toBe(false);
  });

  it("a late answer settles a tell whose deadline passed while the recipient was busy", async () => {
    const ann = person("Ann", false);
    const fern = person("Fern", false);
    await engine.processCommand(ann.entity.id, "tell Fern what is 6 times 7?");
    const asked = db.listDirectMessageInbox(fern.entity.id)[0]!;
    // Fern was blocked past the deadline: the sweep marks the tell unanswered.
    db.memoryRepository().raw.run("UPDATE direct_messages SET deadline_at = ? WHERE id = ?", [
      Date.now() - 1,
      asked.id,
    ]);
    expect(db.getDirectMessage(asked.id)!.status).toBe("expired");
    await engine.processCommand(fern.entity.id, `re #${asked.id} 42`);
    const settled = db.getDirectMessage(asked.id)!;
    expect(settled.status).toBe("acknowledged");
    expect(settled.reply_message_id).toBe(db.listDirectMessageInbox(ann.entity.id)[0]!.id);
    await engine.processCommand(ann.entity.id, `tell status ${asked.id}`);
    expect(stripAnsi(ann.conn.lastText())).toContain(
      `Message #${asked.id}: acknowledged after its deadline`,
    );
    // An on-time answer carries no lateness mark.
    await engine.processCommand(ann.entity.id, "tell Fern and 2 plus 2?");
    const second = db.listDirectMessageInbox(fern.entity.id)[0]!;
    await engine.processCommand(fern.entity.id, `re #${second.id} 4`);
    await engine.processCommand(ann.entity.id, `tell status ${second.id}`);
    expect(stripAnsi(ann.conn.lastText())).toContain(`Message #${second.id}: acknowledged ·`);
  });

  it("a command's cause is accepted only for a message delivered to the sender", async () => {
    const ann = person("Ann", false);
    const fern = person("Fern", false);
    await engine.processCommand(ann.entity.id, "tell Fern status of the review?");
    const tell = db.listDirectMessageInbox(fern.entity.id)[0]!;
    expect(ownedMessageCause(fern.entity.id, `tell:${tell.id}`)).toEqual({
      ref: `tell:${tell.id}`,
      depth: 0,
    });
    expect(ownedMessageCause(ann.entity.id, `tell:${tell.id}`)).toBeUndefined();
    expect(ownedMessageCause(fern.entity.id, "tell:99999")).toBeUndefined();

    const sent: string[] = [];
    const ws = { data: { connId: fern.conn.id }, readyState: 1, send: (d: string) => sent.push(d) };
    handleParticipantMessage(engine, ws, {
      type: "command",
      command: "say it is ready",
      request_id: "r1",
      cause: `tell:${tell.id}`,
    });
    await until(() => sent.some((d) => d.includes("command_result")));
    const said = events.find((e) => e.type === "say_sent");
    expect(said).toMatchObject({ from: "Fern", cause: `tell:${tell.id}`, depth: 1 });
    // A forged cause is dropped: the message starts a thread.
    handleParticipantMessage(engine, ws, {
      type: "command",
      command: "say forged",
      request_id: "r2",
      cause: "tell:424242",
    });
    await until(() => events.filter((e) => e.type === "say_sent").length === 2);
    const forged = events.filter((e) => e.type === "say_sent")[1]!;
    expect(forged).toMatchObject({ depth: 0 });
    expect("cause" in forged).toBe(false);
  });
});

describe("supervised residents", () => {
  async function enrolResident(name = "Fern") {
    const owner = person("Owner");
    const router = new RoutingService(db, db.durableEntityKey(owner.entity.id));
    const run = router.join({ clientKey: `run:${name}`, kind: "codex", label: "worker" });
    const res = await post(owner.token, "/api/routing/residents", { sessionId: run.id, name });
    return { owner, router, run, body: res.body };
  }

  it("enrolment carries the stored attention policy", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const { body } = await enrolResident();
    expect(body.attention).toEqual({ mode: "balanced", threshold: 50, relay: "all" });
  });

  it("records wake decisions and presence, content-free, only from the run that holds it", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const { owner, run } = await enrolResident();
    const report = {
      sessionId: run.id,
      wakes: [
        {
          ref: "tell:7",
          source: "tell",
          decision: "now",
          reason: "request",
          hop: 1,
          steered: true,
          at: 1,
        },
        {
          source: "say",
          decision: "drop",
          reason: "below-threshold",
          hop: 0,
          steered: false,
          at: 2,
        },
      ],
      status: { status: "running", steer: "mid-turn" },
    };
    const res = await post(owner.token, "/api/routing/residents/Fern/attention", report);
    expect(res).toEqual({ status: 200, body: { name: "Fern", recorded: 2 } });
    expect(
      db.listAttentionWakes("Fern").map((w) => [w.perception_ref, w.decision, w.steered]),
    ).toEqual([
      [null, "drop", 0],
      ["tell:7", "now", 1],
    ]);
    // Drops are audited, not broadcast.
    expect(events.filter((e) => e.type === "attention_wake")).toEqual([
      {
        type: "attention_wake",
        name: "Fern",
        source: "tell",
        decision: "now",
        steered: true,
        timestamp: 1,
      },
    ]);
    expect(events.find((e) => e.type === "agent_status")).toMatchObject({
      name: "Fern",
      status: "running",
      steer: "mid-turn",
    });
    // Free text never fits a reason or source.
    const prose = await post(owner.token, "/api/routing/residents/Fern/attention", {
      sessionId: run.id,
      wakes: [
        {
          source: "tell",
          decision: "now",
          reason: "Wren said: ship it",
          hop: 0,
          steered: false,
          at: 3,
        },
      ],
    });
    expect(prose.status).toBe(400);
    // Another person cannot report for it.
    const rival = person("Rival");
    const rivalRun = new RoutingService(db, db.durableEntityKey(rival.entity.id)).join({
      clientKey: "run:r",
      kind: "pi",
      label: "r",
    });
    const refused = await post(rival.token, "/api/routing/residents/Fern/attention", {
      sessionId: rivalRun.id,
      wakes: [],
    });
    expect(refused.status).toBe(404);
  });

  it("`agent attention-mode … relay:explicit` is stored and sent to the run's supervisor", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const { owner, router, run } = await enrolResident();
    await engine.processCommand(
      owner.entity.id,
      "agent attention-mode Fern focused relay:explicit",
    );
    expect(stripAnsi(owner.conn.lastText())).toContain("relay explicit");
    expect(db.getAgentConfig("Fern")).toMatchObject({
      attention_mode: "focused",
      attention_relay: "explicit",
    });
    expect(router.inbox(run.id).map((m) => m.payload)).toEqual([
      { action: "attention", mode: "focused", threshold: 50, relay: "explicit" },
    ]);
    const rival = person("Rival");
    await engine.processCommand(rival.entity.id, "agent attention-mode Fern open");
    expect(stripAnsi(rival.conn.lastText())).toContain("owner");
    expect(db.getAgentConfig("Fern")!.attention_mode).toBe("focused");
  });

  it("a route note to a resident's run becomes a tell from the caller", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const { owner, router, run } = await enrolResident();
    const fern = new MockConnection("r-Fern");
    engine.addConnection(fern);
    const token = (
      await post(owner.token, `/api/routing/residents/Fern/renew`, { sessionId: run.id })
    ).body.credential as { token: string };
    const login = engine.login(fern.id, "Fern", token.token);
    if ("error" in login) throw new Error(login.error);
    const console = router.join({ clientKey: "console", kind: "console", label: "me" });
    const res = await post(owner.token, `/api/routing/sessions/${console.id}/messages`, {
      clientMessageId: "n1",
      targetId: run.id,
      kind: "note",
      payload: { text: "please rebase\nonto main" },
    });
    expect(res).toEqual({ status: 200, body: { deliveredAs: "tell", target: "Fern" } });
    await until(() => fern.messages.some((p) => p.tag === "tell"));
    const tell = fern.messages.find((p) => p.tag === "tell")!;
    expect(tell.data).toMatchObject({ senderName: "Owner", message: "please rebase onto main" });
    expect(router.inbox(run.id)).toHaveLength(0);
  });

  it("the owner's `agent attention` reaches the resident as a priority perception", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const { owner, run } = await enrolResident();
    const fern = new MockConnection("r-Fern");
    engine.addConnection(fern);
    const renewed = await post(owner.token, "/api/routing/residents/Fern/renew", {
      sessionId: run.id,
    });
    const login = engine.login(
      fern.id,
      "Fern",
      (renewed.body.credential as { token: string }).token,
    );
    if ("error" in login) throw new Error(login.error);
    await engine.processCommand(owner.entity.id, "agent attention Fern rebase before you push");
    expect(stripAnsi(owner.conn.lastText())).toContain("Attention sent to Fern");
    const perception = fern.messages.find((p) => p.tag === "attention")!;
    expect(perception.kind).toBe("message");
    expect(perception.data).toMatchObject({
      attention: true,
      senderName: "Owner",
      message: "rebase before you push",
    });
    const rival = person("Rival");
    await engine.processCommand(rival.entity.id, "agent attention Fern do my task");
    expect(stripAnsi(rival.conn.lastText())).toContain("use tell instead");
    expect(fern.messages.filter((p) => p.tag === "attention")).toHaveLength(1);
  });

  it("the switch off runs native sessions exactly as before: no bridge, no reply hook", async () => {
    using _state = scopeProcessState({ env: OFF, rateLimitBypass: true });
    const owner = person("Owner");
    let native: AgentOptions | undefined;
    const prompts: string[] = [];
    const adapter: AgentAdapter & { executable: string } = {
      id: "codex",
      label: "Fixture",
      executable: "fixture",
      start: async (options) => {
        native = options;
        return {
          prompt: async (text) => {
            prompts.push(text);
          },
          interrupt: async () => undefined,
          stop: () => undefined,
        };
      },
    };
    const supervisor = new MarinaSupervisor({
      client: routingClient(owner.token),
      root: directory,
      stateDirectory: directory,
      binding: "off",
      label: "off",
      adapters: [adapter],
      instructions: "INSTRUCTIONS",
    });
    const router = new RoutingService(db, db.durableEntityKey(owner.entity.id));
    try {
      const sup = await supervisor.start();
      router.control(sup.id, {
        targetId: sup.id,
        clientMessageId: crypto.randomUUID(),
        control: {
          action: "launch",
          adapter: "codex",
          label: "w",
          workspace: "shared",
          prompt: "hi",
        },
      });
      await until(async () => {
        await supervisor.tick();
        return prompts.length === 1;
      });
      expect(prompts).toEqual(["INSTRUCTIONS\n\nhi"]);
      expect(native && "reply" in native).toBe(false);
    } finally {
      await supervisor.stop();
      supervisor.close();
    }
  });

  it("the switch off leaves the attention endpoint an unknown routing endpoint", async () => {
    using _state = scopeProcessState({ env: OFF, rateLimitBypass: true });
    const owner = person("Owner");
    const unknown = await post(owner.token, "/api/routing/nonexistent", {});
    expect(
      await post(owner.token, "/api/routing/residents/Fern/attention", { sessionId: "x" }),
    ).toEqual(unknown);
  });

  it("wakes the native session for a peer's tell and relays its final reply as `re`", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const owner = person("Owner");
    const peer = person("Wren", false);
    const prompts: string[] = [];
    let native: AgentOptions | undefined;
    const connector: ResidentConnector = async ({ name, token }) => {
      const handlers: ((p: Perception) => void)[] = [];
      const conn = new MockConnection(`r-${name}`);
      conn.send = (p) => {
        conn.messages.push(p);
        // The real connection drops a command's own (correlated) output.
        if (p.data?.delivery === undefined) for (const handler of handlers) handler(p as never);
      };
      engine.addConnection(conn);
      const login = engine.login(conn.id, name, token);
      if ("error" in login) throw new Error(login.error);
      const id = login.entityId as EntityId;
      return {
        setCredential: () => undefined,
        onPerception: (handler) => handlers.push(handler as never),
        command: async (input, options) => {
          const before = conn.messages.length;
          const cause = options?.cause ? ownedMessageCause(id, options.cause) : undefined;
          await engine.processCommand(id, input, cause ? { cause } : undefined);
          return { ok: true, output: relayText(conn.messages.slice(before) as never) };
        },
        close: () => engine.removeConnection(conn.id, "explicit"),
      };
    };
    const adapter: AgentAdapter & { executable: string } = {
      id: "codex",
      label: "Fixture",
      executable: "fixture",
      start: async (options) => {
        native = options;
        options.state({ status: "idle" });
        return {
          capabilities: { steer: "mid-turn" },
          prompt: async (text) => {
            prompts.push(text);
          },
          interrupt: async () => undefined,
          stop: () => undefined,
        };
      },
    };
    const supervisor = new MarinaSupervisor({
      client: routingClient(owner.token),
      root: directory,
      stateDirectory: directory,
      binding: "on",
      label: "on",
      adapters: [adapter],
      agentEnvironment: { HOME: "/home/test" },
      secrets: [owner.token],
      residents: { connect: connector },
      onEvent: (_s, e) => local.push([e.kind, e.payload]),
    });
    const local: unknown[] = [];
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
        adapter: "codex",
        label: "worker",
        workspace: "shared",
        name: "Fern",
      });
      await until(async () => {
        await supervisor.tick();
        return !!engine.entities.findAgentByName("Fern") && !!native;
      });

      await engine.processCommand(peer.entity.id, "tell Fern which file holds the tokenizer?");
      await until(() => prompts.length === 1);
      expect(prompts[0]).toContain("Wren tells you: which file holds the tokenizer?");
      expect(prompts[0]).toMatch(/^\[!\] \[message\] .*Wren tells you/m);
      expect(prompts[0]).toContain("Your Marina world name is Fern.");
      const asked = db.listDirectMessageInbox(engine.entities.findAgentByName("Fern")!.id)[0]!;

      // The turn ends: its final reply goes back to Wren as a reply to that tell.
      native!.reply!("src/parse.ts");
      native!.state({ status: "idle" });
      await until(() => db.listDirectMessageInbox(peer.entity.id).length === 1);
      const reply = db.listDirectMessageInbox(peer.entity.id)[0]!;
      expect(reply).toMatchObject({
        sender_name: "Fern",
        content: "src/parse.ts",
        cause: `tell:${asked.id}`,
      });
      expect(db.getDirectMessage(asked.id)!.status).toBe("acknowledged");

      // A thank-you owes nothing and wakes no one; the next digest carries it.
      await engine.processCommand(peer.entity.id, "tell Fern thanks, no reply needed");
      await supervisor.tick();
      expect(prompts).toHaveLength(1);

      // Decisions reach the audit table, content-free.
      await until(async () => {
        await supervisor.tick();
        return db.listAttentionWakes("Fern").length >= 2;
      });
      const audit = JSON.stringify(db.listAttentionWakes("Fern"));
      expect(audit).not.toContain("tokenizer");
      expect(audit).not.toContain("thanks");
      expect(events.some((e) => e.type === "agent_status" && e.name === "Fern")).toBe(true);
    } finally {
      await supervisor.stop();
      supervisor.close();
    }
  });
});
