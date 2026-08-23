// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import {
  buildRelayEnvelope,
  extractRoutingTarget,
  GatewayRuntime,
  parseRelayEnvelope,
  type RelayEnvelope,
} from "../src/engine/gateway-runtime";
import { MarinaDB } from "../src/persistence/database";
import type { Perception } from "../src/sdk/client";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

// ─── Perception fixtures ────────────────────────────────────────────────────

function chanPerc(channel: string, sender: string, content: string): Perception {
  return {
    kind: "message",
    timestamp: Date.now(),
    data: { channel, senderName: sender, content },
  };
}

function tellPerc(sender: string, message: string): Perception {
  return {
    kind: "message",
    tag: "tell",
    timestamp: Date.now(),
    // Real tells carry `text` (formatted) plus structured senderName/message.
    data: { text: `> ${sender} tells you: ${message}`, senderName: sender, message },
  };
}

// ─── Pure envelope helpers ──────────────────────────────────────────────────

describe("relay envelope helpers", () => {
  it("round-trips origin / hops / target", () => {
    const wire = buildRelayEnvelope({ origin: "alpha", hops: 2, target: "bob" }, "hello world");
    const { meta, body } = parseRelayEnvelope(wire);
    expect(meta.origin).toBe("alpha");
    expect(meta.hops).toBe(2);
    expect(meta.target).toBe("bob");
    expect(body).toBe("hello world");
  });

  it("falls back to legacy [from count when no structured envelope", () => {
    const { meta, body } = parseRelayEnvelope("[from a/x] [from b/y] hello");
    expect(meta.origin).toBeUndefined();
    expect(meta.hops).toBe(2); // counted from the readable trail
    expect(body).toBe("[from a/x] [from b/y] hello");
  });

  it("prefers the structured hop count over spoofed [from in the body", () => {
    // Body is stuffed with fake "[from " tokens, but the envelope says hops=0.
    const wire = buildRelayEnvelope({ hops: 0 }, "[from x][from y][from z][from w] hi");
    const { meta } = parseRelayEnvelope(wire);
    expect(meta.hops).toBe(0);
  });

  it("recovers a leading @name / to:name routing target", () => {
    expect(extractRoutingTarget("@alice hey there")).toEqual({
      target: "alice",
      body: "hey there",
    });
    expect(extractRoutingTarget("to:bob ping")).toEqual({ target: "bob", body: "ping" });
    expect(extractRoutingTarget("no target here")).toEqual({ body: "no target here" });
  });
});

// ─── Relay decision (GatewayRuntime, mocked delivery) ───────────────────────

describe("GatewayRuntime relay decisions", () => {
  let relayCalls: Array<{ channel: string; body: string; meta: RelayEnvelope }>;
  let tellCalls: Array<{ target: string | undefined; senderLabel: string; message: string }>;
  let rt: GatewayRuntime;

  beforeEach(() => {
    relayCalls = [];
    tellCalls = [];
    rt = new GatewayRuntime({
      localRelay: (channel, body, meta) => relayCalls.push({ channel, body, meta }),
      localTellRelay: (target, senderLabel, message) =>
        tellCalls.push({ target, senderLabel, message }),
      localWorldName: "self",
    });
  });

  const feedChan = (content: string, sender = "bob") =>
    rt.receivePerceptionForTest(
      "peerB",
      "Gateway_self",
      ["general"],
      chanPerc("general", sender, content),
    );
  const feedTell = (message: string, sender = "bob") =>
    rt.receivePerceptionForTest("peerB", "Gateway_self", [], tellPerc(sender, message));

  it("relays a fresh channel message, stamping origin + hops=1", () => {
    feedChan("hello");
    expect(relayCalls).toHaveLength(1);
    // The envelope rides in structured meta; the body handed to local delivery
    // is clean (no `[relay …]` framing).
    expect(relayCalls[0]!.meta.origin).toBe("self");
    expect(relayCalls[0]!.meta.hops).toBe(1);
    expect(relayCalls[0]!.body).toContain("[from peerB/bob] hello");
    expect(relayCalls[0]!.body).not.toContain("[relay ");
  });

  it("strips an inbound body envelope but preserves origin/hops in meta", () => {
    // Older peer that inlines the envelope in the content body.
    feedChan(buildRelayEnvelope({ origin: "peerX", hops: 1 }, "[from peerX/z] mesh hi"));
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]!.body).not.toContain("[relay ");
    expect(relayCalls[0]!.body).toContain("mesh hi");
    expect(relayCalls[0]!.meta.origin).toBe("peerX"); // origin preserved across the hop
    expect(relayCalls[0]!.meta.hops).toBe(2); // incremented
  });

  it("honors structured relay meta from perception data (origin loop-back drop)", () => {
    rt.receivePerceptionForTest("peerB", "Gateway_self", ["general"], {
      kind: "message",
      timestamp: Date.now(),
      // Clean content body; envelope only in structured fields.
      data: {
        channel: "general",
        senderName: "bob",
        content: "clean body",
        relayOrigin: "self",
        relayHops: 1,
      },
    });
    expect(relayCalls).toHaveLength(0); // origin === localWorldName → looped back → dropped
  });

  it("drops an over-hopped relay carried in structured meta", () => {
    rt.receivePerceptionForTest("peerB", "Gateway_self", ["general"], {
      kind: "message",
      timestamp: Date.now(),
      data: { channel: "general", senderName: "bob", content: "clean body", relayHops: 3 },
    });
    expect(relayCalls).toHaveLength(0);
  });

  it("does not relay a channel on an unbridged channel", () => {
    rt.receivePerceptionForTest("peerB", "Gateway_self", [], chanPerc("general", "bob", "hi"));
    expect(relayCalls).toHaveLength(0);
  });

  it("drops an over-hopped channel relay by structured hop count", () => {
    feedChan(buildRelayEnvelope({ hops: 3 }, "loop me"));
    expect(relayCalls).toHaveLength(0);
  });

  it("drops a channel relay that looped back to its origin instance", () => {
    feedChan(buildRelayEnvelope({ origin: "self", hops: 1 }, "came home"));
    expect(relayCalls).toHaveLength(0);
  });

  it("cannot be defeated by content-spoofing [from — structured hops win", () => {
    // Four fake "[from " tokens in the body would trip the legacy count (>=3),
    // but the structured envelope says hops=0, so the message is still relayed.
    feedChan(buildRelayEnvelope({ hops: 0 }, "[from a][from b][from c][from d] real"));
    expect(relayCalls).toHaveLength(1);
  });

  it("still drops legacy over-hopped relays via the fallback count", () => {
    feedChan("[from a/x] [from b/y] [from c/z] legacy loop");
    expect(relayCalls).toHaveLength(0);
  });

  it("recovers a tell target from a leading @name token", () => {
    feedTell("@alice private hello");
    expect(tellCalls).toHaveLength(1);
    expect(tellCalls[0]!.target).toBe("alice");
    expect(tellCalls[0]!.message).toBe("private hello");
  });

  it("recovers a tell target from the structured envelope", () => {
    feedTell(buildRelayEnvelope({ hops: 0, target: "carol" }, "hi carol"));
    expect(tellCalls[0]!.target).toBe("carol");
  });

  it("passes an undefined target when none is recoverable (no broadcast fan-out)", () => {
    feedTell("just a bare message");
    expect(tellCalls).toHaveLength(1);
    expect(tellCalls[0]!.target).toBeUndefined();
  });

  it("drops an over-hopped tell relay", () => {
    feedTell(buildRelayEnvelope({ hops: 3 }, "@alice loop"));
    expect(tellCalls).toHaveLength(0);
  });

  it("drops a tell relay that looped back to its origin instance", () => {
    feedTell(buildRelayEnvelope({ origin: "self", hops: 1 }, "@alice home"));
    expect(tellCalls).toHaveLength(0);
  });

  it("does not relay tells from another gateway identity", () => {
    feedTell("@alice hi", "Gateway_evil");
    expect(tellCalls).toHaveLength(0);
  });
});

// ─── Engine wiring: targeted delivery + untrusted tagging ───────────────────

describe("gateway relay engine wiring", () => {
  const TEST_DB = "test_gateway_relay.db";
  let db: MarinaDB;
  let engine: Engine;
  let aliceConn: MockConnection;
  let bobConn: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    aliceConn = new MockConnection("ca");
    bobConn = new MockConnection("cb");
    engine.addConnection(aliceConn);
    engine.addConnection(bobConn);
    engine.spawnEntity("ca", "Alice");
    engine.spawnEntity("cb", "Bob");
    aliceConn.clear();
    bobConn.clear();
  });

  afterEach(() => {
    engine.gatewayRuntime?.close().catch(() => {});
    db.close();
    cleanupDb(TEST_DB);
  });

  it("delivers a relayed tell ONLY to the addressed local target, tagged untrusted", () => {
    engine.gatewayRuntime!.receivePerceptionForTest(
      "peerB",
      "Gateway_self",
      [],
      tellPerc("remoteUser", "@Alice cross-instance hello"),
    );

    // Alice (the addressed target) receives exactly one gateway perception.
    const aliceMsgs = aliceConn.messages.filter((m) => m.tag === "gateway");
    expect(aliceMsgs).toHaveLength(1);
    expect(aliceMsgs[0]!.data.untrusted).toBe(true);
    expect(aliceMsgs[0]!.data.source).toBe("gateway");
    expect(aliceMsgs[0]!.data.text).toContain("cross-instance hello");

    // Bob (an unrelated agent) receives nothing — no broadcast fan-out.
    expect(bobConn.messages.filter((m) => m.tag === "gateway")).toHaveLength(0);
  });

  it("drops an untargeted relayed tell instead of broadcasting to all agents", () => {
    engine.gatewayRuntime!.receivePerceptionForTest(
      "peerB",
      "Gateway_self",
      [],
      tellPerc("remoteUser", "bare untargeted message"),
    );
    expect(aliceConn.messages.filter((m) => m.tag === "gateway")).toHaveLength(0);
    expect(bobConn.messages.filter((m) => m.tag === "gateway")).toHaveLength(0);
  });

  it("tags relayed channel content as an untrusted source", () => {
    const ch = engine.channelManager!.createChannel({ type: "custom", name: "general" });
    engine.channelManager!.addMember(ch.id, aliceConn.entity!);
    aliceConn.clear();

    engine.gatewayRuntime!.receivePerceptionForTest(
      "peerB",
      "Gateway_self",
      ["general"],
      chanPerc("general", "remoteBob", "hello from the mesh"),
    );

    const chanMsgs = aliceConn.messages.filter((m) => m.data?.channel === "general");
    expect(chanMsgs).toHaveLength(1);
    expect(chanMsgs[0]!.data.untrusted).toBe(true);
    expect(chanMsgs[0]!.data.source).toBe("gateway");
    expect(chanMsgs[0]!.data.content).toContain("[from peerB/remoteBob] hello from the mesh");
  });

  it("strips the relay envelope from locally delivered + persisted channel content", () => {
    const ch = engine.channelManager!.createChannel({ type: "custom", name: "general" });
    engine.channelManager!.addMember(ch.id, aliceConn.entity!);
    aliceConn.clear();

    // Inbound content from a peer carries the envelope inline in the body.
    engine.gatewayRuntime!.receivePerceptionForTest(
      "peerB",
      "Gateway_self",
      ["general"],
      chanPerc(
        "general",
        "remoteBob",
        buildRelayEnvelope({ origin: "peerX", hops: 1 }, "mesh hello"),
      ),
    );

    const chanMsgs = aliceConn.messages.filter((m) => m.data?.channel === "general");
    expect(chanMsgs).toHaveLength(1);
    // Local member sees the CLEAN body — no `[relay origin=` framing.
    expect(chanMsgs[0]!.data.content).not.toContain("[relay ");
    expect(chanMsgs[0]!.data.content).toContain("mesh hello");
    // Envelope preserved out-of-band for peer loop detection.
    expect(chanMsgs[0]!.data.relayOrigin).toBe("peerX");
    expect(chanMsgs[0]!.data.relayHops).toBe(2);

    // Persisted channel_messages.content is likewise clean.
    const history = engine.channelManager!.getHistory(ch.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.content).not.toContain("[relay ");
    expect(history[0]!.content).toContain("mesh hello");
  });
});
