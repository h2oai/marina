// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { PlatformMemoryBackend } from "../src/agent/memory-platform";
import type { MarinaClient } from "../src/sdk/client";
import type { Perception } from "../src/types";

/** Minimal fake MarinaClient that records the last command and replays a
 *  scripted `memory get` response. */
function fakeClient(getResponse: string): { client: MarinaClient; lastCmd: () => string } {
  let last = "";
  const sys = (text: string): Perception[] =>
    [{ kind: "system", timestamp: 0, data: { text } }] as unknown as Perception[];
  const client = {
    command: async (cmd: string) => {
      last = cmd;
      return cmd.startsWith("memory get focus") ? sys(getResponse) : sys("ok");
    },
  } as unknown as MarinaClient;
  return { client, lastCmd: () => last };
}

describe("PlatformMemoryBackend focus persistence", () => {
  it("saveFocus writes the focus JSON via `memory set focus`", async () => {
    const { client, lastCmd } = fakeClient("");
    const mem = new PlatformMemoryBackend(client);
    await mem.saveFocus({ description: "build the relay", startedAt: 42 });
    expect(lastCmd()).toBe('memory set focus {"description":"build the relay","startedAt":42}');
  });

  it("saveFocus(null) clears the key via `memory delete focus`", async () => {
    const { client, lastCmd } = fakeClient("");
    const mem = new PlatformMemoryBackend(client);
    await mem.saveFocus(null);
    expect(lastCmd()).toBe("memory delete focus");
  });

  it("getFocus parses a persisted focus", async () => {
    const { client } = fakeClient('focus (v3): {"description":"build the relay","startedAt":42}');
    const mem = new PlatformMemoryBackend(client);
    expect(await mem.getFocus()).toEqual({ description: "build the relay", startedAt: 42 });
  });

  it("getFocus returns null when no focus is stored", async () => {
    const { client } = fakeClient('No memory entry for "focus".');
    const mem = new PlatformMemoryBackend(client);
    expect(await mem.getFocus()).toBeNull();
  });

  it("getFocus returns null on malformed JSON rather than throwing", async () => {
    const { client } = fakeClient("focus (v1): {not valid json");
    const mem = new PlatformMemoryBackend(client);
    expect(await mem.getFocus()).toBeNull();
  });
});
