// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { assessPerception, createAttentionState } from "../src/agent/attention";
import { SocialAwareness } from "../src/agent/social";
import { Engine } from "../src/engine/engine";
import { type EntityId, type Perception, roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";

let engine: Engine;

beforeEach(() => {
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
});
afterEach(async () => {
  await engine.shutdown();
});

function join(name: string) {
  const conn = new MockConnection(`c-${name}`);
  engine.addConnection(conn);
  const login = engine.login(conn.id, name);
  if ("error" in login) throw new Error(login.error);
  return { conn, id: login.entityId as EntityId };
}

async function heard(conn: MockConnection, tag: string): Promise<Perception> {
  await until(() => conn.messages.some((m) => m.tag === tag));
  return conn.messages.find((m) => m.tag === tag)!;
}

function assess(p: Perception, selfName: string) {
  const social = new SocialAwareness();
  return assessPerception(
    {
      perception: p,
      text: stripAnsi(String(p.data?.text ?? "")),
      selfName,
      events: social.handlePerception(p as Parameters<SocialAwareness["handlePerception"]>[0]),
      scorer: social,
      nudgeMode: "requests",
    },
    { mode: "balanced", threshold: 50 },
    createAttentionState(),
  );
}

describe("room speech addressed by name", () => {
  it("a say that opens with a listener's name is addressed to it, and wakes it now", async () => {
    const speaker = join("Jeff");
    const fern = join("Fern");
    const reed = join("Reed");
    await engine.dispatchCommand(speaker.id, "say Fern, add a subtract function to math.ts");
    const toFern = await heard(fern.conn, "say");
    expect(toFern.data?.message).toBe("Fern, add a subtract function to math.ts");
    expect(assess(toFern, "Fern")).toMatchObject({ wake: "now", shouldRespond: true });
    // The same words reach Reed, who is not addressed: no wake.
    expect(assess(await heard(reed.conn, "say"), "Reed").wake).not.toBe("now");
  });

  it("a shout carries its words for listeners too", async () => {
    const speaker = join("Jeff");
    const fern = join("Fern");
    await engine.dispatchCommand(speaker.id, "shout @Fern the build is red");
    const p = await heard(fern.conn, "shout");
    expect(p.data?.message).toBe("@Fern the build is red");
  });
});
