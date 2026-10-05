// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The real extension, loaded through the core loader exactly as `MARINA_PLUGINS`
 * would load it, hosting a paid world: a gateway peer needs an entitlement
 * naming this host; a free instance (no hosted_world) registers nothing.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../../../src/engine/engine";
import { GatewayRuntime } from "../../../src/engine/gateway-runtime";
import {
  extensionGatewayAdmission,
  extensionGatewayProof,
  loadExtensions,
} from "../../../src/extensions/loader";
import { issueEntitlement } from "../../../src/learned/entitlement";
import { WebSocketServer } from "../../../src/net/websocket-server";
import { MarinaClient } from "../../../src/sdk/client";
import { roomId } from "../../../src/types";
import { makeTestRoom } from "../../../test/helpers";
import { scopeProcessState } from "../../../test/process-state";
import { publishWorld } from "../src/world";
import { cleanupTemp, publisherKey, publishSpec, tempDir, writeWorldPayload } from "./fixtures";

const EXTENSION_DIR = join(import.meta.dir, "..");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  cleanupTemp();
});

async function host(config: Record<string, unknown>) {
  const dir = tempDir();
  const path = join(dir, "market.json");
  writeFileSync(path, JSON.stringify({ audit_log: "audit.jsonl", ...config }));
  const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  const server = new WebSocketServer(engine, 0);
  server.start();
  cleanups.push(() => server.stop());
  process.env.MARINA_MARKET_CONFIG = path;
  const close = await loadExtensions(engine, [EXTENSION_DIR]);
  cleanups.push(close);
  return { engine, url: `ws://localhost:${server.getPort()}/ws`, dir };
}

async function joinAs(url: string, entitlement?: unknown): Promise<string> {
  const client = new MarinaClient(url, {
    autoReconnect: false,
    onOpen: (ws) => ws.send(JSON.stringify({ type: "gateway_auth", version: 1, entitlement })),
  });
  try {
    await client.connect("Gateway_joiner");
    return "connected";
  } catch (error) {
    return (error as Error).message;
  } finally {
    client.disconnect();
  }
}

describe("hosting a paid world over federation", () => {
  it("a free instance with the extension registers no gateway hook", async () => {
    using _state = scopeProcessState({
      env: { MARINA_MARKET_CONFIG: undefined, GATEWAY_SECRET: undefined },
    });
    const key = publisherKey();
    const { engine } = await host({
      publishers: [{ name: "acme", public_key: key.pinned.publicKey }],
    });
    expect(extensionGatewayAdmission(engine)).toBeUndefined();
  });

  it("admits a peer whose token names this host and refuses the rest", async () => {
    using _state = scopeProcessState({
      trustProfile: "local",
      env: { MARINA_MARKET_CONFIG: undefined, GATEWAY_SECRET: undefined },
    });
    const key = publisherKey();
    const payload = tempDir();
    writeWorldPayload(payload);
    const bundle = tempDir("fed-bundle-");
    const { manifest } = publishWorld(payload, bundle, publishSpec(), key.key);
    const publishers = [{ name: "acme", public_key: key.pinned.publicKey }];
    const { url, dir } = await host({
      publishers,
      hosted_world: { bundle, tiers: ["tier:standard"], audience: "lab-host" },
    });
    const token = (audience: string[]) => ({
      kind: "token",
      token: issueEntitlement(
        {
          artifact_id: manifest.artifact_id,
          version_range: "^1.0.0",
          tiers: ["tier:standard"],
          licensee: { label: "peer-world" },
          audience,
          not_after: new Date(Date.now() + 3_600_000).toISOString(),
        },
        key.key,
      ),
    });
    expect(await joinAs(url)).toContain("Gateway admission refused");
    expect(await joinAs(url, token(["other-host"]))).toContain("audience");
    expect(await joinAs(url, token(["lab-host"]))).toBe("connected");

    // The joining side: the same extension, configured with a proof for gateway "lab".
    writeFileSync(join(dir, "proof.json"), JSON.stringify(token(["lab-host"])), { mode: 0o600 });
    const joinerEngine = (
      await host({ publishers, gateway_proofs: { lab: join(dir, "proof.json") } })
    ).engine;
    const relay = () => {};
    const joiner = new GatewayRuntime({
      localRelay: relay,
      localTellRelay: relay,
      localWorldName: "peer",
      gatewayProof: (gateway) => extensionGatewayProof(joinerEngine)?.(gateway),
    });
    cleanups.push(() => joiner.close());
    await joiner.addGateway("lab", url);
    const stranger = new GatewayRuntime({
      localRelay: relay,
      localTellRelay: relay,
      localWorldName: "x",
    });
    cleanups.push(() => stranger.close());
    await expect(stranger.addGateway("lab", url)).rejects.toThrow();
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8");
    expect(audit).toContain('"action":"gateway.admit"');
    expect(audit).not.toContain("signature");
  });
});
