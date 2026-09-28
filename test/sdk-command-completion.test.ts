// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { commandCompletion } from "../src/engine/command-response";
import { MarinaClient } from "../src/sdk/client";
import type { Perception } from "../src/sdk/protocol";

function fixture(timeout = 1000) {
  const client = new MarinaClient("ws://unused", { commandTimeout: timeout });
  const internal = client as unknown as {
    session: unknown;
    connected: boolean;
    commandProtocol: string;
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
