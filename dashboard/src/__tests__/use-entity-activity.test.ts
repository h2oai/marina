// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import { useEntityActivity } from "../hooks/use-entity-activity";
import type { DashboardEvent } from "../lib/types";

function evt(
  partial: Partial<DashboardEvent> & { type: string; timestamp?: number },
): DashboardEvent {
  return { timestamp: partial.timestamp ?? Date.now(), ...partial } as DashboardEvent;
}

beforeEach(() => {
  useEntityActivity.getState().reset();
});

describe("useEntityActivity — streaming deltas", () => {
  it("initializes a streaming buffer on agent_turn_start", () => {
    useEntityActivity
      .getState()
      .applyEvent(evt({ type: "agent_turn_start", name: "alice", timestamp: 100 }));
    const buf = useEntityActivity.getState().streaming.alice;
    expect(buf).toBeDefined();
    expect(buf?.thought).toBe("");
    expect(buf?.text).toBe("");
    expect(buf?.turnStartedAt).toBe(100);
  });

  it("accumulates thinking deltas during a turn", () => {
    const apply = useEntityActivity.getState().applyEvent;
    apply(evt({ type: "agent_turn_start", name: "alice", timestamp: 100 }));
    apply(evt({ type: "agent_thinking_delta", name: "alice", delta: "I should ", timestamp: 110 }));
    apply(
      evt({
        type: "agent_thinking_delta",
        name: "alice",
        delta: "explore the hall.",
        timestamp: 120,
      }),
    );
    expect(useEntityActivity.getState().streaming.alice?.thought).toBe(
      "I should explore the hall.",
    );
  });

  it("accumulates text deltas separately from thinking", () => {
    const apply = useEntityActivity.getState().applyEvent;
    apply(evt({ type: "agent_turn_start", name: "alice", timestamp: 100 }));
    apply(evt({ type: "agent_thinking_delta", name: "alice", delta: "pondering", timestamp: 105 }));
    apply(evt({ type: "agent_text_delta", name: "alice", delta: "hello ", timestamp: 110 }));
    apply(evt({ type: "agent_text_delta", name: "alice", delta: "world", timestamp: 115 }));
    const buf = useEntityActivity.getState().streaming.alice;
    expect(buf?.thought).toBe("pondering");
    expect(buf?.text).toBe("hello world");
  });

  it("ignores deltas arriving before a turn_start (no buffer)", () => {
    useEntityActivity
      .getState()
      .applyEvent(evt({ type: "agent_text_delta", name: "ghost", delta: "stray", timestamp: 50 }));
    expect(useEntityActivity.getState().streaming.ghost).toBeUndefined();
  });

  it("flushes streaming buffer to recent on agent_turn_end", () => {
    const apply = useEntityActivity.getState().applyEvent;
    apply(evt({ type: "agent_turn_start", name: "alice", timestamp: 100 }));
    apply(
      evt({ type: "agent_thinking_delta", name: "alice", delta: "thinking...", timestamp: 110 }),
    );
    apply(evt({ type: "agent_text_delta", name: "alice", delta: "final answer", timestamp: 120 }));
    apply(evt({ type: "agent_turn_end", name: "alice", timestamp: 130 }));

    const s = useEntityActivity.getState();
    expect(s.streaming.alice).toBeUndefined();
    const recent = s.recent.alice ?? [];
    expect(recent.length).toBe(2);
    // Most recent first — text was pushed last so it ends up first
    expect(recent[0]?.kind).toBe("text");
    expect(recent[0]?.body).toBe("final answer");
    expect(recent[1]?.kind).toBe("thought");
    expect(recent[1]?.body).toBe("thinking...");
  });

  it("flushing an empty turn produces no recent items", () => {
    const apply = useEntityActivity.getState().applyEvent;
    apply(evt({ type: "agent_turn_start", name: "alice", timestamp: 100 }));
    apply(evt({ type: "agent_turn_end", name: "alice", timestamp: 130 }));
    expect(useEntityActivity.getState().recent.alice).toBeUndefined();
    expect(useEntityActivity.getState().streaming.alice).toBeUndefined();
  });
});

describe("useEntityActivity — message events", () => {
  it("captures a `say` with body stripped of verb", () => {
    useEntityActivity.getState().applyEvent(
      evt({
        type: "say",
        entity: "alice",
        input: "say hello everyone",
        room: "zone/lobby",
        timestamp: 100,
      }),
    );
    const item = useEntityActivity.getState().recent.alice?.[0];
    expect(item?.kind).toBe("say");
    expect(item?.body).toBe("hello everyone");
    expect(item?.room).toBe("zone/lobby");
  });

  it("captures a `tell` with recipient and body", () => {
    useEntityActivity.getState().applyEvent(
      evt({
        type: "tell",
        entity: "alice",
        input: "tell bob meet me at the hall",
        timestamp: 100,
      }),
    );
    const item = useEntityActivity.getState().recent.alice?.[0];
    expect(item?.kind).toBe("tell");
    expect(item?.recipient).toBe("bob");
    expect(item?.body).toBe("meet me at the hall");
  });

  it("captures `shout`, `emote`, `broadcast` with body extraction", () => {
    const apply = useEntityActivity.getState().applyEvent;
    apply(evt({ type: "shout", entity: "a", input: "shout HEY", timestamp: 1 }));
    apply(evt({ type: "emote", entity: "a", input: "emote waves", timestamp: 2 }));
    apply(evt({ type: "broadcast", entity: "a", input: "broadcast news", timestamp: 3 }));
    const recent = useEntityActivity.getState().recent.a ?? [];
    expect(recent.map((r) => r.kind)).toEqual(["broadcast", "emote", "shout"]);
    expect(recent.map((r) => r.body)).toEqual(["news", "waves", "HEY"]);
  });

  it("falls back to raw input when verb prefix cannot be parsed", () => {
    useEntityActivity
      .getState()
      .applyEvent(evt({ type: "say", entity: "alice", input: "just a string", timestamp: 100 }));
    const item = useEntityActivity.getState().recent.alice?.[0];
    // "just a string" doesn't match /^say\s+/ so the fallback returns raw input
    expect(item?.body).toBe("just a string");
  });

  it("drops message events with no entity or empty body", () => {
    const apply = useEntityActivity.getState().applyEvent;
    apply(evt({ type: "say", input: "say hi", timestamp: 100 })); // no entity
    apply(evt({ type: "say", entity: "alice", input: "say", timestamp: 101 })); // empty after strip
    expect(useEntityActivity.getState().recent.alice).toBeUndefined();
  });
});

describe("useEntityActivity — capping and clearing", () => {
  it("caps recent items per entity at 20 (newest first)", () => {
    const apply = useEntityActivity.getState().applyEvent;
    for (let i = 0; i < 25; i++) {
      apply(
        evt({
          type: "say",
          entity: "alice",
          input: `say msg${i}`,
          timestamp: 1000 + i,
        }),
      );
    }
    const recent = useEntityActivity.getState().recent.alice ?? [];
    expect(recent.length).toBe(20);
    expect(recent[0]?.body).toBe("msg24");
    expect(recent[19]?.body).toBe("msg5");
  });

  it("clearEntity drops streaming + recent for that entity only", () => {
    const apply = useEntityActivity.getState().applyEvent;
    apply(evt({ type: "agent_turn_start", name: "alice", timestamp: 100 }));
    apply(evt({ type: "agent_thinking_delta", name: "alice", delta: "x", timestamp: 101 }));
    apply(evt({ type: "say", entity: "bob", input: "say hi", timestamp: 102 }));

    useEntityActivity.getState().clearEntity("alice");
    const s = useEntityActivity.getState();
    expect(s.streaming.alice).toBeUndefined();
    expect(s.recent.alice).toBeUndefined();
    expect(s.recent.bob?.length).toBe(1);
  });

  it("agent_stop clears streaming + recent for that agent (leak prevention)", () => {
    const apply = useEntityActivity.getState().applyEvent;
    apply(evt({ type: "agent_turn_start", name: "ephemeral", timestamp: 100 }));
    apply(evt({ type: "agent_thinking_delta", name: "ephemeral", delta: "x", timestamp: 101 }));
    apply(evt({ type: "say", entity: "ephemeral", input: "say hi", timestamp: 102 }));
    apply(evt({ type: "say", entity: "survivor", input: "say hi", timestamp: 103 }));
    // Long-lived agent's buffer is independent
    apply(evt({ type: "agent_stop", name: "ephemeral", timestamp: 200 }));

    const s = useEntityActivity.getState();
    expect(s.streaming.ephemeral).toBeUndefined();
    expect(s.recent.ephemeral).toBeUndefined();
    expect(s.recent.survivor?.length).toBe(1);
  });
});
