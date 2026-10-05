// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The optional extension gateway-admission hooks. Without a registered check
 * the federation handshake is unchanged; with one, a `Gateway_` login waits for
 * the verdict on the entitlement its `gateway_auth` carried, failing closed.
 * `GATEWAY_SECRET` keeps its meaning and is always checked first.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { GatewayRuntime } from "../src/engine/gateway-runtime";
import {
  extensionGatewayAdmission,
  extensionGatewayProof,
  loadExtensions,
} from "../src/extensions/loader";
import { runGatewayAdmission, WebSocketServer } from "../src/net/websocket-server";
import { MarinaClient } from "../src/sdk/client";
import { roomId } from "../src/types";
import { makeTestRoom } from "./helpers";
import { scopeProcessState } from "./process-state";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function host(): { engine: Engine; url: string } {
  const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  const server = new WebSocketServer(engine, 0);
  server.start();
  cleanups.push(() => server.stop());
  return { engine, url: `ws://localhost:${server.getPort()}/ws` };
}

/** An extension that admits only the proof `{ token: "valid" }`. */
async function admissionExtension(engine: Engine): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "marina-admission-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "marina-plugin.json"),
    JSON.stringify({ name: "admission", version: "1.0.0", apiVersion: 1, entry: "index.mjs" }),
  );
  writeFileSync(
    join(dir, "index.mjs"),
    `export default { activate(ctx) {
      ctx.registerGatewayAdmission(async ({ proof }) =>
        proof && proof.token === "valid" ? { admit: true } : { admit: false, reason: "no licence" });
      ctx.registerGatewayProof(() => ({ token: "valid" }));
    }};`,
  );
  const close = await loadExtensions(engine, [dir]);
  cleanups.push(close);
}

async function gatewayLogin(url: string, auth?: Record<string, unknown>): Promise<string> {
  const client = new MarinaClient(url, {
    autoReconnect: false,
    onOpen: auth
      ? (ws) => ws.send(JSON.stringify({ type: "gateway_auth", version: 1, ...auth }))
      : undefined,
  });
  try {
    await client.connect("Gateway_peer");
    return "connected";
  } catch (error) {
    return (error as Error).message;
  } finally {
    client.disconnect();
  }
}

describe("gateway admission hooks", () => {
  it("leave the handshake unchanged when no extension registers them", async () => {
    using _state = scopeProcessState({ env: { GATEWAY_SECRET: undefined } });
    const { engine, url } = host();
    expect(extensionGatewayAdmission(engine)).toBeUndefined();
    expect(extensionGatewayProof(engine)).toBeUndefined();
    expect(await gatewayLogin(url)).toBe("connected");
    expect(await gatewayLogin(url, { entitlement: { token: "ignored" } })).toBe("connected");
  });

  it("refuse a gateway peer without an admitted proof and admit one with it", async () => {
    using _state = scopeProcessState({ env: { GATEWAY_SECRET: undefined } });
    const { engine, url } = host();
    await admissionExtension(engine);
    expect(await gatewayLogin(url)).toContain("must present an entitlement");
    expect(await gatewayLogin(url, { entitlement: { token: "forged" } })).toContain("no licence");
    expect(await gatewayLogin(url, { entitlement: { token: "valid" } })).toBe("connected");
  });

  it("never lets a proof stand in for GATEWAY_SECRET", async () => {
    using _state = scopeProcessState({ env: { GATEWAY_SECRET: "fixture-secret" } });
    const { engine, url } = host();
    await admissionExtension(engine);
    expect(await gatewayLogin(url, { secret: "wrong", entitlement: { token: "valid" } })).not.toBe(
      "connected",
    );
    expect(
      await gatewayLogin(url, { secret: "fixture-secret", entitlement: { token: "valid" } }),
    ).toBe("connected");
    expect(
      await gatewayLogin(url, { secret: "fixture-secret", entitlement: { token: "forged" } }),
    ).toContain("no licence");
  });

  it("only affects Gateway_ logins", async () => {
    using _state = scopeProcessState({ env: { GATEWAY_SECRET: undefined } });
    const { engine, url } = host();
    await admissionExtension(engine);
    const client = new MarinaClient(url, { autoReconnect: false });
    try {
      await client.connect("Visitor");
    } finally {
      client.disconnect();
    }
  });

  it("fails closed on a throwing, malformed or slow check", async () => {
    const request = { proof: undefined, peerVersion: 1 };
    expect(
      await runGatewayAdmission(() => {
        throw new Error("verifier crashed");
      }, request),
    ).toEqual({ admit: false, reason: "admission check failed" });
    expect(await runGatewayAdmission(() => undefined as never, request)).toMatchObject({
      admit: false,
    });
    expect(await runGatewayAdmission(() => new Promise(() => {}), request, 20)).toEqual({
      admit: false,
      reason: "admission check timed out",
    });
  });

  it("extension registrations are single-owner and removed on shutdown", async () => {
    const { engine } = host();
    await admissionExtension(engine);
    expect(extensionGatewayAdmission(engine)).toBeDefined();
    const close = cleanups.pop() as () => Promise<void>;
    await close();
    expect(extensionGatewayAdmission(engine)).toBeUndefined();
    expect(extensionGatewayProof(engine)).toBeUndefined();
  });

  it("the outbound runtime presents the extension proof to a paid host", async () => {
    using _state = scopeProcessState({ trustProfile: "local", env: { GATEWAY_SECRET: undefined } });
    const { engine, url } = host();
    await admissionExtension(engine);
    const relay = () => {};
    const withProof = new GatewayRuntime({
      localRelay: relay,
      localTellRelay: relay,
      localWorldName: "joiner",
      gatewayProof: () => ({ token: "valid" }),
    });
    const without = new GatewayRuntime({
      localRelay: relay,
      localTellRelay: relay,
      localWorldName: "stranger",
    });
    cleanups.push(async () => {
      await withProof.close();
      await without.close();
    });
    await withProof.addGateway("paid", url);
    await expect(without.addGateway("paid", url)).rejects.toThrow();
  });
});
