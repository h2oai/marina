// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The self-improvement work finder: recurring warnings and errors in this
// server's own log become, once each, tasks to fix Marina's source.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  finderState,
  MAX_FILED_PER_DAY,
  MIN_OCCURRENCES,
  messageTemplate,
  recurringSignals,
  runSelfImproveFinder,
} from "../src/engine/self-improve";
import { MarinaDB } from "../src/persistence/database";

const NOW = Date.UTC(2026, 10, 12, 12);

function log(
  db: MarinaDB,
  n: number,
  level: "warn" | "error",
  category: string,
  message: (i: number) => string,
  data?: Record<string, unknown>,
) {
  for (let i = 0; i < n; i++)
    db.appendStructuredLog({
      level,
      category,
      message: message(i),
      ...(data ? { data } : {}),
      timestamp: NOW - 1000 * (i + 1),
    });
}

describe("self-improvement work finder", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
  });
  afterEach(() => db.close());

  it("masks names, numbers and quoted values so one bug is one signature", () => {
    expect(messageTemplate("Tool marina_command failed for Builder")).toBe(
      "Tool marina_command failed for <name>",
    );
    expect(messageTemplate('Failed to respawn agent "Critic"')).toBe(
      "Failed to respawn agent <value>",
    );
    expect(messageTemplate("prompt exceeded 120000ms — aborted")).toBe(
      "prompt exceeded <n> — aborted",
    );
  });

  it("groups by signature across residents and keeps only what recurs", () => {
    const names = ["Builder", "Critic", "Host"];
    log(db, 30, "warn", "agent-tool", (i) => `Tool marina_command failed for ${names[i % 3]}`, {
      error: "boom",
    });
    log(db, MIN_OCCURRENCES - 1, "warn", "memory", () => "rare thing");
    log(db, 25, "info" as "warn", "main", () => "not a problem");
    const signals = recurringSignals(db, NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      level: "warn",
      category: "agent-tool",
      template: "Tool marina_command failed for <name>",
      count: 30,
      sample: "boom",
    });
  });

  it("observes by default and files nothing", () => {
    log(db, 30, "error", "hygiene", () => "Memory hygiene failed for entity");
    const report = runSelfImproveFinder(db, { id: "e_1", name: "system" }, {}, NOW);
    expect(report).toMatchObject({ mode: "observe", candidates: 1, filed: [] });
    expect(finderState(db).candidates[0]?.category).toBe("hygiene");
    expect(db.listTasks?.({ limit: 10 }) ?? []).toHaveLength(0);
  });

  it("files each signature once, at most a few a day, with how to fix it", () => {
    for (let k = 0; k < MAX_FILED_PER_DAY + 2; k++)
      log(db, 30 + k, "error", `cat${k}`, () => `failure kind ${String.fromCharCode(97 + k)}`);
    const env = { MARINA_SELF_IMPROVE: "on" };
    const first = runSelfImproveFinder(db, { id: "e_1", name: "system" }, env, NOW);
    expect(first.filed).toHaveLength(MAX_FILED_PER_DAY);
    const task = db.getTask(first.filed[0]!)!;
    expect(task.title).toContain("Fix recurring error");
    expect(task.description).toContain("code trial");
    expect(task.description).toContain("code ship");
    // Same day: the daily limit holds; nothing is filed twice.
    expect(runSelfImproveFinder(db, { id: "e_1", name: "system" }, env, NOW).filed).toEqual([]);
    // Next day: the rest are filed, the first ones are not filed again.
    const next = runSelfImproveFinder(
      db,
      { id: "e_1", name: "system" },
      env,
      NOW + 86_400_000 - 60_000,
    );
    expect(next.filed.length).toBeLessThanOrEqual(2);
    const all = [...first.filed, ...next.filed];
    expect(new Set(all).size).toBe(all.length);
  });

  it("is silent when off", () => {
    log(db, 30, "error", "hygiene", () => "Memory hygiene failed for entity");
    expect(
      runSelfImproveFinder(db, { id: "e_1", name: "system" }, { MARINA_SELF_IMPROVE: "off" }, NOW),
    ).toEqual({ mode: "off", candidates: 0, filed: [] });
  });
});
