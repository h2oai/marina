// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// marina.wire.v1 is the contract every SDK implements, so it is checked against a
// real server: every frame a live session receives must match the published schema,
// the well-known frames must match their own definitions, and every example in the
// protocol guide must be a valid frame.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { renderProtocolSchema } from "../scripts/generate-protocol";
import { describeCodingCall } from "../src/engine/commands/code/activity";
import { Engine } from "../src/engine/engine";
import { preserveListenPortsForTests } from "../src/net/listen-ports";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import {
  ClientFrame,
  CodingActivity,
  classifyServerFrame,
  KNOWN_CLIENT_FRAMES,
  KNOWN_SERVER_FRAMES,
  ServerFrame,
  WIRE_PROTOCOL,
  WIRE_SCHEMA_PATH,
  wireProtocolSchema,
} from "../src/protocol/wire";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom, tempDbPath, until } from "./helpers";

const ROOT = resolve(import.meta.dir, "..");

function check(schema: TSchema, value: unknown, label: string): void {
  if (Value.Check(schema, value)) return;
  const errors = [...Value.Errors(schema, value)].slice(0, 5).map((e) => JSON.stringify(e));
  throw new Error(
    `${label} does not match the schema:\n${errors.join("\n")}\n${JSON.stringify(value)}`,
  );
}

/** A server frame must be a ServerFrame and match the frame the dispatch rule names. */
function checkServerFrame(frame: Record<string, unknown>, label: string): void {
  check(ServerFrame, frame, label);
  const known = classifyServerFrame(frame);
  if (known !== "Output") check(KNOWN_SERVER_FRAMES[known], frame, `${label} (${known})`);
}

describe("the published schema", () => {
  it("is generated from the source of truth", () => {
    expect(readFileSync(resolve(ROOT, "protocol/marina.wire.v1.schema.json"), "utf8")).toBe(
      renderProtocolSchema(),
    );
  });

  it("names every frame in $defs and refers only to definitions it has", () => {
    const schema = wireProtocolSchema();
    const defs = schema.$defs as Record<string, unknown>;
    for (const name of [...Object.keys(KNOWN_CLIENT_FRAMES), ...Object.keys(KNOWN_SERVER_FRAMES)])
      expect(defs[name]).toBeDefined();
    for (const ref of JSON.stringify(schema).match(/"#\/\$defs\/([A-Za-z]+)"/g) ?? [])
      expect(defs[ref.slice(9, -1)]).toBeDefined();
  });

  it("every example in the protocol guide is a valid frame", () => {
    const guide = readFileSync(resolve(ROOT, "protocol/README.md"), "utf8");
    const blocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] as string);
    expect(blocks.length).toBeGreaterThan(8);
    for (const block of blocks) {
      const frame = JSON.parse(block);
      const valid =
        "type" in frame ? Value.Check(ClientFrame, frame) : Value.Check(ServerFrame, frame);
      if (!valid) throw new Error(`Guide example is not a valid frame:\n${block}`);
      if (!("type" in frame)) checkServerFrame(frame, "guide example");
    }
  });

  it("client frames are closed: a misspelt field is an error", () => {
    expect(Value.Check(ClientFrame, { type: "command", command: "look", request_id: "1" })).toBe(
      true,
    );
    expect(Value.Check(ClientFrame, { type: "command", command: "look", requestId: "1" })).toBe(
      false,
    );
    expect(Value.Check(ClientFrame, { type: "login", name: "a" })).toBe(false);
  });

  it("a coding step the server describes is a valid activity", () => {
    const edit = describeCodingCall("marina_code_edit", {
      path: "a.js",
      oldText: "const b = 2;\n",
      newText: "const b = 3;\n",
    });
    check(CodingActivity, edit, "edit activity");
    check(CodingActivity, describeCodingCall("marina_code_run", { command: "bun test" }), "run");
  });
});

describe("a live server speaks marina.wire.v1", () => {
  let listenPorts: Disposable | undefined;
  beforeAll(() => {
    listenPorts = preserveListenPortsForTests();
  });
  afterAll(() => listenPorts?.[Symbol.dispose]());

  const DB = tempDbPath("test_wire_protocol.db");
  let engine: Engine;
  let server: WebSocketServer;
  let db: MarinaDB;
  let port = 0;
  const sockets: WebSocket[] = [];

  beforeEach(() => {
    db = new MarinaDB(DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start", long: "A room." }));
    server = new WebSocketServer(engine, 0);
    server.start();
    port = server.getPort();
    engine.start();
  });

  afterEach(() => {
    for (const ws of sockets.splice(0)) ws.close();
    engine.stop();
    server.stop();
    db.close();
    cleanupDb(DB);
  });

  function open() {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    sockets.push(ws);
    const frames: Record<string, unknown>[] = [];
    ws.onmessage = (event) => frames.push(JSON.parse(event.data as string));
    const send = (frame: unknown) => {
      check(ClientFrame, frame, "client frame");
      ws.send(JSON.stringify(frame));
    };
    return { ws, frames, send };
  }

  const isResult = (id: string) => (f: Record<string, unknown>) =>
    (f.data as { command_result?: { request_id?: string } })?.command_result?.request_id === id;

  it("welcome, login, a command and its result, a refusal, capabilities, reconnect", async () => {
    const a = open();
    await until(() => a.frames.length > 0);
    check(KNOWN_SERVER_FRAMES.Welcome, a.frames[0], "welcome");
    expect((a.frames[0]!.data as { protocol: string }).protocol).toBe(WIRE_PROTOCOL);

    a.send({ type: "login", name: "Ada", principal: "agent" });
    await until(() => a.frames.some((f) => (f.data as { entityId?: string })?.entityId));
    const session = a.frames.find((f) => (f.data as { entityId?: string })?.entityId)!;
    check(KNOWN_SERVER_FRAMES.Session, session, "session");

    a.send({ type: "command", command: "look", request_id: "look-1" });
    await until(() => a.frames.some(isResult("look-1")));
    const result = a.frames.find(isResult("look-1"))!;
    check(KNOWN_SERVER_FRAMES.CommandResult, result, "command result");
    expect((result.data as { command_result: { ok: boolean } }).command_result.ok).toBe(true);
    const output = a.frames.filter((f) => f.command_request_id === "look-1");
    expect(output.length).toBeGreaterThan(0);
    // The result comes after all of its output.
    expect(a.frames.indexOf(result)).toBeGreaterThan(a.frames.indexOf(output.at(-1)!));

    a.send({ type: "command", command: "task claim 999999", request_id: "bad-1" });
    await until(() => a.frames.some(isResult("bad-1")));
    expect(
      (a.frames.find(isResult("bad-1"))!.data as { command_result: { ok: boolean } }).command_result
        .ok,
    ).toBe(false);

    a.send({ type: "capabilities", request_id: "caps-1" });
    await until(() => a.frames.some((f) => f.tag === "capabilities"));
    const caps = a.frames.find((f) => f.tag === "capabilities")!;
    check(KNOWN_SERVER_FRAMES.CapabilitiesReply, caps, "capabilities");
    const manifest = (caps.data as { capabilities: { commands: unknown[]; key: string } })
      .capabilities;
    expect(manifest.commands.length).toBeGreaterThan(20);
    a.send({ type: "capabilities", request_id: "caps-2", capability_key: manifest.key });
    await until(() => a.frames.filter((f) => f.tag === "capabilities").length === 2);
    expect(
      (
        a.frames.filter((f) => f.tag === "capabilities")[1]!.data as {
          capabilities: { unchanged?: boolean };
        }
      ).capabilities.unchanged,
    ).toBe(true);

    a.send({ type: "ping" });

    // Every frame on the wire is a ServerFrame.
    for (const f of a.frames) checkServerFrame(f, "server frame");

    // Reconnect: a bad token is an auth_error; the real one resumes and rotates the token.
    const token = (session.data as { token: string }).token;
    a.ws.close();
    const b = open();
    await until(() => b.frames.length > 0);
    b.send({ type: "auth", token: "not-a-token" });
    await until(() => b.frames.some((f) => f.kind === "auth_error"));
    check(
      KNOWN_SERVER_FRAMES.AuthError,
      b.frames.find((f) => f.kind === "auth_error"),
      "auth_error",
    );
    b.send({ type: "auth", token });
    await until(() => b.frames.some((f) => (f.data as { entityId?: string })?.entityId));
    const resumed = b.frames.find((f) => (f.data as { entityId?: string })?.entityId)!;
    check(KNOWN_SERVER_FRAMES.Session, resumed, "resumed session");
    expect((resumed.data as { token: string }).token).not.toBe(token);
    for (const f of b.frames) checkServerFrame(f, "server frame");
  });

  it("serves the schema and names it in the connect manifest", async () => {
    const schema = await fetch(`http://localhost:${port}${WIRE_SCHEMA_PATH}`);
    expect(schema.status).toBe(200);
    expect(schema.headers.get("content-type")).toContain("application/schema+json");
    expect(await schema.json()).toEqual(wireProtocolSchema());
    const manifest = (await (await fetch(`http://localhost:${port}/api/connect`)).json()) as {
      protocols: { websocket: { protocol: string; schema: string } };
    };
    expect(manifest.protocols.websocket).toMatchObject({
      protocol: WIRE_PROTOCOL,
      schema: WIRE_SCHEMA_PATH,
    });
  });
});
