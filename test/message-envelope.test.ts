// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  getCurrentMessageCause,
  runCommandScope,
  setCurrentMessageCause,
} from "../src/engine/gate-context";
import { envelopeFor, normalizeCause } from "../src/engine/message-envelope";
import { DashboardBroadcaster, type DashboardWSData } from "../src/net/dashboard-ws";
import { FeedPublisher } from "../src/net/feed-publisher";
import { memoryObserver } from "../src/net/memory/memory-visibility";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/persistence/schema";
import type { EngineEvent, EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import type { MockConnection } from "./helpers";

type SaySent = EngineEvent & { type: "say_sent" };
type TellSent = EngineEvent & { type: "tell_sent" };

let world: ReturnType<typeof createTestEngine>;
let events: EngineEvent[];
let alice: { connection: MockConnection; entityId: EntityId };
let bob: { connection: MockConnection; entityId: EntityId };
let carol: { connection: MockConnection; entityId: EntityId };

beforeEach(() => {
  world = createTestEngine();
  events = [];
  world.engine.addEventListener((event) => events.push(event));
  alice = world.login("Alice");
  bob = world.login("Bob");
  carol = world.login("Carol");
  for (const who of [alice, bob, carol]) who.connection.clear();
  events.length = 0;
});

afterEach(async () => {
  await world.dispose();
});

const ofType = <T extends EngineEvent["type"]>(type: T) =>
  events.filter((e) => e.type === type) as (EngineEvent & { type: T })[];

/** The perception carrying `text` that `who` received. */
function perceived(who: { connection: MockConnection }, text: string): Perception {
  const hit = who.connection.messages.find((m) => String(m.data?.text ?? "").includes(text));
  if (!hit) throw new Error(`no perception containing ${text}`);
  return hit;
}

describe("typed message events", () => {
  it("emits exactly one content-free say_sent per say", async () => {
    await world.engine.processCommand(alice.entityId, "say SAY_SECRET_WORDS");
    const said = ofType("say_sent");
    expect(said).toHaveLength(1);
    const event = said[0] as SaySent;
    expect(event.from).toBe("Alice");
    expect(event.entity).toBe(alice.entityId);
    expect(event.messageRef).toMatch(/^say:[0-9a-f-]{36}$/);
    expect(event.depth).toBe(0);
    expect(event.cause).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("SAY_SECRET_WORDS");
    // Everyone present perceives the same ref and envelope.
    const heard = perceived(bob, "SAY_SECRET_WORDS");
    expect(heard.data?.messageRef).toBe(event.messageRef);
    expect(heard.data?.depth).toBe(0);
  });

  it("emits exactly one content-free tell_sent per tell and per re", async () => {
    await world.engine.processCommand(alice.entityId, "tell Bob TELL_SECRET_WORDS");
    await world.engine.processCommand(bob.entityId, "re REPLY_SECRET_WORDS");
    const told = ofType("tell_sent");
    expect(told).toHaveLength(2);
    expect(told.map((e) => [e.from, e.to])).toEqual([
      ["Alice", "Bob"],
      ["Bob", "Alice"],
    ]);
    const body = JSON.stringify(told);
    expect(body).not.toContain("TELL_SECRET_WORDS");
    expect(body).not.toContain("REPLY_SECRET_WORDS");
  });

  it("emits nothing for a suppressed duplicate tell", async () => {
    await world.engine.processCommand(alice.entityId, "tell Bob same words");
    await world.engine.processCommand(alice.entityId, "tell Bob same words");
    expect(ofType("tell_sent")).toHaveLength(1);
  });
});

describe("causal threading", () => {
  it("carries cause and depth across tell → re → re → say", async () => {
    await world.engine.processCommand(alice.entityId, "tell Bob first");
    const first = ofType("tell_sent")[0] as TellSent;
    expect(first.depth).toBe(0);
    expect(first.cause).toBeUndefined();
    const firstSeen = perceived(bob, "first");
    expect(firstSeen.data?.messageRef).toBe(first.messageRef);
    expect(firstSeen.data?.depth).toBe(0);

    await world.engine.processCommand(bob.entityId, "re second");
    const second = ofType("tell_sent")[1] as TellSent;
    expect(second.cause).toBe(first.messageRef);
    expect(second.depth).toBe(1);
    const secondSeen = perceived(alice, "second");
    expect(secondSeen.data?.cause).toBe(first.messageRef);
    expect(secondSeen.data?.depth).toBe(1);

    await world.engine.processCommand(alice.entityId, "re third");
    const third = ofType("tell_sent")[2] as TellSent;
    expect(third.cause).toBe(second.messageRef);
    expect(third.depth).toBe(2);

    // Stored rows keep the envelope.
    const id = (ref: string) => Number(ref.split(":")[1]);
    expect(world.db.getDirectMessage(id(first.messageRef))).toMatchObject({
      cause: null,
      depth: 0,
    });
    expect(world.db.getDirectMessage(id(third.messageRef))).toMatchObject({
      cause: second.messageRef,
      depth: 2,
    });

    // An ingress that knows what woke the input passes the perceived envelope.
    const thirdSeen = perceived(bob, "third");
    await world.engine.processCommand(bob.entityId, "say fourth", {
      cause: {
        ref: String(thirdSeen.data?.messageRef),
        depth: Number(thirdSeen.data?.depth),
      },
    });
    const fourth = ofType("say_sent")[0] as SaySent;
    expect(fourth.cause).toBe(third.messageRef);
    expect(fourth.depth).toBe(3);
    expect(perceived(carol, "fourth").data?.depth).toBe(3);
  });

  it("starts a fresh thread (depth 0) without a known cause", async () => {
    await world.engine.processCommand(alice.entityId, "tell Bob hi");
    await world.engine.processCommand(bob.entityId, "tell Alice unrelated");
    const fresh = ofType("tell_sent")[1] as TellSent;
    expect(fresh.cause).toBeUndefined();
    expect(fresh.depth).toBe(0);
  });

  it("records the envelope on channel posts with the stored id", async () => {
    const { db } = world;
    db.createChannel({ id: "ch:ops", type: "public", name: "ops", persistence: "permanent" });
    db.addChannelMember("ch:ops", alice.entityId);
    db.addChannelMember("ch:ops", bob.entityId);
    await world.engine.processCommand(alice.entityId, "channel send ops one");
    await world.engine.processCommand(alice.entityId, "channel send ops two", {
      cause: { ref: "tell:7", depth: 4 },
    });
    const posts = ofType("channel_message");
    expect(posts).toHaveLength(2);
    const stored = db.getChannelHistory("ch:ops", 10).reverse();
    expect(posts.map((p) => p.messageId)).toEqual(stored.map((row) => row.id));
    expect(posts[0]!.messageId).not.toBe(posts[1]!.messageId);
    expect(stored.map((row) => [row.cause, row.depth])).toEqual([
      [null, 0],
      ["tell:7", 5],
    ]);
    const seen = perceived(bob, "two");
    expect(seen.data?.messageRef).toBe(`channel_msg:${posts[1]!.messageId}`);
    expect(seen.data?.cause).toBe("tell:7");
    expect(seen.data?.depth).toBe(5);

    // Distinct feed refs, one per stored message.
    const publisher = new FeedPublisher({ db, resolveEntity: () => "Alice" });
    for (const post of posts) publisher.handleEvent(post);
    const refs = db
      .queryFeedEvents()
      .filter((row) => row.kind === "channel_message")
      .map((row) => row.ref);
    expect(new Set(refs).size).toBe(2);
    expect(refs.sort()).toEqual(posts.map((p) => `channel_msg:${p.messageId}`).sort());
  });

  it("threads a channel answer under its question on the feed canvas", async () => {
    const { db } = world;
    db.createChannel({ id: "ch:ops", type: "public", name: "ops", persistence: "permanent" });
    db.addChannelMember("ch:ops", alice.entityId);
    db.addChannelMember("ch:ops", bob.entityId);
    const names = new Map([
      [alice.entityId, "Alice"],
      [bob.entityId, "Bob"],
    ]);
    const publisher = new FeedPublisher({ db, resolveEntity: (id) => names.get(id) });
    await world.engine.processCommand(alice.entityId, "channel send ops what is 6x7?");
    const [question] = ofType("channel_message");
    publisher.handleEvent(question!);
    await world.engine.processCommand(bob.entityId, "channel send ops 42", {
      cause: { ref: `channel_msg:${question!.messageId}`, depth: 0 },
    });
    // An answer to a message that is not on the feed (a tell) is not threaded.
    await world.engine.processCommand(bob.entityId, "channel send ops later", {
      cause: { ref: "tell:99", depth: 2 },
    });
    const [, answer, unrelated] = ofType("channel_message");
    publisher.handleEvent(answer!);
    publisher.handleEvent(unrelated!);

    const canvas = db.getCanvasByName("feed")!;
    const nodes = db.getNodesByCanvas(canvas.id);
    const byRef = (ref: string) =>
      nodes.find((n) => (JSON.parse(n.data) as { ref?: string }).ref === ref)!;
    const q = byRef(`channel_msg:${question!.messageId}`);
    const a = byRef(`channel_msg:${answer!.messageId}`);
    const u = byRef(`channel_msg:${unrelated!.messageId}`);
    expect(a.parent_node_id).toBe(q.id);
    expect(JSON.parse(a.data)).toMatchObject({ inReplyTo: "Alice", depth: 1, author: "Bob" });
    expect(u.parent_node_id).toBeNull();
    expect(JSON.parse(u.data)).toMatchObject({ depth: 3 });
    expect(JSON.parse(u.data).inReplyTo).toBeUndefined();

    // A fresh publisher (a restart) still finds the question on the canvas.
    const restarted = new FeedPublisher({ db, resolveEntity: (id) => names.get(id) });
    await world.engine.processCommand(alice.entityId, "channel send ops thanks", {
      cause: { ref: `channel_msg:${answer!.messageId}`, depth: 1 },
    });
    const thanks = ofType("channel_message").at(-1)!;
    restarted.handleEvent(thanks);
    const t = db
      .getNodesByCanvas(canvas.id)
      .find(
        (n) => (JSON.parse(n.data) as { ref?: string }).ref === `channel_msg:${thanks.messageId}`,
      )!;
    expect(t.parent_node_id).toBe(a.id);
    expect(JSON.parse(t.data)).toMatchObject({ inReplyTo: "Bob", depth: 2 });
  });

  it("names the entity on enter and leave events", async () => {
    const dave = world.login("Dave");
    const enter = ofType("entity_enter").find((e) => e.entity === dave.entityId);
    expect(enter?.name).toBe("Dave");
    world.engine.removeConnection(dave.connection.id, "explicit");
    const leave = ofType("entity_leave").find((e) => e.entity === dave.entityId);
    expect(leave?.name).toBe("Dave");
  });

  it("a nested frame inherits the enclosing execution's cause; outside none", async () => {
    const id = "e_scope";
    expect(getCurrentMessageCause(id)).toBeUndefined();
    await runCommandScope(id, async () => {
      setCurrentMessageCause(id, { ref: "tell:3", depth: 2 });
      await runCommandScope(id, async () => {
        expect(getCurrentMessageCause(id)).toEqual({ ref: "tell:3", depth: 2 });
      });
      // Another entity's frame never sees it.
      await runCommandScope("e_other", async () => {
        expect(getCurrentMessageCause("e_other")).toBeUndefined();
      });
    });
    expect(getCurrentMessageCause(id)).toBeUndefined();
  });

  it("refuses malformed causes", () => {
    expect(normalizeCause({ ref: "note:1", depth: 1 })).toBeUndefined();
    expect(normalizeCause({ ref: "tell:1 2", depth: 1 })).toBeUndefined();
    expect(envelopeFor({ ref: "tell:9", depth: Number.NaN })).toEqual({
      cause: "tell:9",
      depth: 1,
    });
    expect(envelopeFor(undefined)).toEqual({ depth: 0 });
  });
});

describe("dashboard broadcast", () => {
  it("passes say_sent to every viewer and tell_sent only to its parties, never content", async () => {
    const broadcaster = new DashboardBroadcaster();
    const sinks = new Map<string, string[]>();
    for (const who of [alice, bob, carol]) {
      const sink: string[] = [];
      sinks.set(who.entityId, sink);
      broadcaster.addClient(
        {
          data: { connId: who.entityId, isDashboard: true, principal: who.entityId },
          send: (message: string) => sink.push(message),
        } as unknown as ServerWebSocket<DashboardWSData>,
        world.engine,
      );
    }
    for (const sink of sinks.values()) sink.length = 0;
    world.engine.addEventListener((event) => broadcaster.broadcastEvent(event));
    await world.engine.processCommand(alice.entityId, "say ROOM_WORDS");
    await world.engine.processCommand(alice.entityId, "tell Bob PRIVATE_WORDS");

    const received = (who: { entityId: EntityId }) =>
      sinks
        .get(who.entityId)!
        .map((m) => JSON.parse(m) as { type: string; data?: { type?: string } })
        .filter((m) => m.type === "event")
        .map((m) => m.data?.type);
    expect(received(carol)).toContain("say_sent");
    expect(received(carol)).not.toContain("tell_sent");
    expect(received(bob)).toContain("tell_sent");
    expect(received(alice)).toContain("tell_sent");
    for (const sink of sinks.values()) {
      const all = sink.join("");
      expect(all).not.toContain("ROOM_WORDS");
      expect(all).not.toContain("PRIVATE_WORDS");
    }
  });
});

describe("tell_sent for owners", () => {
  it("reaches the person who launched either party, and no one else outside it", async () => {
    world.engine.db!.saveAgentConfig({
      name: "Alice",
      model: "frontier",
      spawnedBy: "Carol",
      runtime: "supervised",
      vendor: "claude",
    });
    const dave = world.login("Dave");
    await world.engine.processCommand(alice.entityId, "tell Bob OWNER_SEES_ENVELOPE");
    const tell = ofType("tell_sent")[0]!;
    expect(memoryObserver(world.engine, carol.entityId).event(tell)).toBe(true);
    expect(memoryObserver(world.engine, bob.entityId).event(tell)).toBe(true);
    expect(memoryObserver(world.engine, dave.entityId).event(tell)).toBe(false);
    expect(JSON.stringify(tell)).not.toContain("OWNER_SEES_ENVELOPE");
  });

  it("carries a supervised resident's owner and vendor in the world snapshot", () => {
    world.engine.db!.saveAgentConfig({
      name: "Alice",
      model: "frontier",
      spawnedBy: "Carol",
      runtime: "supervised",
      vendor: "claude",
    });
    const broadcaster = new DashboardBroadcaster();
    const sink: string[] = [];
    broadcaster.addClient(
      {
        data: { connId: carol.entityId, isDashboard: true, principal: carol.entityId },
        send: (message: string) => sink.push(message),
      } as unknown as ServerWebSocket<DashboardWSData>,
      world.engine,
    );
    const snapshot = sink
      .map(
        (m) => JSON.parse(m) as { type: string; data?: { entities?: Record<string, unknown>[] } },
      )
      .find((m) => m.type === "snapshot");
    const entry = snapshot?.data?.entities?.find((e) => e.name === "Alice");
    expect(entry).toMatchObject({ vendor: "claude", spawnedBy: "Carol" });
    // An entity without a runtime or a supervised config carries no origin.
    expect(snapshot?.data?.entities?.find((e) => e.name === "Bob")?.spawnedBy).toBeUndefined();
  });
});

describe("migration", () => {
  it("adds the envelope columns in the next contiguous version", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    versions.forEach((v, i) => {
      if (i > 0) expect(v).toBe(versions[i - 1]! + 1);
    });
    const envelope = MIGRATIONS.find((m) => m.sql.includes("direct_messages ADD COLUMN cause"));
    expect(envelope).toBeDefined();
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(envelope!.version);
    for (const table of ["direct_messages", "channel_messages"]) {
      const columns = (
        (world.db as unknown as { db: Database }).db.query(`PRAGMA table_info(${table})`).all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(columns).toContain("cause");
      expect(columns).toContain("depth");
    }
  });
});
