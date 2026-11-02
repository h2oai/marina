// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * An operational alert that OPENS leaves the world through `MARINA_OPS_NOTIFY`
 * (`alert.opened`), the way a held action does. A repeat occurrence of an open
 * alert, a resolve, and an `info` row send nothing; a resolved alert that
 * comes back opens again. The listener is the facade's `onOperationalAlert`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { type OpsNotice, setOpsNotifySenderForTests } from "../src/engine/ops-notify";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { makeTestRoom } from "./helpers";

const ENV_KEY = "MARINA_OPS_NOTIFY";
const saved = process.env[ENV_KEY];

const alert = (over: Partial<Parameters<MarinaDB["upsertOperationalAlert"]>[0]> = {}) => ({
  key: "arena-filing:round-1",
  severity: "warning" as const,
  category: "arena",
  title: "round-1: not refreshed near lock",
  detail: "the accepted filing is 3 days old",
  remedy: "run `arena submit round-1 --replace`",
  actionRef: "arena submit round-1 --replace",
  ...over,
});

describe("operational alerts notify the operator when they open", () => {
  let db: MarinaDB;
  let engine: Engine;
  let notices: OpsNotice[];

  beforeEach(() => {
    process.env[ENV_KEY] = "https://example.invalid/hook";
    notices = [];
    setOpsNotifySenderForTests(async (_target, notice) => {
      notices.push(notice);
    });
    db = new MarinaDB(":memory:");
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(async () => {
    setOpsNotifySenderForTests(undefined);
    await engine.shutdown();
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("a new warning sends one `alert.opened`; a repeat occurrence sends nothing", async () => {
    db.upsertOperationalAlert(alert());
    await flush();
    expect(notices.map((n) => n.event)).toEqual(["alert.opened"]);
    expect(notices[0]!.title).toContain("not refreshed near lock");
    expect(notices[0]!.detail).toContain("arena submit round-1 --replace");
    expect(notices[0]!.action).toBe("arena submit round-1 --replace");
    expect(notices[0]!.class).toBe("arena");
    db.upsertOperationalAlert(alert({ detail: "the accepted filing is 4 days old" }));
    await flush();
    expect(notices).toHaveLength(1);
  });

  it("a resolved alert that comes back opens again", async () => {
    const row = db.upsertOperationalAlert(alert());
    db.setOperationalAlertStatus(row.id, "resolved");
    db.upsertOperationalAlert(alert());
    await flush();
    expect(notices.map((n) => n.event)).toEqual(["alert.opened", "alert.opened"]);
  });

  it("an `info` row stays in the inbox only", async () => {
    db.upsertOperationalAlert(alert({ key: "posture:info", severity: "info" }));
    await flush();
    expect(notices).toEqual([]);
  });

  it("the facade reports `opened` to every listener and survives a listener that throws", () => {
    const seen: boolean[] = [];
    const release = db.onOperationalAlert(() => {
      throw new Error("listener bug");
    });
    db.onOperationalAlert((_row, opened) => seen.push(opened));
    db.upsertOperationalAlert(alert({ key: "schedule:7" }));
    db.upsertOperationalAlert(alert({ key: "schedule:7" }));
    expect(seen).toEqual([true, false]);
    release();
  });
});
