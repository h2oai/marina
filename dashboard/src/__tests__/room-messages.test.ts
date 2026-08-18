// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { DashboardEvent } from "../lib/types";
import {
  hasLiveRoomMessage,
  latestRoomMessages,
  ROOM_MESSAGE_LIFETIME_MS,
} from "../unified/lib/room-messages";

const resolve = (id: string) => (id === "e_1" ? "Alice" : id === "e_2" ? "Bob" : undefined);

function evt(
  partial: Partial<DashboardEvent> & { type: string; timestamp: number },
): DashboardEvent {
  return { ...partial } as DashboardEvent;
}

describe("latestRoomMessages", () => {
  const now = 1_000_000;

  it("returns the newest say per room, strip-parsed", () => {
    const events: DashboardEvent[] = [
      evt({
        type: "say",
        entity: "e_1",
        room: "zone/lobby",
        input: "say morning folks",
        timestamp: now - 500,
      }),
      evt({
        type: "say",
        entity: "e_2",
        room: "zone/lobby",
        input: "say morning",
        timestamp: now - 2000,
      }),
      evt({
        type: "say",
        entity: "e_1",
        room: "zone/hall",
        input: "say on my way",
        timestamp: now - 1000,
      }),
    ];
    const out = latestRoomMessages(events, resolve, now);
    expect(out["zone/lobby"]).toEqual({
      kind: "say",
      sender: "Alice",
      body: "morning folks",
      timestamp: now - 500,
    });
    expect(out["zone/hall"]).toEqual({
      kind: "say",
      sender: "Alice",
      body: "on my way",
      timestamp: now - 1000,
    });
  });

  it("captures emotes in addition to says", () => {
    const out = latestRoomMessages(
      [
        evt({
          type: "emote",
          entity: "e_1",
          room: "zone/lobby",
          input: "emote waves",
          timestamp: now - 500,
        }),
      ],
      resolve,
      now,
    );
    expect(out["zone/lobby"]?.kind).toBe("emote");
    expect(out["zone/lobby"]?.body).toBe("waves");
  });

  it("drops cross-room kinds (tell, shout, broadcast)", () => {
    const out = latestRoomMessages(
      [
        evt({
          type: "tell",
          entity: "e_1",
          room: "zone/lobby",
          input: "tell bob hi",
          timestamp: now - 100,
        }),
        evt({
          type: "shout",
          entity: "e_1",
          room: "zone/lobby",
          input: "shout HEY",
          timestamp: now - 200,
        }),
        evt({
          type: "broadcast",
          entity: "e_1",
          room: "zone/lobby",
          input: "broadcast news",
          timestamp: now - 300,
        }),
      ],
      resolve,
      now,
    );
    expect(out).toEqual({});
  });

  it("drops events older than lifetime", () => {
    const out = latestRoomMessages(
      [
        evt({
          type: "say",
          entity: "e_1",
          room: "zone/lobby",
          input: "say ancient",
          timestamp: now - ROOM_MESSAGE_LIFETIME_MS - 10,
        }),
      ],
      resolve,
      now,
    );
    expect(out["zone/lobby"]).toBeUndefined();
  });

  it("stops scanning once events are past the cutoff (newest-first invariant)", () => {
    // Place a fresh event AFTER an expired one; since the feed is
    // newest-first, the expired one comes second, and our scan should
    // still pick up the fresh one at index 0.
    const out = latestRoomMessages(
      [
        evt({
          type: "say",
          entity: "e_1",
          room: "zone/lobby",
          input: "say new",
          timestamp: now - 100,
        }),
        evt({
          type: "say",
          entity: "e_1",
          room: "zone/lobby",
          input: "say ancient",
          timestamp: now - ROOM_MESSAGE_LIFETIME_MS - 100,
        }),
      ],
      resolve,
      now,
    );
    expect(out["zone/lobby"]?.body).toBe("new");
  });

  it("drops say events with no room or no entity", () => {
    const out = latestRoomMessages(
      [
        evt({ type: "say", entity: "e_1", input: "say orphan", timestamp: now - 100 }),
        evt({ type: "say", room: "zone/lobby", input: "say anon", timestamp: now - 100 }),
      ],
      resolve,
      now,
    );
    expect(out).toEqual({});
  });

  it("falls back to raw entity id when resolver returns undefined", () => {
    const out = latestRoomMessages(
      [
        evt({
          type: "say",
          entity: "ghost",
          room: "zone/lobby",
          input: "say from the void",
          timestamp: now - 100,
        }),
      ],
      resolve,
      now,
    );
    expect(out["zone/lobby"]?.sender).toBe("ghost");
  });
});

describe("hasLiveRoomMessage", () => {
  it("is true when any message is within the window", () => {
    expect(
      hasLiveRoomMessage(
        {
          "zone/a": { kind: "say", sender: "x", body: "y", timestamp: 900 },
          "zone/b": { kind: "say", sender: "x", body: "y", timestamp: 100 },
        },
        1000,
      ),
    ).toBe(true);
  });

  it("is false when every message is expired", () => {
    expect(
      hasLiveRoomMessage(
        {
          "zone/a": { kind: "say", sender: "x", body: "y", timestamp: 100 },
        },
        ROOM_MESSAGE_LIFETIME_MS + 1000,
      ),
    ).toBe(false);
  });

  it("is false for empty maps", () => {
    expect(hasLiveRoomMessage({}, 1000)).toBe(false);
  });
});
