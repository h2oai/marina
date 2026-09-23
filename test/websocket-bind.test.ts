// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Split from websocket.test.ts (bind-hostname describe). Assertions unchanged.

import { describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import {
  isLoopbackHostname,
  resolveWsBindHostname,
  WebSocketServer,
} from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";
import { tmpDbPath } from "./websocket-helpers";

describe("WebSocket bind hostname (secure-by-default loopback)", () => {
  it("resolveWsBindHostname defaults to loopback (127.0.0.1) when unset", () => {
    expect(resolveWsBindHostname({} as NodeJS.ProcessEnv)).toBe("127.0.0.1");
    expect(resolveWsBindHostname({ WS_HOST: "  " } as NodeJS.ProcessEnv)).toBe("127.0.0.1");
  });

  it("resolveWsBindHostname honors WS_HOST / MARINA_HOST when explicitly set", () => {
    expect(resolveWsBindHostname({ WS_HOST: "127.0.0.1" } as NodeJS.ProcessEnv)).toBe("127.0.0.1");
    expect(resolveWsBindHostname({ MARINA_HOST: "127.0.0.1" } as NodeJS.ProcessEnv)).toBe(
      "127.0.0.1",
    );
    // WS_HOST wins over MARINA_HOST.
    expect(
      resolveWsBindHostname({ WS_HOST: "127.0.0.1", MARINA_HOST: "0.0.0.0" } as NodeJS.ProcessEnv),
    ).toBe("127.0.0.1");
  });

  it("public exposure is an explicit opt-in (WS_HOST=0.0.0.0 or MARINA_PUBLIC=true)", () => {
    expect(resolveWsBindHostname({ WS_HOST: "0.0.0.0" } as NodeJS.ProcessEnv)).toBe("0.0.0.0");
    expect(resolveWsBindHostname({ MARINA_PUBLIC: "true" } as NodeJS.ProcessEnv)).toBe("0.0.0.0");
    // Explicit host wins over MARINA_PUBLIC.
    expect(
      resolveWsBindHostname({ WS_HOST: "127.0.0.1", MARINA_PUBLIC: "true" } as NodeJS.ProcessEnv),
    ).toBe("127.0.0.1");
  });

  it("isLoopbackHostname classifies loopback vs public binds", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("192.168.1.5")).toBe(false);
  });

  it("binds loopback-only by default (no WS_HOST/MARINA_PUBLIC set)", () => {
    const prevHost = process.env.WS_HOST;
    const prevMarinaHost = process.env.MARINA_HOST;
    const prevPublic = process.env.MARINA_PUBLIC;
    delete process.env.WS_HOST;
    delete process.env.MARINA_HOST;
    delete process.env.MARINA_PUBLIC;
    const dbPath = tmpDbPath();
    const db = new MarinaDB(dbPath);
    const engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/lobby"), makeTestRoom({ short: "L", long: "L" }));
    const server = new WebSocketServer(engine, 15398);
    try {
      server.start();
      expect(server.getBoundHostname()).toBe("127.0.0.1");
    } finally {
      server.stop();
      db.close();
      cleanupDb(dbPath);
      if (prevHost === undefined) delete process.env.WS_HOST;
      else process.env.WS_HOST = prevHost;
      if (prevMarinaHost === undefined) delete process.env.MARINA_HOST;
      else process.env.MARINA_HOST = prevMarinaHost;
      if (prevPublic === undefined) delete process.env.MARINA_PUBLIC;
      else process.env.MARINA_PUBLIC = prevPublic;
    }
  });

  it("WS_HOST=127.0.0.1 causes the running server to bind loopback only", () => {
    const prev = process.env.WS_HOST;
    process.env.WS_HOST = "127.0.0.1";
    const dbPath = tmpDbPath();
    const db = new MarinaDB(dbPath);
    const engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/lobby"), makeTestRoom({ short: "L", long: "L" }));
    const server = new WebSocketServer(engine, 15399);
    try {
      server.start();
      expect(server.getBoundHostname()).toBe("127.0.0.1");
    } finally {
      server.stop();
      db.close();
      cleanupDb(dbPath);
      if (prev === undefined) delete process.env.WS_HOST;
      else process.env.WS_HOST = prev;
    }
  });
});
