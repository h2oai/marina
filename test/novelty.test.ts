// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { createWorldTools, type ToolContext } from "../src/agent/tools";
import { benchmarkExecution } from "../src/engine/benchmark-execution";
import { noveltyCommand } from "../src/engine/commands/novelty";
import { benchmarkNoveltyOpportunities, noveltyOpportunities } from "../src/engine/novelty";
import type { RoomContext } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";

const now = 1_000_000_000;
const input = {
  now,
  participant: "Scout",
  rank: 0,
  goal: "repair coding tests",
  capabilities: [
    { name: "code", help: "coding tests and repair", minRank: 0 },
    { name: "say", help: "talk socially", minRank: 0 },
    { name: "admin", help: "coding tests", minRank: 9 },
  ],
  activity: [],
  outcomes: { outcomes: 0, successes: 0, failures: 0, successRate: 0 },
  unexploredRooms: 10,
};

test("goal relevance ranks exploration without exposing unavailable commands or echoing goal text", () => {
  const result = noveltyOpportunities(input);
  expect(result.findIndex((o) => o.id === "capability:code")).toBeLessThan(
    result.findIndex((o) => o.id === "capability:say"),
  );
  expect(result.some((o) => o.id.includes("admin"))).toBe(false);
  expect(JSON.stringify(result)).not.toContain(input.goal);
  expect(result.every((o) => o.kind !== "explore" || o.next.startsWith("help "))).toBe(true);
});

test("recent failures outrank novelty; stale failures do not dominate indefinitely", () => {
  const activity = [{ key: "code", count: 100, successCount: 10, failCount: 90, lastSeen: now }];
  expect(noveltyOpportunities({ ...input, activity })[0]!.id).toBe("recover:code");
  const stale = noveltyOpportunities({
    ...input,
    activity: [{ ...activity[0]!, lastSeen: now - 8 * 86_400_000 }],
  });
  expect(stale.some((o) => o.id === "recover:code")).toBe(false);
  expect(stale.some((o) => o.id === "capability:code")).toBe(false);
});

test("effective single-participant work can outrank exploration; volume earns no reward", () => {
  const outcomes = { outcomes: 10, successes: 9, failures: 1, successRate: 0.9 };
  const low = noveltyOpportunities({ ...input, outcomes });
  expect(low[0]!.id).toBe("outcome:continue");
  const high = noveltyOpportunities({
    ...input,
    outcomes,
    activity: [{ key: "say", count: 100000, successCount: 100000, failCount: 0, lastSeen: now }],
  });
  expect(high[0]).toEqual(low[0]);
  expect(JSON.stringify(high)).not.toContain("spawn");
});

test("cold start is deterministic and bounded without labelling inactivity a failure", () => {
  const cold = { ...input, goal: "" };
  expect(noveltyOpportunities(cold)).toEqual(noveltyOpportunities(cold));
  expect(noveltyOpportunities(cold).length).toBeLessThanOrEqual(4);
  expect(noveltyOpportunities(cold).some((o) => o.kind === "recover")).toBe(false);
});

test("experiments require same slice/judge evidence, and co-participation is not causal credit", () => {
  const observed = (names: string[]) =>
    benchmarkExecution([
      {
        participants_json: JSON.stringify(
          names.map((agent) => ({ agent, via: "trace", turns: 1 })),
        ),
      },
    ]);
  const team = {
    id: "team",
    benchmark: "fixture",
    score: 1,
    slice: "slice",
    judge: "judge",
    execution: observed(["A", "B"]),
  };
  const solo = { ...team, id: "solo", execution: observed(["A"]) };
  const comparison = benchmarkNoveltyOpportunities([team, solo]).find(
    (o) => o.id === "experiment:team",
  )!;
  expect(comparison.next).toBe("benchmark compare team solo");
  expect(comparison.evidence).toContain("not a causal control");
  for (const changed of [
    { ...solo, judge: "other" },
    { ...solo, slice: "other" },
  ]) {
    expect(
      benchmarkNoveltyOpportunities([team, changed]).find((o) => o.id === "experiment:team")!.next,
    ).toBe("benchmark result team");
  }
  const missing = {
    ...team,
    id: "unknown",
    execution: benchmarkExecution([{ participants_json: null }]),
  };
  expect(benchmarkNoveltyOpportunities([missing])[0]!.kind).toBe("verify");
});

test("command uses full activity history, exposes structured opportunities, and creates no tasks or workers", async () => {
  const f = createTestEngine();
  try {
    const { entityId, connection } = f.login("Scout");
    for (let i = 0; i < 25; i++) {
      f.db.trackActivity("Scout", "command", `common-${i}`);
      f.db.trackActivity("Scout", "command", `common-${i}`);
    }
    f.db.trackActivity("Scout", "command", "rare");
    const command = noveltyCommand({
      db: f.db,
      getEntity: () => f.engine.entities.get(entityId),
      getAllCommands: () => [{ name: "rare" }, { name: "new" }],
      getFocus: () => "new",
    });
    const output: { text: string; metadata?: Record<string, unknown> }[] = [];
    const context: Pick<RoomContext, "send"> = {
      send: (_id, text, _tag, metadata) => {
        output.push({ text, metadata });
      },
    };
    await command.handler(
      context as RoomContext,
      {
        entity: entityId,
        room: f.engine.entities.get(entityId)!.room,
        tokens: ["suggest"],
        args: "suggest",
        raw: "novelty suggest",
      } as Parameters<typeof command.handler>[1],
    );
    expect(output[0]!.text).not.toContain("Inspect rare");
    expect(output[0]!.metadata).toMatchObject({
      novelty: { schema: "marina.novelty.v1", ranking: "heuristic" },
    });
    expect(f.engine.agentRuntime.list()).toHaveLength(0);
    expect(f.db.getActiveClaimsByName("Scout")).toHaveLength(0);
    connection.clear();
    await f.engine.dispatchCommand(entityId, "novelty");
    expect(stripAnsi(connection.allTextJoined())).toContain("not a quality");
  } finally {
    await f.dispose();
  }
});

test("resident novelty tool reaches the same goal-aware and experiment commands", async () => {
  const commands: string[] = [];
  const ctx = {
    client: {
      isConnected: () => true,
      command: async (command: string) => {
        commands.push(command);
        return [{ kind: "system", data: { text: "ok" } }];
      },
    },
    gameState: { handlePerception() {} },
  } as unknown as ToolContext;
  const tool = createWorldTools(ctx).find((t) => t.name === "marina_novelty")!;
  await tool.execute("one", { action: "suggest", query: "repair tests" });
  await tool.execute("two", { action: "experiments", query: "fixture" });
  expect(commands).toEqual(["novelty suggest repair tests", "novelty experiments fixture"]);
});
