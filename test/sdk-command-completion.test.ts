// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { commandCompletion } from "../src/engine/command-response";
import { type ClientOptions, MarinaClient } from "../src/sdk/client";
import type { Perception } from "../src/sdk/protocol";

function fixture(timeout = 1000, options: ClientOptions = {}) {
  const client = new MarinaClient("ws://unused", { commandTimeout: timeout, ...options });
  const internal = client as unknown as {
    session: unknown;
    connected: boolean;
    commandProtocol: string;
    codingTargetSupported: boolean;
    worldCommandSupported: boolean;
    send(data: Record<string, unknown>): void;
    dispatchPerception(p: Perception): void;
    internalHandlers: unknown[];
  };
  internal.session = { entityId: "test", name: "Test", token: "test" };
  internal.connected = true;
  internal.commandProtocol = "correlated";
  const sent: Array<Record<string, unknown>> = [];
  internal.send = (data) => {
    sent.push(data);
  };
  return { client, internal, sent };
}

it("native world grammar is explicit, negotiated, and preserves targeted code requests", async () => {
  const { client, internal, sent } = fixture(1000, { commandGrammar: "world" });
  await expect(client.command("memory get focus")).rejects.toThrow("command was not sent");
  expect(sent).toHaveLength(0);
  internal.worldCommandSupported = true;
  internal.codingTargetSupported = true;
  for (const input of ["memory get focus", "/tell Peer hello", "code status"]) {
    const result = client.command(input);
    expect(sent.at(-1)?.command).toBe(input.startsWith("/") ? input : `/${input}`);
    internal.dispatchPerception(commandCompletion(String(sent.at(-1)?.request_id)));
    await result;
  }
  const targeted = client.command("code status", { codingTarget: { sessionId: "s" } });
  expect(sent.at(-1)?.command).toBe("code status");
  internal.dispatchPerception(commandCompletion(String(sent.at(-1)?.request_id)));
  await targeted;
});

it("human commands retain modal input, while structured memory selects the advertised world grammar", async () => {
  const { client, internal, sent } = fixture();
  internal.worldCommandSupported = true;
  const task = client.command("fix the parser");
  expect(sent.at(-1)?.command).toBe("fix the parser");
  internal.dispatchPerception(commandCompletion(String(sent.at(-1)?.request_id)));
  await task;
  for (const supported of [false, true]) {
    internal.worldCommandSupported = supported;
    const memory = client.memoryService({ operation: "checkpoint", id: "resident" });
    const command = String(sent.at(-1)?.command);
    expect(command.startsWith(supported ? "/memory api " : "memory api ")).toBe(true);
    const request = JSON.parse(command.slice(command.indexOf("{")));
    internal.dispatchPerception({
      kind: "system",
      timestamp: Date.now(),
      data: { memory_service: { request_id: request.request_id, ok: true, result: {} } },
    });
    expect((await memory).ok).toBe(true);
  }
});

it("never silently downgrades targeted commands on an older server", async () => {
  const { client, internal, sent } = fixture();
  for (const protocol of ["legacy", "correlated"]) {
    internal.commandProtocol = protocol;
    await expect(
      client.command("code observe evidence", { codingTarget: { sessionId: "b" } }),
    ).rejects.toThrow("command was not sent");
  }
  expect(sent).toEqual([]);
});

it("sends validated targets with correlation and preserves AbortSignal compatibility", async () => {
  const { client, internal, sent } = fixture();
  internal.codingTargetSupported = true;
  const target = { sessionId: "b", runId: "attempt" };
  const result = client.command("code status", { codingTarget: target });
  target.sessionId = "a";
  expect(sent[0]?.coding_target).toEqual({ sessionId: "b", runId: "attempt" });
  internal.dispatchPerception(commandCompletion(String(sent[0]?.request_id)));
  expect((await result).completion).toBe("confirmed");
  const controller = new AbortController();
  controller.abort();
  await expect(
    client.command("code status", { signal: controller.signal, codingTarget: target }),
  ).rejects.toThrow();
  expect(sent).toHaveLength(1);
});

it("a synchronous completion is observed and protocol frames do not enter world perceptions", async () => {
  const { client, internal } = fixture();
  const observed: Perception[] = [];
  client.onPerception((p) => observed.push(p));
  internal.send = (data) => internal.dispatchPerception(commandCompletion(String(data.request_id)));
  const result = await client.command("noop");
  expect(result).toHaveLength(0);
  expect(result.completion).toBe("confirmed");
  expect(internal.internalHandlers).toHaveLength(0);
  expect(observed).toEqual([]);
});

for (const reason of ["timeout", "disconnect", "abort"] as const) {
  it(`${reason} rejects partial output as an unknown outcome and releases listeners`, async () => {
    const { client, internal, sent } = fixture(reason === "timeout" ? 5 : 1000);
    const controller = new AbortController();
    const result = client.command("slow", controller.signal).catch((error) => error);
    const requestId = String(sent[0]!.request_id);
    internal.dispatchPerception({
      kind: "message",
      timestamp: 1,
      command_request_id: requestId,
      data: { text: "partial" },
    });
    if (reason === "disconnect") client.disconnect();
    if (reason === "abort") controller.abort();
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("outcome is unknown");
    expect(error.message).toContain("Partial command output");
    expect(error.message).toContain("partial");
    expect(error.perceptions.map((p: Perception) => p.data.text)).toEqual(["partial"]);
    expect(internal.internalHandlers).toHaveLength(0);
    internal.dispatchPerception(commandCompletion(requestId));
  });
}
