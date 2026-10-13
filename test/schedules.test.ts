// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ALERT_AFTER_FAILURES, classify, runDueSchedules } from "../src/schedules/runner";
import {
  decideDue,
  firstRun,
  parseTrigger,
  renderTrigger,
  type Trigger,
} from "../src/schedules/trigger";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi, until } from "./helpers";

const H = 3_600_000;
const T0 = Date.parse("2026-10-14T10:00:00Z");

function trigger(mods: Parameters<typeof parseTrigger>[0]): Trigger {
  const t = parseTrigger(mods);
  if ("error" in t) throw new Error(t.error);
  return t;
}

describe("triggers (pure, wall clock)", () => {
  it("parses one trigger and refuses ambiguity", () => {
    expect(trigger({ every: "6h" })).toEqual({ kind: "every", everyMs: 6 * H });
    expect(trigger({ daily: "02:30" })).toEqual({ kind: "daily", minuteOfDay: 150 });
    expect(trigger({ at: "2026-10-14T13:00Z" })).toEqual({
      kind: "at",
      at: Date.parse("2026-10-14T13:00Z"),
    });
    expect(trigger({ before: "2026-10-14T14:00Z", lead: "1h" })).toEqual({
      kind: "before",
      deadline: Date.parse("2026-10-14T14:00Z"),
      leadMs: H,
    });
    expect(parseTrigger({})).toHaveProperty("error");
    expect(parseTrigger({ every: "1h", daily: "02:00" })).toHaveProperty("error");
    expect(parseTrigger({ daily: "25:00" })).toHaveProperty("error");
    expect(parseTrigger({ at: "tomorrow" })).toHaveProperty("error");
    // A time without a zone is ambiguous, so it is refused.
    expect(parseTrigger({ at: "2026-10-14T13:00" })).toHaveProperty("error");
    expect(parseTrigger({ every: "1h", lead: "1h" })).toHaveProperty("error");
    expect(renderTrigger(trigger({ daily: "02:30" }))).toBe("daily 02:30 UTC");
    expect(renderTrigger(trigger({ before: "2026-10-14T14:00Z", lead: "1h" }))).toBe(
      "1h before 2026-10-14T14:00:00.000Z",
    );
  });

  it("computes first runs; a past one-shot can never run", () => {
    expect(firstRun(trigger({ every: "1h" }), T0)).toBe(T0 + H);
    expect(firstRun(trigger({ daily: "02:30" }), T0)).toBe(Date.parse("2026-10-15T02:30:00Z"));
    expect(firstRun(trigger({ daily: "12:00" }), T0)).toBe(Date.parse("2026-10-14T12:00:00Z"));
    expect(firstRun(trigger({ at: "2026-10-14T09:00Z" }), T0)).toBeNull();
    expect(firstRun(trigger({ before: "2026-10-14T14:00Z", lead: "1h" }), T0)).toBe(
      Date.parse("2026-10-14T13:00Z"),
    );
    // Inside the lead window already: run now.
    expect(firstRun(trigger({ before: "2026-10-14T10:30Z", lead: "1h" }), T0)).toBe(T0);
  });

  it("catches up once after downtime, or skips to the next slot", () => {
    const every = trigger({ every: "1h" });
    expect(decideDue(every, T0, T0 + 1000, "once")).toEqual({ run: true, next: T0 + H });
    // Down for 5.5 hours: one late run, then back on the original cadence.
    expect(decideDue(every, T0, T0 + 5.5 * H, "once")).toEqual({ run: true, next: T0 + 6 * H });
    expect(decideDue(every, T0, T0 + 5.5 * H, "none")).toEqual({ run: false, next: T0 + 6 * H });
    const at = trigger({ at: "2026-10-14T10:00Z" });
    expect(decideDue(at, T0, T0 + 60_000, "none")).toEqual({ run: true, next: null });
    expect(decideDue(at, T0, T0 + 2 * H, "none")).toEqual({ run: false, next: null });
    expect(decideDue(at, T0, T0 + 2 * H, "once")).toEqual({ run: true, next: null });
    // A deadline-relative run never runs after its deadline, whatever the policy.
    const before = trigger({ before: "2026-10-14T11:00Z", lead: "1h" });
    expect(decideDue(before, T0, T0 + 2 * H, "once")).toEqual({ run: false, next: null });
  });

  it("classifies failures by message, never by arguments", () => {
    expect(classify("Rank 4 required for build")).toMatchObject({
      status: "refused",
      errorClass: "rank",
    });
    expect(classify("Unknown command: frob")).toMatchObject({
      status: "failed",
      errorClass: "unknown-command",
    });
    expect(classify("daily spend cap reached")).toMatchObject({ status: "spend-cap" });
    expect(classify("boom")).toMatchObject({ status: "failed", errorClass: "error" });
  });
});

describe("schedule command and runner", () => {
  let fx: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    fx = createTestEngine();
  });
  afterEach(() => fx.dispose());

  const text = (c: { messages: { data?: { text?: unknown } }[] }) =>
    stripAnsi(c.messages.map((m) => String(m.data?.text ?? "")).join("\n"));
  const run = (entityId: EntityId, raw: string) => fx.engine.processCommand(entityId, raw);
  const due = (name: string) => {
    const row = fx.db.listSchedules().find((r) => r.name === name)!;
    fx.db.updateScheduleState(row.id, { nextRunAt: Date.now() - 1, enabled: true });
    return row;
  };
  const settle = (id: number, n = 1) =>
    until(() => fx.db.listScheduleRuns(id, 50).length >= n, { timeoutMs: 5000 });

  it("adds, lists, shows, pauses, resumes and deletes your own schedules", async () => {
    const { connection, entityId } = fx.login("Ada");
    await run(entityId, "schedule add digest every:2h -- look");
    expect(text(connection)).toContain("schedule digest: every 2h; next run");
    await run(entityId, "schedule add digest daily:08:00 -- look");
    expect(text(connection)).toContain('already have a schedule named "digest"');
    await run(entityId, "schedule add fast every:10s -- look");
    expect(text(connection)).toContain("the shortest repeat is 1m");
    await run(entityId, "schedule add late at:2020-01-01T00:00Z -- look");
    expect(text(connection)).toContain("already passed");
    await run(entityId, "schedule add nocmd every:1h");
    expect(text(connection)).toContain("put the command after --");
    connection.messages.length = 0;
    await run(entityId, "schedule");
    expect(text(connection)).toMatch(/digest — on; every 2h; next/);
    await run(entityId, "schedule pause digest");
    await run(entityId, "schedule list");
    expect(text(connection)).toMatch(/digest — paused/);
    await run(entityId, "schedule resume digest");
    expect(text(connection)).toContain("schedule digest: resumed");
    await run(entityId, "schedule rm digest");
    expect(fx.db.listSchedules()).toHaveLength(0);
  });

  it("never shows or touches another owner's schedules", async () => {
    const ada = fx.login("Ada");
    const bob = fx.login("Bob");
    await run(ada.entityId, "schedule add mine every:1h -- look");
    await run(bob.entityId, "schedule show mine");
    expect(text(bob.connection)).toContain('no schedule named "mine"');
    await run(bob.entityId, "schedule delete mine");
    expect(fx.db.listSchedules()).toHaveLength(1);
    await run(bob.entityId, "schedule list");
    expect(text(bob.connection)).toContain("No schedules");
  });

  it("refuses a session capped below the account's stored rank", async () => {
    const { connection, entityId } = fx.login("Ada");
    const user = fx.db.getUserByName("Ada")!;
    fx.db.updateUserRank(user.id, 3);
    await run(entityId, "schedule add digest every:1h -- look");
    expect(text(connection)).toContain("below your account's rank 3");
    expect(fx.db.listSchedules()).toHaveLength(0);
  });

  it("runs as the online owner and records the result", async () => {
    const { connection, entityId } = fx.login("Ada");
    await run(entityId, "schedule add peek every:1h -- look");
    const row = due("peek");
    expect(runDueSchedules(fx.engine)).toBe(1);
    await settle(row.id);
    expect(fx.db.listScheduleRuns(row.id)[0]).toMatchObject({ status: "ok", error_class: null });
    expect(text(connection)).toContain("[schedule peek] look");
    const after = fx.db.getSchedule(row.id)!;
    expect(after.runs).toBe(1);
    expect(after.last_status).toBe("ok");
    // The next run is back on the cadence, in the future.
    expect(after.next_run_at!).toBeGreaterThan(Date.now());
  });

  it("runs headless while a person is offline, without announcing it to the room", async () => {
    const ada = fx.login("Ada");
    const watcher = fx.login("Watcher");
    await run(ada.entityId, "schedule add peek every:1h -- look");
    fx.engine.removeConnection(ada.connection.id, "explicit");
    watcher.connection.messages.length = 0;
    const row = due("peek");
    runDueSchedules(fx.engine);
    await settle(row.id);
    expect(fx.db.listScheduleRuns(row.id)[0]!.status).toBe("ok");
    expect(text(watcher.connection)).not.toMatch(/Ada (connects|disconnects|has (dis)?connected)/i);
  });

  it("records refusals and failures, and alerts after repeated failures", async () => {
    const { entityId } = fx.login("Ada");
    await run(entityId, "schedule add bad every:1h -- frobnicate now");
    await run(entityId, "schedule add build every:1h -- build room x");
    const bad = due("bad");
    runDueSchedules(fx.engine);
    await settle(bad.id);
    expect(fx.db.listScheduleRuns(bad.id)[0]).toMatchObject({
      status: "failed",
      error_class: "unknown-command",
    });
    expect(
      fx.db.listOperationalAlerts("open").some((a) => a.alert_key === `schedule:${bad.id}`),
    ).toBe(false);
    for (let i = 1; i < ALERT_AFTER_FAILURES; i++) {
      due("bad");
      runDueSchedules(fx.engine);
      await settle(bad.id, i + 1);
    }
    expect(
      fx.db.listOperationalAlerts("open").some((a) => a.alert_key === `schedule:${bad.id}`),
    ).toBe(true);
    const build = due("build");
    runDueSchedules(fx.engine);
    await settle(build.id);
    expect(fx.db.listScheduleRuns(build.id)[0]).toMatchObject({
      status: "refused",
      error_class: "rank",
    });
  });

  it("waits on a stopped agent instead of acting for it", async () => {
    const { entityId } = fx.login("Scout");
    await run(entityId, "schedule add peek every:1h -- look");
    fx.engine.removeConnection(fx.engine.getConnectionForEntity(entityId)!.id, "explicit");
    fx.db.saveAgentConfig({ name: "Scout", model: "marina/default", spawnedBy: "Ada" });
    const row = due("peek");
    runDueSchedules(fx.engine);
    await settle(row.id);
    expect(fx.db.listScheduleRuns(row.id)[0]).toMatchObject({ status: "owner-absent" });
    expect(
      fx.db.listOperationalAlerts("open").some((a) => a.alert_key === `schedule:${row.id}`),
    ).toBe(true);
  });

  it("finishes a one-shot after its run and honors max-runs", async () => {
    const { entityId } = fx.login("Ada");
    await run(entityId, "schedule add twice every:1h max-runs:2 -- look");
    const row = due("twice");
    runDueSchedules(fx.engine);
    await settle(row.id);
    expect(fx.db.getSchedule(row.id)!.enabled).toBe(1);
    due("twice");
    runDueSchedules(fx.engine);
    await settle(row.id, 2);
    expect(fx.db.getSchedule(row.id)).toMatchObject({ enabled: 0, next_run_at: null, runs: 2 });
  });
});
