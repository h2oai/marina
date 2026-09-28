// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { MarinaAgent, MarinaClient } from "../src/sdk/client";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom, until } from "./helpers";

const TEST_PORT = 13399;
const TEST_URL = `ws://localhost:${TEST_PORT}`;

describe("MarinaClient SDK", () => {
  let db: MarinaDB;
  let engine: Engine;
  let wsServer: WebSocketServer;
  const dbPath = `/tmp/marina-sdk-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Starting Room",
        long: "A room for SDK testing.",
        exits: { north: roomId("test/north") },
        items: { console: "A glowing console." },
      }),
    );
    engine.registerRoom(
      roomId("test/north"),
      makeTestRoom({
        short: "North Room",
        long: "North of start.",
        exits: { south: roomId("test/start") },
      }),
    );
    wsServer = new WebSocketServer(engine, TEST_PORT);
    wsServer.start();
    engine.start();
  });

  afterEach(async () => {
    await wsServer.stop();
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  it("refreshes live capabilities and inspects context without polluting world perceptions", async () => {
    const client = new MarinaClient(TEST_URL, { autoReconnect: false });
    await client.connect("ManifestSDK");
    const observed: unknown[] = [];
    client.onPerception((p) => {
      if (p.data?.capabilities || p.data?.context_preview) observed.push(p);
    });
    const before = await client.capabilities();
    expect(before.commands.some((command) => command.name === "context")).toBe(true);
    expect(await client.capabilities()).toBe(before);
    engine.commands.registerOwned("sdk-test", {
      name: "fresh-command",
      help: "New command",
      category: "Extensions",
      handler: () => {},
    });
    expect(
      (await client.capabilities()).commands.some((command) => command.name === "fresh-command"),
    ).toBe(true);
    engine.commands.removeOwner("sdk-test");
    expect(
      (await client.capabilities()).commands.some((command) => command.name === "fresh-command"),
    ).toBe(false);
    db.createNote("ManifestSDK", "quartz SDK evidence", roomId("test/start"));
    const preview = await client.contextPreview("quartz");
    expect(preview.context.entity).toBe("ManifestSDK");
    expect(JSON.stringify(preview.context)).toContain("quartz SDK evidence");
    expect(observed).toEqual([]);
    client.disconnect();
  });

  it("should connect and login", async () => {
    const client = new MarinaClient(TEST_URL, { autoReconnect: false });
    const session = await client.connect("SDKUser");
    expect(session.entityId).toBeTruthy();
    expect(session.name).toBe("SDKUser");
    expect(session.token).toBeTruthy();
    client.disconnect();
  });

  it("acknowledges an explicit quit before closing the session", async () => {
    const client = new MarinaAgent(TEST_URL, { autoReconnect: false });
    const session = await client.connect("QuitSDK");
    await client.quit();
    expect(engine.entities.get(session.entityId)).toBeUndefined();
    expect(client.isConnected()).toBe(false);
  });

  it("should send commands and receive perceptions", async () => {
    const client = new MarinaClient(TEST_URL, { autoReconnect: false });
    await client.connect("CmdUser");

    const perceptions = await client.command("look");
    expect(perceptions.length).toBeGreaterThan(0);

    // At least one perception should contain room info
    const hasRoom = perceptions.some(
      (p) => p.kind === "room" || (p.data?.text as string)?.includes("Starting Room"),
    );
    expect(hasRoom).toBe(true);

    client.disconnect();
  });

  it("correlates concurrent commands, excludes ambient traffic, and awaits async completion", async () => {
    const client = new MarinaClient(TEST_URL, { autoReconnect: false, commandDrainTimeout: 1 });
    const peer = new MarinaClient(TEST_URL, { autoReconnect: false });
    const session = await client.connect("CorrelatedSDK");
    await peer.connect("IndependentSDK");
    const release = Promise.withResolvers<void>();
    const started: string[] = [];
    engine.commands.registerBuiltin({
      name: "held-result",
      help: "test",
      async handler(ctx, input) {
        started.push(input.args);
        if (input.args === "first") await release.promise;
        ctx.send(input.entity, `RESULT:${input.args}`);
      },
    });
    let finished = false;
    const first = client.command("held-result first").then((result) => {
      finished = true;
      return result;
    });
    const second = client.command("held-result second");
    try {
      await until(() => started.length === 1);
      engine.sendToEntity(session.entityId, "AMBIENT");
      await Bun.sleep(10);
      expect(finished).toBe(false);
      expect(started).toEqual(["first"]);
      expect((await peer.command("held-result independent")).map((p) => p.data.text)).toEqual([
        "RESULT:independent",
      ]);
      expect(finished).toBe(false);
      release.resolve();
      const [a, b] = await Promise.all([first, second]);
      expect(a.map((p) => p.data.text)).toEqual(["RESULT:first"]);
      expect(b.map((p) => p.data.text)).toEqual(["RESULT:second"]);
      expect(a[0]!.command_request_id).not.toBe(b[0]!.command_request_id);
    } finally {
      release.resolve();
      await engine.drainCommands();
      await Promise.allSettled([first, second]);
      client.disconnect();
      peer.disconnect();
    }
  });

  it("rejects command failures and awaits every command in an async batch", async () => {
    const client = new MarinaClient(TEST_URL, { autoReconnect: false });
    await client.connect("FailedSDK");
    engine.commands.registerBuiltin({
      name: "explode",
      help: "test",
      async handler() {
        await Promise.resolve();
        throw new Error("intentional failure");
      },
    });
    engine.commands.registerBuiltin({
      name: "echo-async",
      help: "test",
      async handler(ctx, input) {
        await Promise.resolve();
        ctx.send(input.entity, input.args);
      },
    });
    expect(await client.command("explode").catch((error) => error.message)).toContain(
      "intentional failure",
    );
    expect(await client.command("nonexistent-command").catch((error) => error.message)).toContain(
      "Unknown command",
    );
    expect(
      (await client.command("batch echo-async first ; echo-async second")).map((p) => p.data.text),
    ).toEqual(["first", "second"]);
    client.disconnect();
  });

  it("returns delivery receipts only for successful sends", async () => {
    const client = new MarinaClient(TEST_URL, { autoReconnect: false });
    const peer = new MarinaClient(TEST_URL, { autoReconnect: false });
    await client.connect("ReceiptSDK");
    await peer.connect("ReceiptPeer");
    const sent = await client.command("tell ReceiptPeer answer [re:abcdef]");
    expect(sent.find((p) => p.data.delivery)?.data.delivery).toEqual({
      kind: "tell",
      target: "ReceiptPeer",
      message: "answer [re:abcdef]",
    });
    expect((await client.command("tell MissingPeer answer")).some((p) => p.data.delivery)).toBe(
      false,
    );
    peer.disconnect();
    client.disconnect();
  });

  it("should receive perceptions via handler", async () => {
    const client = new MarinaClient(TEST_URL, { autoReconnect: false });
    await client.connect("HandlerUser");

    const received: string[] = [];
    client.onPerception((p) => {
      if (p.data?.text) received.push(p.data.text as string);
    });

    await client.command("say hello from SDK");
    await Bun.sleep(100);

    expect(received.some((t) => t.includes("hello from SDK"))).toBe(true);
    client.disconnect();
  });

  it("should reject invalid login", async () => {
    const client = new MarinaClient(TEST_URL, { autoReconnect: false });
    try {
      await client.connect("a"); // too short
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect((err as Error).message).toBeTruthy();
    }
    client.disconnect();
  });

  it("reconnect captures the server-rotated session token", async () => {
    // The engine rotates the session token on every reconnect (revokes the
    // old, issues a new one). If reconnect() reused the stale token instead of
    // capturing the rotated one, a SECOND reconnect would present a revoked
    // token and fail — which is how long-lived agents silently fell off the
    // connection registry and showed as "not connected".
    const client = new MarinaClient(TEST_URL, { autoReconnect: false });
    const first = await client.connect("RotateUser");
    const t1 = first.token;

    // Simulate an involuntary WS drop (network blip) — NOT disconnect(), which
    // nulls the session/token. The client keeps its session across an
    // involuntary close so it can reconnect; the engine unbinds the entity on
    // a transient close but keeps it in memory for the reconnect grace window.
    const dropSocket = () => (client as unknown as { ws: WebSocket | null }).ws?.close();
    dropSocket();
    await Bun.sleep(100); // let the server process the close and unbind

    const second = await client.reconnect(t1);
    // Token was rotated by the engine, not the stale closure value.
    expect(second.token).toBeTruthy();
    expect(second.token).not.toBe(t1);
    expect(second.entityId).toBe(first.entityId);

    // Drop again; the captured (rotated) token must itself be valid for a
    // further reconnect — proving we kept the server's token, not the old one.
    dropSocket();
    await Bun.sleep(100);

    const third = await client.reconnect(second.token);
    expect(third.entityId).toBe(first.entityId);

    client.disconnect();
  });
});

describe("MarinaAgent SDK", () => {
  let db: MarinaDB;
  let engine: Engine;
  let wsServer: WebSocketServer;
  const dbPath = `/tmp/marina-agent-sdk-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Starting Room",
        long: "A room for agent testing.",
        exits: { north: roomId("test/north") },
      }),
    );
    engine.registerRoom(
      roomId("test/north"),
      makeTestRoom({
        short: "North Room",
        long: "North of start.",
        exits: { south: roomId("test/start") },
      }),
    );
    wsServer = new WebSocketServer(engine, TEST_PORT);
    wsServer.start();
    engine.start();
  });

  afterEach(async () => {
    await wsServer.stop();
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  it("should look and get room view", async () => {
    const agent = new MarinaAgent(TEST_URL, { autoReconnect: false });
    await agent.connect("LookAgent");

    const view = await agent.look();
    if ("short" in view) {
      expect(view.short).toBe("Starting Room");
      expect(view.exits).toContain("north");
    }
    agent.disconnect();
  });

  it("should move between rooms", async () => {
    const agent = new MarinaAgent(TEST_URL, { autoReconnect: false });
    await agent.connect("MoveAgent");

    await agent.move("north");
    // After moving, look should show the north room
    const view = await agent.look();
    if ("short" in view) {
      expect(view.short).toBe("North Room");
    }
    agent.disconnect();
  });

  it("should say and get confirmation", async () => {
    const agent = new MarinaAgent(TEST_URL, { autoReconnect: false });
    await agent.connect("SayAgent");

    const received: string[] = [];
    agent.onPerception((p) => {
      if (p.data?.text) received.push(p.data.text as string);
    });

    await agent.say("hello world");
    await Bun.sleep(100);
    expect(received.some((t) => t.includes("hello world"))).toBe(true);
    agent.disconnect();
  });

  // tellAndAwait — crew-fast-dispatch primitive ────────────────────────────────

  it("tellAndAwait resolves with the first reply from the addressee", async () => {
    // Alice fires a tell to Bob and synchronously waits. Bob (acting as a
    // thin specialist) auto-replies on perception. This is the basic happy
    // path: round trip completes inside one tool call, no continuation
    // prompt cycle in the middle.
    const alice = new MarinaClient(TEST_URL, { autoReconnect: false });
    const bob = new MarinaClient(TEST_URL, { autoReconnect: false });
    await alice.connect("Alice");
    await bob.connect("Bob");

    bob.onPerception((p) => {
      if (
        p.kind === "message" &&
        p.tag === "tell" &&
        (p.data as Record<string, unknown> | undefined)?.senderName === "Alice"
      ) {
        // Fire-and-forget reply — don't await, keep Bob responsive.
        bob.command("tell Alice pong").catch(() => {});
      }
    });

    const reply = await alice.tellAndAwait("Bob", "ping", 5000);
    expect(reply).toBe("pong");

    alice.disconnect();
    bob.disconnect();
  });

  it("tellAndAwait rejects with a timeout error when no one replies", async () => {
    // No responder online — Carol just listens. Alice's await must reject
    // with a clear message including the addressee name and the timeout
    // window so the agent can choose a recovery path on tool error.
    const alice = new MarinaClient(TEST_URL, { autoReconnect: false });
    const carol = new MarinaClient(TEST_URL, { autoReconnect: false });
    await alice.connect("Alice2");
    await carol.connect("Carol");

    let caught: Error | null = null;
    try {
      await alice.tellAndAwait("Carol", "are you there?", 1500);
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain("Carol");
    expect(caught?.message).toContain("1500");

    alice.disconnect();
    carol.disconnect();
  });

  it("tellAndAwait ignores tells from other entities and only matches the addressee", async () => {
    // Crew-context noise check: while Alice waits on Bob, Eve sends Alice
    // an unrelated tell. Alice's await must NOT resolve on Eve's message —
    // it must hold for Bob's reply specifically. Otherwise crew chatter
    // would corrupt the dispatch contract.
    const alice = new MarinaClient(TEST_URL, { autoReconnect: false });
    const bob = new MarinaClient(TEST_URL, { autoReconnect: false });
    const eve = new MarinaClient(TEST_URL, { autoReconnect: false });
    await alice.connect("Alicex");
    await bob.connect("Bobx");
    await eve.connect("Evex");

    // Bob delays his reply so Eve's noise lands first.
    bob.onPerception((p) => {
      if (
        p.kind === "message" &&
        p.tag === "tell" &&
        (p.data as Record<string, unknown> | undefined)?.senderName === "Alicex"
      ) {
        setTimeout(() => bob.command("tell Alicex authoritative answer").catch(() => {}), 200);
      }
    });

    // Eve sends a noise tell ~50ms after Alice fires (before Bob replies).
    setTimeout(() => eve.command("tell Alicex random gossip").catch(() => {}), 50);

    const reply = await alice.tellAndAwait("Bobx", "what is the answer?", 5000);
    expect(reply).toBe("authoritative answer");

    alice.disconnect();
    bob.disconnect();
    eve.disconnect();
  });
});
