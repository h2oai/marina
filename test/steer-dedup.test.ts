// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A high-priority perception must reach the model exactly once. pi-agent-core
 * drains `steer()`ed messages into the running prompt — or, when idle, into
 * the NEXT `prompt()` — so steering AND buffering the same message paid for it
 * twice. Idle → buffer only (the wake already makes delivery immediate);
 * mid-run → steer only, and the buffered copy is skipped by the next prompt.
 */

import { describe, expect, it } from "bun:test";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import type { Perception } from "../src/types";

type Internals = {
  autonomousMode: boolean;
  client: { emit(event: "perception", p: Perception): void };
  agent: {
    steer: (message: { role: string; content: unknown }) => void;
    _state: { isStreaming: boolean };
  };
  pendingPerceptions: Array<{ id?: number; text: string; priority: number }>;
  deliveredViaSteer: Set<number>;
  buildContinuationPrompt(): Promise<string>;
};

function makeAdapter(name: string, streaming: boolean) {
  const adapter = new LeanAgentAdapter({ name }, "ws://127.0.0.1:3300", null);
  const i = adapter as unknown as Internals;
  i.autonomousMode = true;
  const steered: Array<{ role: string; content: unknown }> = [];
  i.agent.steer = (message) => steered.push(message);
  i.agent._state.isStreaming = streaming;
  return { adapter, i, steered };
}

/** A direct tell to `target` — `player_tells` scores 100 (≥ 80 = interrupt class). */
function tellPerception(target: string, message: string): Perception {
  return {
    kind: "message",
    timestamp: Date.now(),
    data: { from: "Boss", to: target, message },
  };
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("steered perception delivery", () => {
  it("idle agent: buffers only — no steer call, appears once in the next prompt", async () => {
    const { i, steered } = makeAdapter("steer-idle", false);
    i.client.emit("perception", tellPerception("steer-idle", "what is 17*3? tag-IDLE-9f2"));

    expect(steered).toHaveLength(0);
    expect(i.pendingPerceptions).toHaveLength(1);
    expect(i.pendingPerceptions[0]!.priority).toBeGreaterThanOrEqual(80);
    expect(i.deliveredViaSteer.size).toBe(0);

    const prompt = await i.buildContinuationPrompt();
    expect(count(prompt, "tag-IDLE-9f2")).toBe(1);
    expect(prompt).toContain("[!] [message]");
  });

  it("mid-run agent: one steer call, absent from the next prompt", async () => {
    const { i, steered } = makeAdapter("steer-busy", true);
    i.client.emit("perception", tellPerception("steer-busy", "what is 17*3? tag-BUSY-7c1"));

    expect(steered).toHaveLength(1);
    expect(String((steered[0] as { content: string }).content)).toContain("tag-BUSY-7c1");
    expect(steered[0]!.role).toBe("user");
    // Buffered (so wake / actionable bookkeeping still sees it) but marked delivered.
    expect(i.pendingPerceptions).toHaveLength(1);
    const id = i.pendingPerceptions[0]!.id;
    expect(typeof id).toBe("number");
    expect(i.deliveredViaSteer.has(id as number)).toBe(true);

    // A second, ordinary perception in the same batch still renders.
    i.agent._state.isStreaming = false;
    i.client.emit("perception", {
      kind: "broadcast",
      timestamp: Date.now(),
      data: { from: "Town crier", message: "the market opens at noon tag-AMBIENT-3e4" },
    });

    const prompt = await i.buildContinuationPrompt();
    expect(count(prompt, "tag-BUSY-7c1")).toBe(0);
    expect(count(prompt, "tag-AMBIENT-3e4")).toBe(1);
    // Consumed: the id is released once the prompt has skipped it.
    expect(i.deliveredViaSteer.size).toBe(0);
    expect(steered).toHaveLength(1);
  });

  it("assigns monotonic ids so the delivered set keys distinct perceptions", () => {
    const { i } = makeAdapter("steer-ids", false);
    i.client.emit("perception", tellPerception("steer-ids", "first"));
    i.client.emit("perception", tellPerception("steer-ids", "second"));
    const ids = i.pendingPerceptions.map((p) => p.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeLessThan(ids[1] as number);
  });
});
