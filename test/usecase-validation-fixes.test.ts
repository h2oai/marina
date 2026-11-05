// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A bounty stays `open` while people work it, so `task list` must show its live
 * claims: a team mid-work otherwise reads as if nobody had started.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

describe("task list shows who is working an open task", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let state: DisposableStack;
  beforeEach(() => {
    state = scopeProcessState({ rateLimitBypass: true });
    fixture = createTestEngine();
  });
  afterEach(async () => {
    try {
      await fixture.dispose();
    } finally {
      state.dispose();
    }
  });

  test("names the creator and each active claim", async () => {
    const lead = fixture.login("Lead");
    const analyst = fixture.login("Analyst");
    const tasks = fixture.engine.taskManager!;
    const worked = tasks.create({
      title: "Evaluate market",
      creatorId: lead.entityId,
      creatorName: "Lead",
      validationMode: "bounty",
    });
    tasks.create({ title: "Untouched", creatorId: lead.entityId, creatorName: "Lead" });
    tasks.claim(worked.id, analyst.entityId, "Analyst");

    const before = lead.connection.messages.length;
    await fixture.engine.processCommand(lead.entityId, "task list");
    const text = lead.connection.messages
      .slice(before)
      .map((p) => stripAnsi(String((p.data as { text?: string }).text ?? "")))
      .join("\n");
    const line = (title: string) => text.split("\n").find((l) => l.includes(title)) ?? "";
    expect(line("Evaluate market")).toContain("— by Lead · Analyst claimed");
    expect(line("Untouched")).toContain("— by Lead");
    expect(line("Untouched")).not.toContain("claimed");
  });
});

describe("a resident is reached by any spelling of its name", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let state: DisposableStack;
  beforeEach(() => {
    state = scopeProcessState({ rateLimitBypass: true });
    fixture = createTestEngine();
  });
  afterEach(async () => {
    try {
      await fixture.dispose();
    } finally {
      state.dispose();
    }
  });

  test("the config spelling `agent list` shows finds the sanitized live entity", async () => {
    // A seeded agent configured as "Diligence-Lead" logs in as "DiligenceLead".
    const lead = fixture.login("DiligenceLead");
    const sender = fixture.login("Jeff");
    expect(fixture.engine.findEntityGlobal("Diligence-Lead")?.id).toBe(lead.entityId);
    expect(fixture.engine.findEntityGlobal("diligence-lead")?.id).toBe(lead.entityId);
    const before = sender.connection.messages.length;
    await fixture.engine.processCommand(sender.entityId, "tell Diligence-Lead start with the 10-K");
    const reply = sender.connection.messages
      .slice(before)
      .map((p) => stripAnsi(String((p.data as { text?: string }).text ?? "")))
      .join("\n");
    expect(reply).toContain("You tell DiligenceLead");
  });

  test("an exact name still beats a spelling match", () => {
    const exact = fixture.login("Red_Actor");
    fixture.login("RedActor");
    expect(fixture.engine.findEntityGlobal("Red_Actor")?.id).toBe(exact.entityId);
  });
});

describe("spawn budget says how long it lasts", () => {
  test("a call budget is shown as minutes of active work", async () => {
    const { budgetDuration } = await import("../src/engine/commands/agent");
    expect(budgetDuration(60)).toBe("about 2-6 min");
    expect(budgetDuration(300)).toBe("about 10-30 min");
    expect(budgetDuration(3000)).toBe("about 2-5 h");
    expect(budgetDuration(5)).toBe("about 1 min");
    expect(budgetDuration(1000)).toBe("about 33 min-2 h");
  });
});

describe("an owner logging in takes over from their scheduled run", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let state: DisposableStack;
  beforeEach(() => {
    state = scopeProcessState({ rateLimitBypass: true });
    fixture = createTestEngine();
  });
  afterEach(async () => {
    try {
      await fixture.dispose();
    } finally {
      state.dispose();
    }
  });

  test("the quiet run's connection yields, and its teardown leaves the owner connected", async () => {
    const first = fixture.login("Owner");
    fixture.engine.removeConnection(first.connection.id);
    // A scheduled run attaches quietly while the owner is away.
    const sent: unknown[] = [];
    const quiet = {
      id: "sched_test",
      protocol: "websocket" as const,
      entity: null,
      connectedAt: Date.now(),
      quiet: true,
      send: (p: unknown) => sent.push(p),
      close: () => fixture.engine.removeConnection("sched_test"),
    };
    fixture.engine.addConnection(quiet);
    const attached = fixture.engine.attachScheduled("sched_test", "Owner");
    expect("entityId" in attached).toBe(true);

    // The owner comes back mid-run: the login succeeds on the same entity.
    const back = fixture.login("Owner");
    expect(back.entityId).toBe(first.entityId);
    expect(fixture.engine.getConnectionForEntity(back.entityId)?.id).toBe(back.connection.id);

    // The run ends and tears its connection down: the owner stays connected.
    fixture.engine.removeConnection("sched_test");
    expect(fixture.engine.getConnectionForEntity(back.entityId)?.id).toBe(back.connection.id);
  });

  test("a second ordinary connection is still refused", () => {
    fixture.login("Owner");
    expect(() => fixture.login("Owner")).toThrow("already in use");
  });
});

describe("benchmark list flags sets every model aces", () => {
  test("two models at ≥95% on ≥10 answered items mark a set saturated here", async () => {
    const { saturation } = await import("../src/engine/commands/benchmark");
    const run = (model: string, score: number, answered = 20) =>
      ({ score, answered, config_json: JSON.stringify({ model }) }) as never;
    const db = (rows: never[]) => ({ leaderboardBenchmark: () => rows });
    expect(saturation(db([run("a", 1), run("b", 1)]), "math")).toBe(
      "saturated (2+ models ≥95% here)",
    );
    // One model, a low score, or too few items does not count.
    expect(saturation(db([run("a", 1), run("a", 0.98)]), "math")).toBeUndefined();
    expect(saturation(db([run("a", 1), run("b", 0.8)]), "math")).toBeUndefined();
    expect(saturation(db([run("a", 1, 5), run("b", 1, 5)]), "math")).toBeUndefined();
    // Cited reference scores alone can saturate a set (aime-2025 has four ≥ 95 %).
    expect(saturation(db([]), "aime-2025")).toBe("saturated (reference scores ≥95%)");
  });
});
