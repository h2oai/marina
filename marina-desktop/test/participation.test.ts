// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { authenticateRequest, DESKTOP_OPERATOR_ENTITY_ID } from "../../src/net/auth-middleware";
import type { Perception } from "../../src/types";
import { createTestEngine } from "../../test/engine-fixture";
import { until } from "../../test/helpers";
import { scopeProcessState, scopeProperty } from "../../test/process-state";
import config from "../electrobun.config";
import { EngineHost } from "../src/bun/engine-host";
import { loadPreferences } from "../src/bun/preferences";
import { createRpcHandlers } from "../src/bun/rpc-handlers";

function fixture(wsPort?: number) {
  const world = createTestEngine();
  const messages: Perception[] = [];
  const rpc = createRpcHandlers(
    () =>
      ({
        isRunning: true,
        getEngine: () => world.engine,
        getDb: () => world.db,
      }) as unknown as EngineHost,
    {
      getPreferences: () => ({
        ...loadPreferences("/nonexistent-marina-preferences.json"),
        ...(wsPort === undefined ? {} : { wsPort }),
      }),
      setPreferences: () => {},
      switchToRemote: async () => {},
      switchToLocal: async () => {},
    },
    (message) => messages.push(message as Perception),
    () => {},
  );
  const send = (message: unknown) => rpc.gameSend(JSON.stringify(message));
  const login = async () => {
    rpc.gameConnect();
    send({ type: "login", name: "Desktop Resident" });
    await until(() => messages.some((p) => p.data.onboarding !== undefined));
    return messages.find((p) => p.data.token)!;
  };
  return { ...world, rpc, send, messages, login };
}

test("native proxy preserves explicit resident credentials without operator fallback", async () => {
  using _state = scopeProcessState({
    env: { MARINA_DESKTOP_API_TOKEN: "native-test-secret".repeat(3), MARINA_OPEN_API: "false" },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const auth = authenticateRequest(request, f.engine);
      return "error" in auth ? auth.error : Response.json(auth);
    },
  });
  const f = fixture(server.port!);
  try {
    const login = await f.login();
    const request = (headers: Record<string, string>) =>
      f.rpc.proxyApi({ path: "/api/identity", method: "GET", headers });
    const operator = await request({ "X-Marina-Desktop-Token": "untrusted-view-value" });
    expect(JSON.parse(operator.body).entityId).toBe(DESKTOP_OPERATOR_ENTITY_ID);
    const resident = await request({
      Authorization: `Bearer ${login.data.token}`,
      "X-Marina-Desktop-Token": "untrusted-view-value",
    });
    expect(resident.status).toBe(200);
    expect(JSON.parse(resident.body).entityId).toBe(
      f.engine.authenticate(String(login.data.token)),
    );
    expect((await request({ Authorization: "Bearer expired" })).status).toBe(401);
  } finally {
    server.stop(true);
    f.rpc.gameDisconnect();
    await f.dispose();
  }
});

test("desktop release metadata follows its package and selects the Bun main process", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(config.app.version).toBe(pkg.version);
  expect(config.build.mainProcess).toBe("bun");
});

test("desktop shutdown refuses ingress and awaits background writes before closing persistence", async () => {
  const f = createTestEngine();
  const host = new EngineHost({
    dbPath: ":memory:",
    wsPort: 0,
    telnetPort: 0,
    mcpPort: 0,
    tickMs: 60_000,
    startRoom: "test/start",
    roomsDir: "",
  });
  // Inject the socket-free fixture into the native lifecycle owner.
  Object.assign(host, { engine: f.engine, db: f.db, running: true });
  const release = Promise.withResolvers<void>();
  let wrote = false;
  f.engine.trackBackground(
    release.promise.then(() => {
      f.db.listCodingSessions();
      wrote = true;
    }),
  );
  let stopped = false;
  const shutdown = host.shutdown().then(() => {
    stopped = true;
  });
  let secondStopped = false;
  const secondShutdown = host.shutdown().then(() => {
    secondStopped = true;
  });
  try {
    await until(() => !host.isRunning);
    expect(stopped).toBe(false);
    expect(wrote).toBe(false);
    expect(secondStopped).toBe(false);
    release.resolve();
    await Promise.all([shutdown, secondShutdown]);
    expect(wrote).toBe(true);
    expect(host.getEngine()).toBeNull();
    expect(() => f.db.listCodingSessions()).toThrow();
  } finally {
    release.resolve();
    await Promise.all([shutdown, secondShutdown]);
  }
});

test("desktop retries a failed drain even after ingress stopped or startup was incomplete", async () => {
  const f = createTestEngine();
  const host = new EngineHost({
    dbPath: ":memory:",
    wsPort: 0,
    telnetPort: 0,
    mcpPort: 0,
    tickMs: 60_000,
    startRoom: "test/start",
    roomsDir: "",
  });
  Object.assign(host, { engine: f.engine, db: f.db, running: false });
  const originalDrain = f.engine.drainCommands.bind(f.engine);
  let attempts = 0;
  using _patch = scopeProperty(f.engine, "drainCommands", async () => {
    if (++attempts === 1) throw new Error("retryable drain failure");
    await originalDrain();
  });
  try {
    await expect(host.shutdown()).rejects.toThrow("retryable drain failure");
    expect(host.getEngine()).toBe(f.engine);
    expect(() => f.db.listCodingSessions()).not.toThrow();
    await host.shutdown();
    expect(attempts).toBe(2);
    expect(host.getEngine()).toBeNull();
    expect(() => f.db.listCodingSessions()).toThrow();
  } finally {
    await host.shutdown();
  }
});

test("native chat receives current onboarding, capabilities, context and reconnect contracts", async () => {
  const f = fixture();
  try {
    const login = await f.login();
    expect(login.data).toMatchObject({
      name: "DesktopResident",
      commandProtocol: "correlated-v1",
      worldCommandProtocol: "slash-v1",
      codingTargetProtocol: "session-run-v1",
    });
    f.send({ type: "capabilities", request_id: "catalog" });
    const catalog = f.messages.find((p) => p.tag === "capabilities")!.data.capabilities as {
      key: string;
      commands: unknown[];
    };
    expect(catalog.commands.length).toBeGreaterThan(0);
    f.send({ type: "capabilities", request_id: "cached", capability_key: catalog.key });
    expect(f.messages.at(-1)!.data.capabilities).toMatchObject({
      request_id: "cached",
      unchanged: true,
    });
    f.send({ type: "context_preview", request_id: "context", options: { query: "next task" } });
    await until(() => f.messages.some((p) => p.tag === "context_preview"));
    expect(f.messages.find((p) => p.tag === "context_preview")!.data.context_preview).toMatchObject(
      {
        request_id: "context",
      },
    );
    f.rpc.gameDisconnect();
    f.rpc.gameConnect();
    f.messages.length = 0;
    f.send({ type: "auth", token: login.data.token });
    await until(() => f.messages.some((p) => p.data.onboarding !== undefined));
    expect(f.messages.find((p) => p.data.onboarding)!.data.onboarding).toMatchObject({
      resumed: true,
    });
    f.rpc.gameDisconnect();
    f.rpc.gameConnect();
    f.send({ type: "auth", token: "invalid-token" });
    expect(f.messages.at(-1)!.kind).toBe("auth_error");
  } finally {
    f.rpc.gameDisconnect();
    await f.dispose();
  }
});

test("desktop commands retain FIFO correlation and cannot run after disconnect", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  try {
    await f.login();
    f.engine.commands.registerBuiltin({
      name: "hold-native",
      help: "fixture",
      handler: async () => {
        order.push("hold");
        entered.resolve();
        await release.promise;
      },
    });
    f.engine.commands.registerBuiltin({
      name: "after-native",
      help: "fixture",
      handler: () => {
        order.push("after");
      },
    });
    f.send({ type: "command", command: "hold-native", request_id: "first" });
    const drain = f.engine.drainCommands();
    await entered.promise;
    f.send({ type: "command", command: "after-native", request_id: "second" });
    expect(order).toEqual(["hold"]);
    f.rpc.gameDisconnect();
    release.resolve();
    await drain;
    await f.engine.drainCommands();
    expect(order).toEqual(["hold"]);
  } finally {
    release.resolve();
    f.rpc.gameDisconnect();
    await f.dispose();
  }
});

test("desktop coding targets preserve the selected session and reject malformed targets", async () => {
  const f = fixture();
  try {
    const login = await f.login();
    for (const id of ["selected", "target"])
      f.db.createCodingSession({
        id,
        title: id,
        workspaceRoot: `/tmp/${id}`,
        createdBy: String(login.data.name),
      });
    const entity = f.engine.entities.all().find((e) => e.name === login.data.name)!;
    entity.properties.coding_session_id = "selected";
    f.send({
      type: "command",
      command: "code observe target evidence",
      request_id: "targeted",
      coding_target: { sessionId: "target" },
    });
    await f.engine.drainCommands();
    expect(
      f.db.listCodingArtifacts("target").some((a) => a.content_text === "target evidence"),
    ).toBe(true);
    expect(f.db.listCodingArtifacts("selected")).toHaveLength(0);
    expect(entity.properties.coding_session_id).toBe("selected");
    expect(
      f.messages.some(
        (p) => (p.data.command_result as { request_id?: string })?.request_id === "targeted",
      ),
    ).toBe(true);
    f.send({
      type: "command",
      command: "code observe refused",
      request_id: "invalid",
      coding_target: { sessionId: 42 },
    });
    expect(f.messages.at(-1)!.data.command_result).toMatchObject({
      request_id: "invalid",
      ok: false,
    });
    expect(f.db.listCodingArtifacts("target").some((a) => a.content_text === "refused")).toBe(
      false,
    );
  } finally {
    f.rpc.gameDisconnect();
    await f.dispose();
  }
});
