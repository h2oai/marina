// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The loop's defaults and what readiness says about it:
 *   - `MARINA_OUTCOME_JUDGE` unset is `on` with a model provider, `off` without;
 *   - `learning-loop` shows a backlog and a loop that never changed a default;
 *   - `gate-sentinels` is critical only when an AGENT holds a sentinel grant;
 *   - an operator-required refusal tells a declared agent client why.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetChallengesForTests } from "../src/engine/challenges";
import { syncOperationalAlerts } from "../src/engine/commands/ops";
import { Engine } from "../src/engine/engine";
import type { ReadinessReport } from "../src/engine/readiness";
import {
  gateSentinelsCheck,
  LEARNING_LOOP_STALE_MS,
  learningLoopCheck,
} from "../src/engine/readiness-learning";
import { grant } from "../src/engine/safety-gates";
import { judgeOpenResolutions, judgeResolutionMode } from "../src/outcomes/judge-resolution";
import { recordTaskVerdict } from "../src/outcomes/live";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const PROVIDER = { OPENROUTER_API_KEY: ["fake", "provider"].join("-") } as NodeJS.ProcessEnv;
const NONE = {} as NodeJS.ProcessEnv;

describe("MARINA_OUTCOME_JUDGE default", () => {
  it("is on with a model provider and off without one; an explicit value wins", () => {
    expect(judgeResolutionMode(PROVIDER)).toBe("on");
    expect(judgeResolutionMode(NONE)).toBe("off");
    expect(judgeResolutionMode({ ...PROVIDER, MARINA_OUTCOME_JUDGE: "off" })).toBe("off");
    expect(judgeResolutionMode({ ...PROVIDER, MARINA_OUTCOME_JUDGE: "observe" })).toBe("observe");
    expect(judgeResolutionMode({ ...NONE, MARINA_OUTCOME_JUDGE: "on" })).toBe("on");
    expect(judgeResolutionMode({ ...PROVIDER, MARINA_OUTCOME_JUDGE: "junk" })).toBe("off");
    expect(judgeResolutionMode({ LLAMA_BASE_URL: "http://127.0.0.1:8080" })).toBe("on");
  });

  it("with no provider the judge does nothing and never throws", async () => {
    const db = new MarinaDB(":memory:");
    try {
      const report = await judgeOpenResolutions(db, { env: NONE });
      expect(report).toMatchObject({ mode: "off", judged: 0, settled: 0 });
    } finally {
      db.close();
    }
  });
});

describe("readiness: learning-loop", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    db.saveAgentConfig({ name: "Roamer", model: "vendor/m", role: "coder", spawnedBy: "system" });
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
  });

  it("an empty world is ok with a provider, and honest (optional, off) without one", () => {
    const ok = learningLoopCheck(db, PROVIDER);
    expect(ok.status).toBe("ok");
    expect(ok.detail).toContain("no outcome recorded yet");
    expect(ok.detail).toContain("promotions ever filed 0");
    expect(ok.detail).toContain("outcome judge on");
    const none = learningLoopCheck(db, NONE);
    expect(none).toMatchObject({ status: "off", optional: true });
    expect(none.detail).toContain("no model provider");
    expect(none.detail).toContain("outcome judge off");
  });

  it("a backlog shows its count and age, and degrades past 14 days", () => {
    recordTaskVerdict(db, { taskId: 1, claimant: "Roamer", approved: true, at: 1 });
    const fresh = learningLoopCheck(db, PROVIDER);
    expect(fresh.status).toBe("degraded");
    expect(fresh.detail).toContain("no default has ever changed");
    expect(fresh.detail).toMatch(/undelivered [1-9]/);
    expect(fresh.detail).not.toContain("waited over");
    const later = learningLoopCheck(db, PROVIDER, Date.now() + LEARNING_LOOP_STALE_MS + 86_400_000);
    expect(later.status).toBe("degraded");
    expect(later.detail).toContain("waited over 14 days");
    expect(later.detail).toMatch(/oldest 1[56]d/);
    expect(later.remediation).toContain("outcome");
  });

  it("a filed promotion and no stale backlog is ok", () => {
    recordTaskVerdict(db, { taskId: 1, claimant: "Roamer", approved: true, at: 1 });
    db.recordBenchmarkPromotion({
      slot: "forecast-config:test",
      outcome: "promoted",
      challenger_run_id: "r2",
      incumbent_run_id: "r1",
      value_json: "{}",
      actor: "Op",
      stats_json: null,
      reason: "held-out win",
      created_at: Date.now(),
    });
    const check = learningLoopCheck(db, PROVIDER);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("promotions ever filed 1");
  });
});

describe("readiness: gate-sentinels", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    db.createUser({ id: "u_op", name: "Operator" });
    db.createUser({ id: "u_bot", name: "Bot" });
    db.saveAgentConfig({ name: "Bot", model: "vendor/m", spawnedBy: "Operator" });
  });
  afterEach(() => db.close());

  const opsSeverity = (check: ReturnType<typeof gateSentinelsCheck>) => {
    syncOperationalAlerts({
      db,
      tasks: {} as never,
      runtime: { list: () => [], get: () => undefined } as never,
      readiness: () => ({ checks: [check] }) as unknown as ReadinessReport,
    });
    return db.listOperationalAlerts().find((a) => a.alert_key === "readiness:gate-sentinels")
      ?.severity;
  };

  it("a person's sentinel (an operator grant) is ok", () => {
    grant(db, "u_op", "key.manage");
    const check = gateSentinelsCheck(db);
    expect(check.status).toBe("ok");
    expect(check.critical).toBeUndefined();
  });

  it("an agent's sentinel is critical, names it, and says how to reset from a person session", () => {
    grant(db, "u_op", "key.manage");
    grant(db, "u_bot", "shell.exec");
    grant(db, "u_bot", "key.manage");
    const check = gateSentinelsCheck(db);
    expect(check).toMatchObject({ status: "off", critical: true });
    expect(check.optional).toBeUndefined();
    expect(check.detail).toContain("CRITICAL: 2 sentinel");
    expect(check.detail).toContain("Bot (2)");
    expect(check.remediation).toContain("gate reset agents all apply");
    expect(check.remediation).toContain("interactive person session");
    expect(opsSeverity(check)).toBe("critical");
  });
});

describe("operator-required refusals name a declared agent client", () => {
  let db: MarinaDB;
  let engine: Engine;
  beforeEach(() => {
    resetChallengesForTests();
    db = new MarinaDB(":memory:");
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });
  afterEach(() => {
    resetChallengesForTests();
    engine.stop();
    db.close();
  });

  const join = (name: string, agent: boolean) => {
    const conn = new MockConnection(`c-${name}`);
    if (agent) (conn as unknown as { agent: boolean }).agent = true;
    engine.addConnection(conn);
    engine.spawnEntity(conn.id, name);
    engine.entities.get(conn.entity as EntityId)!.properties.rank = 9;
    return conn;
  };
  const run = async (conn: MockConnection, text: string) => {
    conn.clear();
    await engine.processCommand(conn.entity as EntityId, text);
    return stripAnsi(conn.allTextJoined());
  };

  it("`gate reset … apply` from a one-shot client says why and where a person acts; nothing is reset", async () => {
    db.createUser({ id: "u_bot", name: "Bot" });
    db.saveAgentConfig({ name: "Bot", model: "vendor/m", spawnedBy: "system" });
    grant(db, "u_bot", "shell.exec");
    const scripted = join("Root", true);
    const text = await run(scripted, "gate reset agents all apply");
    expect(text).toContain("Applying a gate reset takes an operator (a person at rank 9).");
    expect(text).toContain("this connection declared itself an agent");
    expect(text).toContain("non-interactive `marina connect -c`");
    expect(text).toContain("interactive `marina connect` session or the dashboard");
    expect(gateSentinelsCheck(db).critical).toBe(true);
  });

  it("the same person on an interactive client is not told it is an agent, and the reset applies", async () => {
    db.createUser({ id: "u_bot", name: "Bot" });
    db.saveAgentConfig({ name: "Bot", model: "vendor/m", spawnedBy: "system" });
    grant(db, "u_bot", "shell.exec");
    const person = join("Root", false);
    expect(await run(person, "gate reset agents all apply")).toContain("Reset 1");
    expect(gateSentinelsCheck(db).status).toBe("ok");
  });

  it("`gate revoke` from a declared agent client gives the same reason", async () => {
    join("Bob", false);
    const scripted = join("Root", true);
    const text = await run(scripted, "gate revoke Bob code.exec");
    expect(text).toContain("Revoking a gate takes an operator");
    expect(text).toContain("this connection declared itself an agent");
  });
});
