// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { type ClientOptions, MarinaClient } from "../src/sdk/client";
import { until } from "./helpers";

function fixture(options: ClientOptions = {}) {
  const sent: Record<string, unknown>[] = [];
  let protocol: string | undefined;
  let deliver: (text: string) => void = () => {
    throw new Error("not connected");
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw));
        deliver = (text) =>
          ws.send(JSON.stringify({ kind: "message", timestamp: 1, data: { text } }));
        if (message.type === "login" || message.type === "auth") {
          ws.send(
            JSON.stringify({
              kind: "system",
              timestamp: 1,
              data: {
                entityId: "legacy-user",
                name: "Legacy",
                token: "session",
                commandProtocol: protocol,
              },
            }),
          );
        } else if (message.type === "command") sent.push(message);
      },
    },
  });
  const client = new MarinaClient(`ws://127.0.0.1:${server.port}`, {
    autoReconnect: false,
    pingInterval: 0,
    commandTimeout: 1000,
    commandDrainTimeout: 5,
    ...options,
  });
  return {
    client,
    sent,
    deliver(text: string) {
      deliver(text);
    },
    protocol(value: string) {
      protocol = value;
    },
    [Symbol.dispose]() {
      client.disconnect();
      server.stop(true);
    },
  };
}

it("legacy login negotiates compatibility and serializes commands with explicit unconfirmed results", async () => {
  using f = fixture();
  await f.client.connect("Legacy");
  expect(f.client.getCommandProtocol()).toBe("legacy");
  const first = f.client.command("look");
  const second = f.client.command("who");
  await until(() => f.sent.length === 1);
  expect(f.sent[0]).toEqual({ type: "command", command: "look" });
  f.deliver("room output");
  const firstResult = await first;
  expect(firstResult.completion).toBe("unconfirmed");
  expect(firstResult.map((p) => p.data.text)).toEqual(["room output"]);
  await until(() => f.sent.length === 2);
  f.deliver("occupants");
  const secondResult = await second;
  expect(secondResult.completion).toBe("unconfirmed");
  expect(secondResult.map((p) => p.data.text)).toEqual(["occupants"]);
  expect(f.sent).toHaveLength(2);
});

it("strict clients reject a legacy mutation before sending, then renegotiate on reconnect", async () => {
  using f = fixture({ commandMode: "correlated" });
  await f.client.connect("Legacy");
  expect(await f.client.command("note do this once").catch((e) => e.message)).toContain(
    "command was not sent",
  );
  expect(f.sent).toHaveLength(0);
  f.client.disconnect();
  f.protocol("correlated-v1");
  await f.client.reconnect("session");
  expect(f.client.getCommandProtocol()).toBe("correlated");
});

it("legacy cancellation never replays a mutation or sends queued work after an unknown outcome", async () => {
  using f = fixture();
  await f.client.connect("Legacy");
  const active = new AbortController();
  const queued = new AbortController();
  const first = f.client.command("note first", active.signal).catch((e) => e);
  const second = f.client.command("note cancelled", queued.signal).catch((e) => e);
  const third = f.client.command("note later").catch((e) => e);
  await until(() => f.sent.length === 1);
  queued.abort();
  expect((await second).message).toContain("command was not sent");
  active.abort();
  expect((await first).message).toContain("outcome is unknown");
  expect((await third).message).toContain("was not sent");
  expect(f.sent).toHaveLength(1);
});

it("legacy silence times out as unknown instead of reporting success", async () => {
  using f = fixture({ commandTimeout: 20 });
  await f.client.connect("Legacy");
  const result = await f.client.command("silent-mutation").catch((e) => e);
  expect(result.message).toContain("outcome is unknown");
  expect(f.sent).toHaveLength(1);
});
