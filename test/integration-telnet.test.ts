// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Split from integration.test.ts (Telnet Integration describe). Assertions are
// unchanged; the fixed 200 ms sleeps became `until()` polls on the received
// stream, so each step advances as soon as the server has answered.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { TelnetServer } from "../src/net/telnet-server";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom, until } from "./helpers";

const TEST_DB = "test_integration_telnet.db";

/** Connect to the telnet port and accumulate decoded output in `buf.text`. */
async function connectTelnet(port: number): Promise<{
  socket: Awaited<ReturnType<typeof Bun.connect>>;
  buf: { text: string };
}> {
  const buf = { text: "" };
  const decoder = new TextDecoder();
  const socket = await Bun.connect({
    hostname: "localhost",
    port,
    socket: {
      data(_socket, data) {
        buf.text += decoder.decode(data);
      },
      open() {},
      close() {},
      error() {},
    },
  });
  return { socket, buf };
}

describe("Telnet Integration", () => {
  let engine: Engine;
  let telnetServer: TelnetServer;
  let db: MarinaDB;
  const TELNET_PORT = 14000;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
    });

    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Starting Room",
        long: "You are in the starting room.",
      }),
    );

    telnetServer = new TelnetServer(engine, TELNET_PORT);
    telnetServer.start();
    engine.start();
  });

  afterEach(() => {
    engine.stop();
    telnetServer.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should accept telnet connection and show banner", async () => {
    const { socket, buf } = await connectTelnet(TELNET_PORT);
    await until(() => buf.text.includes("Enter your name"), { timeoutMs: 2000 });

    expect(buf.text).toContain("M A R I N A");
    expect(buf.text).toContain("Enter your name");

    socket.end();
    await Bun.sleep(50);
  });

  it("should login and show room on telnet", async () => {
    const { socket, buf } = await connectTelnet(TELNET_PORT);
    await until(() => buf.text.includes("Enter your name"), { timeoutMs: 2000 });
    socket.write("TelnetBot\n");
    await until(() => buf.text.includes("Starting Room"), { timeoutMs: 2000 });

    expect(buf.text).toContain("Welcome");
    expect(buf.text).toContain("Starting Room");

    socket.end();
    await Bun.sleep(50);
  });

  it("should process commands on telnet", async () => {
    const { socket, buf } = await connectTelnet(TELNET_PORT);
    await until(() => buf.text.includes("Enter your name"), { timeoutMs: 2000 });
    socket.write("TelnetCmd\n");
    await until(() => buf.text.includes("Starting Room"), { timeoutMs: 2000 });
    const beforeWho = buf.text.length;
    socket.write("who\n");
    await until(() => buf.text.length > beforeWho, { timeoutMs: 2000 });

    expect(buf.text).toContain("TelnetCmd");

    socket.end();
    await Bun.sleep(50);
  });
});
