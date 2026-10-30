// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom, tempDbPath } from "./helpers";
import { scopeProcessState } from "./process-state";

/**
 * `marina connect -c <cmd>` lingers until output has been quiet for 2.5 s, capped
 * by `--wait`. The quiet rule starts once the command has produced output — and
 * the direct reply IS that output. A snapshot taken after the reply never saw it
 * produce anything, so every synchronous command waited the whole cap (20 s).
 */
describe("connect one-shot and pipe modes exit soon after the reply", () => {
  const CAP_S = 6;
  let dbPath: string;
  let db: MarinaDB;
  let engine: Engine;
  let wsServer: WebSocketServer;
  let port: number;
  let processState: DisposableStack;
  beforeEach(() => {
    processState = scopeProcessState();
    dbPath = tempDbPath();
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/lobby"), makeTestRoom({ short: "The Lobby" }));
    wsServer = new WebSocketServer(engine, 0);
    wsServer.start();
    port = wsServer.getPort();
    engine.start();
  });
  afterEach(async () => {
    engine.stop();
    await wsServer.stop();
    await engine.drainCommands();
    db.close();
    cleanupDb(dbPath);
    processState.dispose();
  });

  const connect = async (name: string, args: string[], stdin?: string) => {
    const started = performance.now();
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../scripts/connect.ts"),
        name,
        "--port",
        String(port),
        "--wait",
        String(CAP_S),
        ...args,
      ],
      { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const input = child.stdin;
    if (stdin !== undefined && input) {
      input.write(stdin);
      input.end();
    }
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { code, out, seconds: (performance.now() - started) / 1000 };
  };

  it("one-shot: a synchronous command returns ~2.5 s after its reply, not at the cap", async () => {
    const run = await connect("oneshot", ["-c", "look"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("The Lobby");
    expect(run.seconds).toBeLessThan(CAP_S - 1);
  }, 15_000);

  it("pipe: the same rule after the last line", async () => {
    const run = await connect("piped", [], "look\n");
    expect(run.code).toBe(0);
    expect(run.out).toContain("The Lobby");
    expect(run.seconds).toBeLessThan(CAP_S - 1);
  }, 15_000);
});
