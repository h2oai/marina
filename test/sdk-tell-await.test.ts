// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * tellAndAwait reply correlation — the crew-fast-dispatch primitive must
 * return THE reply to THIS question, not any tell from the target.
 *
 * The unit block drives a MarinaClient over a stubbed transport so the
 * delivery order of perceptions (stale frame → own echo → reply) is exact.
 * The integration block runs the same primitive against a live engine.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import {
  hasCorrelationTag,
  isTellNotice,
  MarinaClient,
  stripCorrelationTag,
  TELL_NOTICE_PREFIX,
} from "../src/sdk/client";
import { type Perception, roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

// ─── Stubbed transport ───────────────────────────────────────────────────────

interface FakeClient {
  client: MarinaClient;
  /** Raw command strings the client sent. */
  sent: string[];
  /** Inject a perception as if it came off the socket. */
  deliver: (p: Perception) => void;
  /** Correlation id from the last outgoing `tell` (null when untagged). */
  lastTag: () => string | null;
  /** Deliver the engine's own `You tell …` echo for the last outgoing tell. */
  ack: (target: string) => void;
  /** Deliver an inbound tell from `from`. */
  inbound: (from: string, text: string, timestamp?: number) => void;
}

function fakeClient(): FakeClient {
  const client = new MarinaClient("ws://fake", { autoReconnect: false, commandDrainTimeout: 10 });
  const sent: string[] = [];
  const c = client as unknown as {
    session: unknown;
    connected: boolean;
    send: (d: Record<string, unknown>) => void;
    dispatchPerception: (p: Perception) => void;
  };
  c.session = { entityId: "e_alice", token: "t", name: "Alice" };
  c.connected = true;
  c.send = (d) => {
    if (typeof d.command === "string") sent.push(d.command);
  };
  const lastTag = (): string | null => {
    const last = sent[sent.length - 1] ?? "";
    return /\[re:([a-z0-9]{6})\]$/.exec(last)?.[1] ?? null;
  };
  return {
    client,
    sent,
    deliver: (p) => c.dispatchPerception(p),
    lastTag,
    ack: (target) => {
      const last = sent[sent.length - 1] ?? "";
      const outgoing = last.replace(new RegExp(`^tell ${target} `), "");
      c.dispatchPerception({
        kind: "message",
        tag: "tell",
        timestamp: Date.now(),
        data: { text: `> You tell ${target}: ${outgoing} [delivered #7]` },
      });
    },
    inbound: (from, text, timestamp = Date.now()) => {
      c.dispatchPerception({
        kind: "message",
        tag: "tell",
        timestamp,
        data: { text: `> ${from} tells you: ${text}`, senderName: from, message: text },
      });
    },
  };
}

describe("tellAndAwait — reply correlation (stubbed transport)", () => {
  it("tags the outgoing message with [re:<id>] by default and strips it from the reply", async () => {
    const f = fakeClient();
    const p = f.client.tellAndAwait("Bob", "what is 6*7?", 2000);
    expect(f.sent[0]).toMatch(/^tell Bob what is 6\*7\? \[re:[a-z0-9]{6}\]$/);
    const id = f.lastTag()!;
    f.ack("Bob");
    f.inbound("Bob", `[re:${id}] 42`);
    expect(await p).toBe("42");
  });

  it("(a) ignores a stale queued tell that predates the question", async () => {
    const f = fakeClient();
    const sentAt = Date.now();
    const p = f.client.tellAndAwait("Bob", "second question", 2000, { graceMs: 50 });
    const id = f.lastTag()!;
    // A late answer to a PREVIOUS question, already on the wire before our
    // tell was delivered: it arrives before our own echo with an older
    // server timestamp. Must not be taken as the answer.
    f.inbound("Bob", "answer to the first question", sentAt - 1000);
    f.ack("Bob");
    f.inbound("Bob", `real answer [re:${id}]`);
    expect(await p).toBe("real answer");
  });

  it("(a') a stale untagged tell before the echo does not even become the fallback candidate", async () => {
    const f = fakeClient();
    const sentAt = Date.now();
    const p = f.client.tellAndAwait("Bob", "q", 2000, { graceMs: 50 });
    f.inbound("Bob", "stale", sentAt - 5);
    f.ack("Bob");
    f.inbound("Bob", "fresh untagged");
    expect(await p).toBe("fresh untagged");
  });

  it("(b) ignores adapter lifecycle notices; the real reply wins", async () => {
    const f = fakeClient();
    const p = f.client.tellAndAwait("Bob", "compute", 2000, { graceMs: 50 });
    const id = f.lastTag()!;
    f.ack("Bob");
    f.inbound(
      "Bob",
      "I've spent my model-call budget (20 calls) and paused. Review my work, then `agent stop Bob` or respawn me with a larger budget.",
    );
    f.inbound(
      "Bob",
      "I've hit a hourly spend cap ($1.00) and paused. I'll resume on my own once the last hour's spend drops below the cap; `agent stop Bob` ends me sooner.",
    );
    f.inbound("Bob", "I've hit 3 consecutive upstream errors (503) and paused for 5 min.");
    f.inbound("Bob", `${TELL_NOTICE_PREFIX} pausing for maintenance`);
    f.inbound("Bob", `done: 42 [re:${id}]`);
    expect(await p).toBe("done: 42");
  });

  it("(b') a notice alone never resolves — the call times out", async () => {
    const f = fakeClient();
    const p = f.client.tellAndAwait("Bob", "compute", 120, { graceMs: 20 });
    f.ack("Bob");
    f.inbound("Bob", "I've spent my model-call budget (5 calls) and paused.");
    await expect(p).rejects.toThrow(/no reply from "Bob" within 120ms/);
  });

  it("(c) a tagged reply wins over an untagged one that arrived first", async () => {
    const f = fakeClient();
    const p = f.client.tellAndAwait("Bob", "final answer?", 2000, { graceMs: 500 });
    const id = f.lastTag()!;
    f.ack("Bob");
    f.inbound("Bob", "thinking out loud, unrelated");
    await Bun.sleep(30);
    f.inbound("Bob", `the answer is 42 [re:${id}]`);
    const started = Date.now();
    expect(await p).toBe("the answer is 42");
    // Resolved on the tagged reply, not by waiting out the grace window.
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("(c') the tag is recognised bare (re:<id>) as well as bracketed", async () => {
    const f = fakeClient();
    const p = f.client.tellAndAwait("Bob", "q", 2000, { graceMs: 500 });
    const id = f.lastTag()!;
    f.ack("Bob");
    f.inbound("Bob", "noise");
    f.inbound("Bob", `re:${id} yes`);
    expect(await p).toBe("yes");
  });

  it("(d) an untagged fresh reply is accepted after the grace window", async () => {
    const f = fakeClient();
    const p = f.client.tellAndAwait("Bob", "q", 2000, { graceMs: 80 });
    f.ack("Bob");
    const started = Date.now();
    f.inbound("Bob", "plain reply");
    f.inbound("Bob", "second plain reply is not consumed");
    expect(await p).toBe("plain reply");
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it("(d') grace never extends past the overall timeout", async () => {
    const f = fakeClient();
    const p = f.client.tellAndAwait("Bob", "q", 100, { graceMs: 10_000 });
    f.ack("Bob");
    const started = Date.now();
    f.inbound("Bob", "late-ish but real");
    expect(await p).toBe("late-ish but real");
    expect(Date.now() - started).toBeLessThan(600);
  });

  it("(e) times out with the addressee and window when nothing fresh arrives", async () => {
    const f = fakeClient();
    const p = f.client.tellAndAwait("Carol", "anyone?", 100);
    f.ack("Carol");
    f.inbound("Eve", "not the addressee");
    await expect(p).rejects.toThrow(/tellAndAwait: no reply from "Carol" within 100ms/);
  });

  it("correlate:false sends the bare message and resolves on the first fresh non-notice tell", async () => {
    const f = fakeClient();
    const p = f.client.tellAndAwait("Bob", "ping", 2000, { correlate: false });
    expect(f.sent[0]).toBe("tell Bob ping");
    f.ack("Bob");
    f.inbound("Bob", "I've spent my model-call budget (1 calls) and paused.");
    f.inbound("Bob", "pong");
    expect(await p).toBe("pong");
  });

  it("matches the addressee case-insensitively", async () => {
    const f = fakeClient();
    const p = f.client.tellAndAwait("bob", "q", 2000, { correlate: false });
    f.ack("bob");
    f.inbound("Bob", "pong");
    expect(await p).toBe("pong");
  });

  it("before the echo is seen, a fresh-timestamped reply is still accepted (echo lost)", async () => {
    // Federated / relayed targets may not produce a recognisable echo; the
    // timestamp guard alone must then let a genuinely fresh reply through.
    const f = fakeClient();
    const p = f.client.tellAndAwait("Bob", "q", 2000);
    const id = f.lastTag()!;
    f.inbound("Bob", `pong [re:${id}]`, Date.now() + 1);
    expect(await p).toBe("pong");
  });
});

describe("tellAndAwait helpers", () => {
  it("isTellNotice matches the adapter's notices and the [notice] prefix only", () => {
    expect(isTellNotice("I've spent my model-call budget (20 calls) and paused.")).toBe(true);
    expect(isTellNotice("I've hit a hourly spend cap and paused.")).toBe(true);
    expect(isTellNotice("I've hit 4 consecutive upstream errors (timeout) and paused")).toBe(true);
    expect(isTellNotice("[notice] anything")).toBe(true);
    expect(isTellNotice("  [NOTICE] leading whitespace + case")).toBe(true);
    expect(isTellNotice("I've hit the jackpot: the answer is 42")).toBe(false);
    expect(isTellNotice("The budget for Q3 is 42")).toBe(false);
    expect(isTellNotice("42")).toBe(false);
  });

  it("hasCorrelationTag / stripCorrelationTag handle bracketed, bare and repeated tags", () => {
    expect(hasCorrelationTag("x [re:abc123]", "abc123")).toBe(true);
    expect(hasCorrelationTag("re:abc123 x", "abc123")).toBe(true);
    expect(hasCorrelationTag("x [re:abc124]", "abc123")).toBe(false);
    expect(stripCorrelationTag("[re:abc123] 42", "abc123")).toBe("42");
    expect(stripCorrelationTag("42 [re:abc123]", "abc123")).toBe("42");
    expect(stripCorrelationTag("[re:abc123] 42 re:abc123", "abc123")).toBe("42");
    expect(stripCorrelationTag("no tag here", "abc123")).toBe("no tag here");
  });
});

// ─── Live engine ─────────────────────────────────────────────────────────────

const TEST_PORT = 13398;
const TEST_URL = `ws://localhost:${TEST_PORT}`;

describe("tellAndAwait — live engine", () => {
  let db: MarinaDB;
  let engine: Engine;
  let wsServer: WebSocketServer;
  const dbPath = `/tmp/marina-sdk-tell-await-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({ short: "Starting Room", long: "A room for tellAndAwait testing." }),
    );
    wsServer = new WebSocketServer(engine, TEST_PORT);
    wsServer.start();
    engine.start();
  });

  afterEach(async () => {
    wsServer.stop();
    await Bun.sleep(50);
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  const inboundTellFrom =
    (from: string) =>
    (p: Perception): string | null => {
      if (p.kind !== "message" || p.tag !== "tell") return null;
      const data = p.data as Record<string, unknown> | undefined;
      if (data?.senderName !== from) return null;
      return typeof data.message === "string" ? data.message : null;
    };

  it("a responder that echoes the tag resolves immediately with the tag stripped", async () => {
    const alice = new MarinaClient(TEST_URL, { autoReconnect: false });
    const bob = new MarinaClient(TEST_URL, { autoReconnect: false });
    await alice.connect("Alice");
    await bob.connect("Bob");

    const seenByBob: string[] = [];
    const fromAlice = inboundTellFrom("Alice");
    bob.onPerception((p) => {
      const text = fromAlice(p);
      if (text === null) return;
      seenByBob.push(text);
      const tag = /\[re:[a-z0-9]{6}\]/.exec(text)?.[0] ?? "";
      bob.command(`tell Alice ${tag} pong`).catch(() => {});
    });

    const started = Date.now();
    const reply = await alice.tellAndAwait("Bob", "ping", 5000, { graceMs: 3000 });
    expect(reply).toBe("pong");
    // Tagged reply → no grace wait.
    expect(Date.now() - started).toBeLessThan(2500);
    expect(seenByBob[0]).toMatch(/^ping \[re:[a-z0-9]{6}\]$/);

    alice.disconnect();
    bob.disconnect();
  });

  it("a stale reply already in flight is not returned as the answer to the next question", async () => {
    const alice = new MarinaClient(TEST_URL, { autoReconnect: false });
    const bob = new MarinaClient(TEST_URL, { autoReconnect: false });
    await alice.connect("Alice");
    await bob.connect("Bob");

    const fromAlice = inboundTellFrom("Alice");
    bob.onPerception((p) => {
      const text = fromAlice(p);
      if (text === null) return;
      const tag = /\[re:[a-z0-9]{6}\]/.exec(text)?.[0] ?? "";
      bob
        .command(`tell Alice ${tag} reply to: ${text.replace(/ \[re:[a-z0-9]{6}\]$/, "")}`)
        .catch(() => {});
    });

    // Bob's answer to an earlier question is on the wire while Alice asks the next one.
    bob.command("tell Alice late answer to the previous question").catch(() => {});
    const reply = await alice.tellAndAwait("Bob", "second question", 5000);
    expect(reply).toBe("reply to: second question");

    alice.disconnect();
    bob.disconnect();
  });

  it("a budget notice interleaved with the real reply is ignored", async () => {
    const alice = new MarinaClient(TEST_URL, { autoReconnect: false });
    const bob = new MarinaClient(TEST_URL, { autoReconnect: false });
    await alice.connect("Alice");
    await bob.connect("Bob");

    const fromAlice = inboundTellFrom("Alice");
    bob.onPerception((p) => {
      if (fromAlice(p) === null) return;
      bob
        .command(
          "tell Alice I've spent my model-call budget (20 calls) and paused. Review my work, then `agent stop Bob`.",
        )
        .catch(() => {});
      setTimeout(() => bob.command("tell Alice 42").catch(() => {}), 100);
    });

    const reply = await alice.tellAndAwait("Bob", "what is 6*7?", 5000, { graceMs: 200 });
    expect(reply).toBe("42");

    alice.disconnect();
    bob.disconnect();
  });
});
