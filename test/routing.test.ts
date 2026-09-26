// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { runRetentionPass } from "../src/engine/retention";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { MarinaDB } from "../src/persistence/database";
import { exportState, importState } from "../src/persistence/export-import";
import { BASE_SCHEMA, MIGRATIONS } from "../src/persistence/schema";
import { RoutingService } from "../src/routing/service";
import { MarinaRoutingClient, RoutingApiError } from "../src/sdk/routing-client";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

let db: MarinaDB;
let directory: string;
let path: string;
let alice: RoutingService;
let bob: RoutingService;
const spec = (clientKey: string, groupId?: string) => ({
  clientKey,
  label: clientKey,
  kind: "service",
  groupId,
});
const event = (id: string, text = id) => ({ id, kind: "output", payload: { text } });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-routing-"));
  path = join(directory, "world.db");
  db = new MarinaDB(path);
  db.createUser({ id: "alice", name: "Alice" });
  db.createUser({ id: "bob", name: "Bob" });
  db.createGroup({ id: "team", name: "Team", leaderId: "alice" });
  db.addGroupMember("team", "alice");
  db.addGroupMember("team", "bob");
  alice = new RoutingService(db, "alice");
  bob = new RoutingService(db, "bob");
  resetHttpRateLimitersForTests();
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("generic participant routing", () => {
  it("aggregates attention before pagination, respects current visibility, and never consumes requests", () => {
    const privateSession = alice.join(spec("private-attention"));
    const shared = alice.join(spec("shared-attention", "team"));
    const publishState = (id: string, key: string, request?: object) =>
      alice.publish(id, [
        {
          id: key,
          kind: "runtime.state",
          payload: { version: 1, role: "agent", status: "waiting", updatedAt: 1, request },
        },
      ]);
    publishState(privateSession.id, "private-state", { title: "Secret question" });
    publishState(shared.id, "shared-state", { title: "Review?" });
    const pending = alice.send(shared.id, {
      clientMessageId: "unchanged",
      targetId: shared.id,
      kind: "note",
      payload: "hello",
    });
    for (let i = 0; i < 105; i++) {
      const participant = alice.join(spec(`att-${i}`));
      publishState(participant.id, "state", { title: "Question" });
    }
    const first = alice.overview("", 100, true);
    expect(first.total).toBe(107);
    expect(first.items).toHaveLength(100);
    const second = alice.overview(first.nextCursor!, 100, true);
    expect(second.total).toBe(107);
    expect(second.items).toHaveLength(7);
    expect(new Set([...first.items, ...second.items].map((item) => item.session.id)).size).toBe(
      107,
    );
    expect(bob.overview("", 100, true).items).toEqual([
      expect.objectContaining({
        session: expect.objectContaining({ id: shared.id }),
        owned: false,
        runtime: expect.objectContaining({ request: { title: "Review?" } }),
      }),
    ]);
    expect(alice.inbox(shared.id)).toEqual([pending]);
    publishState(shared.id, "resolved");
    expect(bob.overview("", 100, true).total).toBe(0);
    alice.publish(shared.id, [
      { id: "failed", kind: "delivery.error", payload: { messageId: pending.id } },
    ]);
    expect(bob.overview("", 100, true).items[0]?.lastDelivery).toMatchObject({
      kind: "delivery.error",
      payload: { messageId: pending.id },
    });
    alice.publish(shared.id, [
      { id: "accepted", kind: "delivery.accepted", payload: { messageId: pending.id } },
    ]);
    expect(bob.overview("", 100, true).total).toBe(0);
    db.removeGroupMember("team", "bob");
    expect(bob.overview().items).toEqual([]);
    expect(alice.overview().items.every((item) => item.owned)).toBe(true);
  });
  it("joins 125 independent clients under one account and paginates without creating world connections", () => {
    for (let i = 0; i < 125; i++) alice.join(spec(`client-${i}`));
    const page = alice.list("", 100);
    expect(page.sessions).toHaveLength(100);
    const next = alice.list(page.nextCursor!, 100);
    expect(next.sessions).toHaveLength(25);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...page.sessions, ...next.sessions].map((s) => s.id)).size).toBe(125);
    expect(bob.list().sessions).toEqual([]);
  });

  it("resumes stable identities; leave never implies process termination", () => {
    const joined = alice.join(spec("external"));
    alice.publish(joined.id, [event("one")]);
    alice.leave(joined.id);
    expect(() => alice.publish(joined.id, [event("two")])).toThrow("Rejoin");
    expect(alice.events(joined.id).events).toHaveLength(1);
    const resumed = alice.join(spec("external"));
    expect(resumed.id).toBe(joined.id);
    expect(resumed.lastSequence).toBe(1);
    expect(resumed.state).toBe("active");
    expect(() => alice.join({ ...spec("external"), groupId: "team" })).toThrow("Idempotency");
  });

  it("enforces private ownership and current shared membership on reads and writes", () => {
    const secret = alice.join(spec("private"));
    const shared = alice.join(spec("shared", "team"));
    expect(() => bob.get(secret.id)).toThrow("not found");
    expect(bob.list().sessions.map((s) => s.id)).toEqual([shared.id]);
    expect(() => bob.publish(shared.id, [event("forged")])).toThrow("owner");
    expect(() => bob.leave(shared.id)).toThrow("owner");
    db.removeGroupMember("team", "bob");
    expect(bob.list().sessions).toEqual([]);
    expect(() => bob.events(shared.id)).toThrow("not found");
    expect(() => bob.join(spec("bad", "team"))).toThrow("Join the Marina group");
    db.removeGroupMember("team", "alice");
    expect(() => alice.publish(shared.id, [event("bad")])).toThrow("membership");
    expect(alice.get(shared.id).ownerId).toBe("alice");
  });

  it("commits ordered batches atomically and deduplicates retries, including conflicting duplicates", () => {
    const s = alice.join(spec("output"));
    const first = alice.publish(s.id, [event("a"), event("b")]);
    expect(first.map((e) => e.sequence)).toEqual([1, 2]);
    expect(alice.publish(s.id, [event("a"), event("b")])).toEqual(first);
    expect(() => alice.publish(s.id, [event("c"), event("a", "changed")])).toThrow("Idempotency");
    expect(alice.get(s.id).lastSequence).toBe(2);
    expect(alice.publish(s.id, [event("c")])[0]!.sequence).toBe(3);
    const page = alice.events(s.id, 0, 2);
    expect(page.nextCursor).toBe(2);
    expect(page.hasMore).toBe(true);
    expect(page.gap).toBe(false);
    expect(alice.events(s.id, 2).events.map((e) => e.id)).toEqual(["c"]);
  });

  it("reports pruned history even when the entire retained page is gone", () => {
    const s = alice.join(spec("pruned"));
    alice.publish(s.id, [event("a"), event("b"), event("c")]);
    const sql = new Database(path);
    try {
      sql.run("DELETE FROM routing_events WHERE sequence < 3");
      const page = alice.events(s.id);
      expect(page.gap).toBe(true);
      expect(page.nextCursor).toBe(3);
      sql.run("DELETE FROM routing_events");
      expect(alice.events(s.id).gap).toBe(true);
      expect(alice.events(s.id).nextCursor).toBe(3);
      expect(alice.events(s.id, 3).gap).toBe(false);
    } finally {
      sql.close();
    }
  });

  it("durably queues messages, never acknowledges on read, and exposes idempotent receipts", () => {
    const a = alice.join(spec("sender", "team"));
    const b = bob.join(spec("receiver", "team"));
    const input = {
      clientMessageId: "work-1",
      targetId: b.id,
      kind: "note",
      payload: { text: "Review the design" },
    };
    const sent = alice.send(a.id, input);
    expect(alice.send(a.id, input)).toEqual(sent);
    expect(bob.inbox(b.id)).toEqual([sent]);
    expect(bob.inbox(b.id)).toEqual([sent]);
    expect(() => alice.acknowledge(a.id, sent.id)).toThrow("not found");
    db.close();
    db = new MarinaDB(path);
    alice = new RoutingService(db, "alice");
    bob = new RoutingService(db, "bob");
    expect(bob.inbox(b.id)).toEqual([sent]);
    const ack = bob.acknowledge(b.id, sent.id);
    expect(ack.status).toBe("acknowledged");
    expect(bob.acknowledge(b.id, sent.id)).toEqual(ack);
    expect(alice.receipt(a.id, sent.id)).toEqual(ack);
    expect(bob.inbox(b.id)).toEqual([]);
    expect(() => alice.send(a.id, { ...input, payload: "different" })).toThrow("Idempotency");
    bob.leave(b.id);
    expect(alice.send(a.id, input)).toEqual(ack);
    expect(() => alice.send(a.id, { ...input, clientMessageId: "new" })).toThrow(
      "Recipient has left",
    );
  });

  it("prevents cross-scope injection and rejects new messages after recipient group removal", () => {
    const a = alice.join(spec("private"));
    const b = bob.join(spec("shared", "team"));
    const input = { clientMessageId: "x", targetId: b.id, kind: "note", payload: "hello" };
    expect(() => alice.send(a.id, input)).toThrow("share a current");
    const shared = alice.join(spec("shared", "team"));
    db.removeGroupMember("team", "bob");
    expect(() => alice.send(shared.id, input)).toThrow("share a current");
    expect(() => bob.inbox(b.id)).toThrow("membership");
  });

  it("bounds pending inboxes with retry-safe admission", () => {
    const a = alice.join(spec("sender"));
    const b = alice.join(spec("target"));
    let first = "";
    for (let i = 0; i < 1000; i++) {
      const message = alice.send(a.id, {
        clientMessageId: `${i}`,
        targetId: b.id,
        kind: "note",
        payload: i,
      });
      if (i === 0) first = message.id;
    }
    const next = { clientMessageId: "1000", targetId: b.id, kind: "note", payload: null };
    expect(() => alice.send(a.id, next)).toThrow("inbox is full");
    alice.acknowledge(b.id, first);
    expect(alice.send(a.id, next).status).toBe("queued");
  });

  it("retains pending work while pruning expired output and settled receipts", () => {
    const a = alice.join(spec("retention-sender"));
    const b = alice.join(spec("retention-target"));
    alice.publish(a.id, [event("old-output")]);
    const pending = alice.send(a.id, {
      clientMessageId: "pending",
      targetId: b.id,
      kind: "note",
      payload: "pending",
    });
    const settled = alice.send(a.id, {
      clientMessageId: "settled",
      targetId: b.id,
      kind: "note",
      payload: "handled",
    });
    alice.acknowledge(b.id, settled.id);
    const sql = new Database(path);
    const old = Date.now() - 100 * 86_400_000;
    try {
      sql.run("UPDATE routing_events SET created_at = ?", [old]);
      sql.run("UPDATE routing_messages SET created_at = ?", [old]);
      sql.run("UPDATE routing_messages SET acknowledged_at = ? WHERE status = 'acknowledged'", [
        old,
      ]);
    } finally {
      sql.close();
    }
    runRetentionPass(db, { now: Date.now(), overridesEnv: "" });
    expect(alice.events(a.id).gap).toBe(true);
    expect(alice.inbox(b.id).map((message) => message.id)).toEqual([pending.id]);
    expect(db.getRoutingMessage(settled.id)).toBeNull();
  });

  it("validates inputs before allocating sequences or sessions", () => {
    const s = alice.join(spec("validate"));
    expect(() => alice.join({ ...spec("bad"), capabilities: "exec" })).toThrow("capabilities");
    expect(() => alice.publish(s.id, [])).toThrow("between 1 and 100");
    expect(() => alice.publish(s.id, [event("large", "x".repeat(32769))])).toThrow("32 KiB");
    expect(() => alice.publish(s.id, [{ id: "x", kind: "text" }])).toThrow("payload");
    expect(() => alice.events(s.id, -1)).toThrow("cursor");
    expect(() => alice.events(s.id, 0, 201)).toThrow("limit");
    expect(() => alice.events(s.id, 1)).toThrow("ahead");
    expect(alice.get(s.id).lastSequence).toBe(0);
  });

  it("exports and restores output, pending delivery, and session identities", () => {
    const a = alice.join(spec("sender", "team"));
    const b = bob.join(spec("receiver", "team"));
    alice.publish(a.id, [event("output")]);
    const sent = alice.send(a.id, {
      clientMessageId: "persist",
      targetId: b.id,
      kind: "note",
      payload: "hi",
    });
    db.createChannel({ id: "ch:restore", name: "restore", type: "custom" });
    db.addChannelMember("ch:restore", "alice");
    const nativeInput = {
      clientMessageId: "canonical",
      text: "Native conversation survives restore",
    };
    const native = alice.publishChannel(a.id, "ch:restore", nativeInput);
    const snapshot = exportState(path);
    const destination = join(directory, "restore.db");
    new MarinaDB(destination).close();
    expect(importState(destination, snapshot).errors).toEqual([]);
    const restored = new MarinaDB(destination);
    try {
      const a2 = new RoutingService(restored, "alice");
      const b2 = new RoutingService(restored, "bob");
      expect(a2.join(spec("sender", "team")).id).toBe(a.id);
      expect(a2.events(a.id).events[0]!.id).toBe("output");
      expect(b2.inbox(b.id)).toEqual([sent]);
      expect(a2.publishChannel(a.id, "ch:restore", nativeInput)).toEqual({
        ...native,
        duplicate: true,
      });
      expect(restored.getChannelHistory("ch:restore")).toHaveLength(1);
    } finally {
      restored.close();
    }
  });

  it("upgrades the previous schema without changing existing world data", () => {
    const oldPath = join(directory, "old.db");
    const sql = new Database(oldPath);
    sql.exec(BASE_SCHEMA);
    for (const migration of MIGRATIONS.filter((m) => m.version <= 122)) {
      sql.exec(migration.sql);
      sql.run("INSERT INTO schema_version VALUES (?)", [migration.version]);
    }
    sql.run(
      "INSERT INTO users (id, name, created_at, last_login, rank) VALUES ('old-user', 'Existing', 1, 1, 2)",
    );
    sql.close();
    const upgraded = new MarinaDB(oldPath);
    try {
      expect(upgraded.getUser("old-user")?.rank).toBe(2);
      expect(new RoutingService(upgraded, "old-user").join(spec("new-client")).ownerId).toBe(
        "old-user",
      );
    } finally {
      upgraded.close();
    }
  });
});

describe("routing HTTP and portable SDK", () => {
  function fixture() {
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    const conn = new MockConnection("routing-sdk");
    engine.addConnection(conn);
    const login = engine.login(conn.id, "SdkUser");
    if ("error" in login) throw new Error(login.error);
    const requests: Request[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const req = new Request(url, init);
      requests.push(req);
      return (await handleDashboardApi(req, new URL(req.url), req.method, engine, db))!;
    }) as typeof fetch;
    const client = new MarinaRoutingClient({
      url: "http://localhost:3300",
      token: login.token,
      fetch: fetcher,
    });
    return { engine, client, fetcher, requests, login, conn };
  }
  it("runs join → publish → replay → send → inbox → ack through authenticated HTTP", async () => {
    const { client, engine, requests, login } = fixture();
    const a = await client.join(spec("cli-a"));
    const b = await client.join(spec("cli-b"));
    expect((await client.overview()).total).toBe(2);
    expect((await client.overview("", true)).total).toBe(0);
    expect(engine.getConnections().size).toBe(1);
    const published = await client.publish(a.id, [event("x")]);
    expect((await client.events(a.id)).events).toEqual(published);
    const msg = await client.send(a.id, {
      clientMessageId: "id",
      targetId: b.id,
      kind: "note",
      payload: "hello",
    });
    expect(await client.inbox(b.id)).toEqual([msg]);
    await client.acknowledge(b.id, msg.id);
    expect((await client.receipt(a.id, msg.id)).status).toBe("acknowledged");
    await client.leave(a.id);
    expect((await client.join(spec("cli-a"))).id).toBe(a.id);
    expect(requests.every((req) => !req.url.includes(login.token))).toBe(true);
    expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${login.token}`);
    engine.removeConnection("routing-sdk");
  });

  it("keeps private streams inaccessible with invalid credentials, including dev-open mode", async () => {
    const { fetcher, client, engine } = fixture();
    const s = await client.join(spec("private"));
    const previous = process.env.MARINA_OPEN_API;
    process.env.MARINA_OPEN_API = "true";
    try {
      const response = await fetcher(`http://localhost:3300/api/routing/sessions/${s.id}/events`, {
        headers: { Authorization: "Bearer invalid" },
      });
      expect(response.status).toBe(403);
      const overview = await fetcher("http://localhost:3300/api/routing/overview", {
        headers: { Authorization: "Bearer invalid" },
      });
      expect(overview.status).toBe(403);
    } finally {
      if (previous === undefined) delete process.env.MARINA_OPEN_API;
      else process.env.MARINA_OPEN_API = previous;
      engine.removeConnection("routing-sdk");
    }
  });

  it("rejects oversized streamed bodies and malformed JSON, while preserving typed SDK errors", async () => {
    const { fetcher, client, login, engine } = fixture();
    const headers = { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" };
    expect(
      (
        await fetcher("http://localhost:3300/api/routing/sessions", {
          method: "POST",
          headers,
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetcher("http://localhost:3300/api/routing/sessions", {
          method: "POST",
          headers,
          body: "x".repeat(262145),
        })
      ).status,
    ).toBe(413);
    try {
      await client.join({ ...spec("bad"), label: "" });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RoutingApiError);
      expect((error as RoutingApiError).status).toBe(400);
    }
    engine.removeConnection("routing-sdk");
  });

  it("supports cancellation and resumes an SDK watch from the last processed cursor", async () => {
    const { client, engine } = fixture();
    const s = await client.join(spec("watched"));
    await client.publish(s.id, [event("a"), event("b")]);
    const abort = new AbortController();
    const watch = client.watch(s.id, { after: 1, signal: abort.signal });
    const page = await watch.next();
    if (page.done) throw new Error("Expected a replay page");
    expect(page.value.events.map((e) => e.id)).toEqual(["b"]);
    expect(page.value!.nextCursor).toBe(2);
    abort.abort();
    expect((await watch.next()).done).toBe(true);
    engine.removeConnection("routing-sdk");
  });
});

describe("native Marina conversations", () => {
  it("shares one channel history and live delivery with humans and existing listeners", async () => {
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    const senderConn = new MockConnection("native-sender");
    const humanConn = new MockConnection("native-human");
    engine.addConnection(senderConn);
    engine.addConnection(humanConn);
    const sender = engine.login(senderConn.id, "ExternalOwner");
    const human = engine.login(humanConn.id, "Human");
    if ("error" in sender || "error" in human) throw new Error("login failed");
    const channel = engine.channelManager!.createChannel({ type: "custom", name: "native-team" });
    engine.channelManager!.addMember(channel.id, sender.entityId);
    engine.channelManager!.addMember(channel.id, human.entityId);
    const observed: string[] = [];
    engine.channelManager!.onMessage((_channel, _sender, _name, content) => observed.push(content));
    const events: string[] = [];
    engine.addEventListener((e) => {
      if (e.type === "channel_message") events.push(e.content);
    });
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const req = new Request(url, init);
      return (await handleDashboardApi(req, new URL(req.url), req.method, engine, db))!;
    }) as typeof fetch;
    const client = new MarinaRoutingClient({
      url: "http://localhost:3300",
      token: sender.token,
      fetch: fetcher,
    });
    try {
      const joined = await client.join(spec("claude-native"));
      const input = { clientMessageId: "native-1", text: "Review is ready" };
      const receipt = await client.sendChannel(joined.id, channel.id, input);
      expect(receipt.duplicate).toBe(false);
      expect(receipt.message.senderName).toBe("ExternalOwner");
      expect(receipt.message.content).toContain(joined.id);
      expect(humanConn.messages.some((p) => JSON.stringify(p).includes("Review is ready"))).toBe(
        true,
      );
      expect(events).toHaveLength(1);
      expect(observed).toHaveLength(1);
      expect((await client.sendChannel(joined.id, channel.id, input)).duplicate).toBe(true);
      expect(events).toHaveLength(1);
      expect(db.getChannelHistory(channel.id)).toHaveLength(1);
      expect(observed).toHaveLength(1);
      await engine.processCommand(human.entityId, "channel send native-team Thanks, checking now");
      const history = await client.channelMessages(joined.id, channel.id);
      expect(history.messages.map((m) => m.senderName)).toEqual(["ExternalOwner", "Human"]);
      expect(history.messages[1]!.content).toBe("Thanks, checking now");
      expect(
        (await client.channelMessages(joined.id, channel.id, history.nextCursor)).messages,
      ).toEqual([]);
      expect(engine.getConnections().size).toBe(2);
      // Removing native channel access takes effect even though the router session remains active.
      db.addChannelMember(channel.id, sender.entityId, true, false);
      await expect(
        client.sendChannel(joined.id, channel.id, { ...input, clientMessageId: "denied" }),
      ).rejects.toThrow("write membership");
      db.removeChannelMember(channel.id, sender.entityId);
      await expect(client.channelMessages(joined.id, channel.id)).rejects.toThrow(
        "read membership",
      );
    } finally {
      engine.removeConnection(senderConn.id);
      engine.removeConnection(humanConn.id);
    }
  });

  it("keeps private delivery inspection owner-only and leaves messages queued", () => {
    const a = alice.join(spec("sender", "team"));
    const b = bob.join(spec("receiver", "team"));
    const sent = alice.send(a.id, {
      clientMessageId: "visible-receipt",
      targetId: b.id,
      kind: "note",
      payload: "private note",
    });
    expect(alice.deliveries(a.id)).toEqual([sent]);
    expect(bob.deliveries(b.id)).toEqual([sent]);
    expect(() => bob.deliveries(a.id)).toThrow("owner");
    expect(bob.inbox(b.id)).toEqual([sent]);
    bob.acknowledge(b.id, sent.id);
    expect(alice.deliveries(a.id)[0]!.status).toBe("acknowledged");
  });
});
