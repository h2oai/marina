// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { MarinaDB } from "../src/persistence/database";
import { RoutingRunnerJournal } from "../src/persistence/db-routing-runner";
import type { AgentAdapter, AgentOptions } from "../src/routing/agent-adapters";
import { AgentTransport, JsonLines } from "../src/routing/agent-transport";
import { allowedDirectory } from "../src/routing/agent-workspace";
import { RoutingService } from "../src/routing/service";
import { MarinaSupervisor } from "../src/routing/supervisor";
import { MarinaRoutingClient } from "../src/sdk/routing-client";
import type { RuntimeControl } from "../src/sdk/routing-runtime-types";
import type { RoutingSession } from "../src/sdk/routing-types";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom, until } from "./helpers";

let directory: string;
let db: MarinaDB;
let router: RoutingService;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-runtime-"));
  db = new MarinaDB(join(directory, "world.db"));
  db.createUser({ id: "owner", name: "Owner" });
  router = new RoutingService(db, "owner");
  resetHttpRateLimitersForTests();
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("atomically syncs 100 independent participants and rolls back a denied batch", () => {
  const sessions = Array.from({ length: 100 }, (_, i) =>
    router.join({ clientKey: `s${i}`, kind: "arbitrary", label: `s${i}` }),
  );
  const publications = sessions.map((s) => ({
    sessionId: s.id,
    events: [{ id: "first", kind: "output", payload: "hello" }],
  }));
  expect(router.sync({ publications, inboxes: sessions.map((s) => s.id) }).inboxes).toHaveLength(
    100,
  );
  expect(router.sync({ publications }).inboxes).toHaveLength(0);
  expect(router.get(sessions[0]!.id).lastSequence).toBe(1);
  expect(() =>
    router.sync({
      publications: [
        {
          sessionId: sessions[0]!.id,
          events: [{ id: "second", kind: "output", payload: "must roll back" }],
        },
        { sessionId: "missing", events: publications[0]!.events },
      ],
    }),
  ).toThrow();
  expect(router.get(sessions[0]!.id).lastSequence).toBe(1);
});

it("prioritizes stop and approval controls above a full page of busy-agent prompts", () => {
  const s = router.join({ clientKey: "busy", kind: "test", label: "busy" });
  for (let i = 0; i < 20; i++)
    router.send(s.id, {
      clientMessageId: `n${i}`,
      targetId: s.id,
      kind: "note",
      payload: "context",
    });
  const stop = router.control(s.id, {
    targetId: s.id,
    clientMessageId: "stop",
    control: { action: "stop" },
  });
  expect(router.sync({ inboxes: [s.id] }).inboxes[0]!.messages[0]!.id).toBe(stop.id);
  expect(() =>
    router.send(s.id, {
      clientMessageId: "bypass",
      targetId: s.id,
      kind: "marina.control",
      payload: { action: "stop" },
    }),
  ).toThrow("authorized");
});

it("gates HTTP execution controls while keeping generic messaging available", async () => {
  const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  const conn = new MockConnection("runtime-http");
  engine.addConnection(conn);
  const login = engine.login(conn.id, "RuntimeUser");
  if ("error" in login) throw new Error(login.error);
  const client = new MarinaRoutingClient({
    url: "http://localhost:3300",
    token: login.token,
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      return (await handleDashboardApi(req, new URL(req.url), req.method, engine, db))!;
    }) as typeof fetch,
  });
  try {
    const session = await client.join({ clientKey: "control", kind: "test", label: "test" });
    await expect(
      client.control(session.id, session.id, "launch", {
        action: "launch",
        adapter: "test",
        label: "test",
      }),
    ).rejects.toThrow("Not authorized");
    expect(
      (
        await client.send(session.id, {
          clientMessageId: "note",
          targetId: session.id,
          kind: "note",
          payload: "allowed",
        })
      ).status,
    ).toBe("queued");
    const entity = engine.entities.findByName("RuntimeUser", roomId("test/start"))!;
    entity.properties.rank = 9;
    expect(
      (
        await client.control(session.id, session.id, "launch", {
          action: "launch",
          adapter: "test",
          label: "test",
        })
      ).kind,
    ).toBe("marina.control");
  } finally {
    engine.removeConnection(conn.id);
  }
});

it("frames split UTF-8 JSONL without treating Unicode separators as record boundaries", () => {
  const messages: unknown[] = [];
  const lines = new JsonLines((message) => messages.push(message));
  const bytes = Buffer.from('{"text":"🛥️\u2028hello"}\n{"id":2}\n');
  for (const byte of bytes) lines.push(Buffer.from([byte]));
  expect(messages).toEqual([{ text: "🛥️\u2028hello" }, { id: 2 }]);
  expect(() => lines.push(Buffer.from("[]\n"))).toThrow("objects");
});

it("correlates native requests and waits for final output when stopping an owned process", async () => {
  const notifications: unknown[] = [];
  let exited = false;
  const transport = new AgentTransport({
    command: process.execPath,
    cwd: directory,
    args: [
      "-e",
      `
    setInterval(() => {}, 1000);
    process.stdin.resume();
    process.stdin.on("data", chunk => {
      const message = JSON.parse(chunk.toString());
      process.stdout.write(JSON.stringify({id: message.id, result: {ok: true}}) + "\\n");
    });
    process.on("SIGTERM", () => {
      process.stdout.write(JSON.stringify({method: "closing"}) + "\\n", () => process.exit(0));
    });
  `,
    ],
    onMessage: (message) => notifications.push(message),
    onStderr: () => undefined,
    onExit: () => {
      exited = true;
    },
  });
  try {
    expect((await transport.request({ method: "test" })).result).toEqual({ ok: true });
  } finally {
    await transport.stop();
  }
  expect(exited).toBe(true);
  expect(notifications).toContainEqual({ method: "closing" });
  await transport.stop();
});

it("rejects parent traversal and symlinks outside the configured root", async () => {
  symlinkSync(tmpdir(), join(directory, "escape"));
  expect(await allowedDirectory(directory)).toBe(directory);
  await expect(allowedDirectory(directory, "..")).rejects.toThrow("outside");
  await expect(allowedDirectory(directory, "escape")).rejects.toThrow("outside");
});

it("journals unknown acceptance across restart and refuses concurrent owners", () => {
  const path = join(directory, "runner.db");
  const s = router.join({ clientKey: "j", kind: "test", label: "j" });
  const message = router.send(s.id, {
    clientMessageId: "m",
    targetId: s.id,
    kind: "note",
    payload: "do once",
  });
  const first = new RoutingRunnerJournal(path);
  first.identity("fixture");
  first.begin(message, s.id);
  first.enqueue(s.id, { id: "output", kind: "text", payload: "durable" });
  expect(() => new RoutingRunnerJournal(path)).toThrow();
  first.close();
  const next = new RoutingRunnerJournal(path);
  try {
    expect(() => next.identity("other-server")).toThrow("another");
    expect(next.recover()).toEqual([{ sessionId: s.id, messageId: message.id }]);
    expect(next.receipt(message, s.id)).toBe("uncertain");
    expect(next.batch()[0]!.event.payload).toBe("durable");
  } finally {
    next.close();
  }
});

it("coalesces text without changing an event that may already have reached Marina", () => {
  const path = join(directory, "coalescing.db");
  const journal = new RoutingRunnerJournal(path);
  const output = (id: string, text: string) => ({ id, kind: "output", payload: { text } });
  journal.enqueue("session", output("a", "Hello "));
  journal.enqueue("session", output("b", "world"));
  const sent = journal.batch();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.event.payload).toEqual({ text: "Hello world" });
  // Response was lost: new text must get a fresh ID, leaving retry bytes stable.
  journal.enqueue("session", output("c", "!"));
  expect(journal.batch()[0]).toEqual(sent[0]);
  expect(journal.batch()).toHaveLength(2);
  journal.close();
  const recovered = new RoutingRunnerJournal(path);
  try {
    recovered.enqueue("session", output("d", " Another turn"));
    expect(recovered.batch()).toHaveLength(3);
    expect(recovered.batch()[0]).toEqual(sent[0]);
  } finally {
    recovered.close();
  }
});

it("launches an arbitrary adapter, delivers once, resolves approvals, and retries lost sync responses", async () => {
  let native: AgentOptions | undefined;
  const prompts: string[] = [];
  let stops = 0;
  const adapter: AgentAdapter = {
    id: "custom",
    label: "Custom worker",
    executable: "fixture",
    async start(options) {
      native = options;
      options.state({ status: "idle", nativeSessionId: "native-test" });
      return {
        async prompt(text) {
          prompts.push(text);
          options.emit("output", { text: "token-secret visible result" });
        },
        async interrupt() {
          options.state({ status: "idle" });
        },
        stop() {
          stops++;
        },
      };
    },
  };
  let loseResponse = false;
  const client = new MarinaRoutingClient({
    url: "http://local.test",
    token: "test",
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body));
      if (url.pathname.endsWith("/sessions")) return Response.json(router.join(body));
      const response = router.sync(body);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("connection lost after commit");
      }
      return Response.json(response);
    }) as typeof fetch,
  });
  const supervisor = new MarinaSupervisor({
    client,
    root: directory,
    stateDirectory: directory,
    binding: "test",
    label: "test supervisor",
    adapters: [adapter],
    secrets: ["token-secret"],
  });
  const owner = await supervisor.start();
  const control = (target: RoutingSession, value: RuntimeControl) =>
    router.control(owner.id, {
      targetId: target.id,
      clientMessageId: crypto.randomUUID(),
      control: value,
    });
  try {
    control(owner, { action: "launch", adapter: "custom", label: "worker", workspace: "shared" });
    await supervisor.tick();
    await until(() => !!native);
    await until(() => router.list().sessions.length === 2);
    const agent = router.list().sessions.find((s) => s.kind === "custom")!;
    const msg = control(agent, { action: "prompt", text: "first task" });
    await supervisor.tick();
    await until(() => prompts.length === 1);
    loseResponse = true;
    await expect(supervisor.tick()).rejects.toThrow("connection lost");
    await supervisor.tick();
    expect(prompts).toHaveLength(1);
    expect(router.receipt(owner.id, msg.id).status).toBe("acknowledged");
    const outputs = router.events(agent.id).events.filter((e) => e.kind === "output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.payload).toEqual({ text: "[redacted] visible result" });
    const answer = native!.ask({
      kind: "permission",
      title: "Run a tool?",
      input: { tool: "fixture" },
    });
    await supervisor.tick();
    const state = router.runtime(agent.id) as { request: { id: string } };
    control(agent, { action: "respond", requestId: state.request.id, allow: false });
    await supervisor.tick();
    expect(await answer).toEqual({ allow: false });
    control(agent, { action: "stop" });
    await supervisor.tick();
    await until(() => stops > 0);
  } finally {
    await supervisor.stop();
    supervisor.close();
  }
});
