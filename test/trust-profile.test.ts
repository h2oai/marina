// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Trust profile (Phase 1.0): a LOCAL Marina — one operator, loopback-only —
 * runs ungated; SHARED/PUBLIC keep every gate. Friction is a deployment
 * posture, not an architecture. YOLO applies to permissions, not records.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RateLimiter } from "../src/auth/rate-limiter";
import { Engine } from "../src/engine/engine";
import { checkGateForExecution } from "../src/engine/safety-gates";
import {
  assertTrustProfileSafe,
  describeTrustProfile,
  getTrustProfile,
  isLocalProfile,
  resetTrustProfileForTests,
  resolveTrustProfile,
  setTrustProfile,
} from "../src/engine/trust-profile";
import { MarinaDB } from "../src/persistence/database";
import { memoryLimitsFromEnv } from "../src/persistence/db-memory-storage";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_trust_profile.db";

describe("trust profile — resolution", () => {
  afterEach(() => resetTrustProfileForTests());

  it("derives LOCAL on a loopback-only bind without sign-in", () => {
    const r = resolveTrustProfile({ env: {}, loopbackOnlyBind: true, authEnabled: false });
    expect(r).toMatchObject({ profile: "local", derived: true });
  });

  it("derives SHARED when sign-in is on, even on loopback", () => {
    const r = resolveTrustProfile({ env: {}, loopbackOnlyBind: true, authEnabled: true });
    expect(r.profile).toBe("shared");
  });

  it("derives PUBLIC on a non-loopback bind without sign-in", () => {
    const r = resolveTrustProfile({ env: {}, loopbackOnlyBind: false, authEnabled: false });
    expect(r.profile).toBe("public");
  });

  it("MARINA_PROFILE overrides derivation and rejects unknown values", () => {
    const r = resolveTrustProfile({
      env: { MARINA_PROFILE: "shared" },
      loopbackOnlyBind: true,
      authEnabled: false,
    });
    expect(r).toMatchObject({ profile: "shared", derived: false });
    expect(() =>
      resolveTrustProfile({
        env: { MARINA_PROFILE: "yolo" },
        loopbackOnlyBind: true,
        authEnabled: false,
      }),
    ).toThrow(/MARINA_PROFILE must be/);
  });

  it("explicit LOCAL on a public bind is fatal unless auth or the insecure ack is set", () => {
    const base = { profile: "local" as const, loopbackOnlyBind: false, bindHost: "0.0.0.0" };
    expect(() =>
      assertTrustProfileSafe({ ...base, authEnabled: false, insecurePublicAck: false }),
    ).toThrow(/FATAL: MARINA_PROFILE=local/);
    expect(() =>
      assertTrustProfileSafe({ ...base, authEnabled: true, insecurePublicAck: false }),
    ).not.toThrow();
    expect(() =>
      assertTrustProfileSafe({ ...base, authEnabled: false, insecurePublicAck: true }),
    ).not.toThrow();
    expect(() =>
      assertTrustProfileSafe({
        profile: "public",
        loopbackOnlyBind: false,
        authEnabled: false,
        insecurePublicAck: false,
        bindHost: "0.0.0.0",
      }),
    ).not.toThrow();
  });

  it("process default is SHARED (legacy enforcement) until main resolves the profile", () => {
    expect(getTrustProfile({})).toBe("shared");
    expect(isLocalProfile({})).toBe(false);
    setTrustProfile("local");
    expect(isLocalProfile()).toBe(true);
    expect(describeTrustProfile()).toContain("LOCAL");
  });
});

describe("trust profile — LOCAL removes friction, SHARED keeps it", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    resetTrustProfileForTests();
    RateLimiter.bypass = false;
    db.close();
    cleanupDb(TEST_DB);
  });

  it("every safety gate auto-passes under LOCAL, including the open-posture core four", () => {
    setTrustProfile("shared");
    for (const gate of [
      "shell.exec",
      "key.manage",
      "admin.destructive",
      "code.exec.unrestricted",
    ]) {
      expect(checkGateForExecution(db, "e_nobody", gate).ok).toBe(false);
    }
    setTrustProfile("local");
    for (const gate of [
      "shell.exec",
      "key.manage",
      "admin.destructive",
      "code.exec.unrestricted",
      "agent.spawn",
    ]) {
      expect(checkGateForExecution(db, "e_nobody", gate)).toEqual({
        ok: true,
        mode: "profile-local",
      });
    }
  });

  it("MARINA_AUTONOMY=guarded re-enforces gates on a LOCAL instance (the admin's one-line switch)", () => {
    setTrustProfile("local");
    const previous = process.env.MARINA_AUTONOMY;
    process.env.MARINA_AUTONOMY = "guarded";
    try {
      expect(checkGateForExecution(db, "e_nobody", "shell.exec").ok).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.MARINA_AUTONOMY;
      else process.env.MARINA_AUTONOMY = previous;
    }
    expect(checkGateForExecution(db, "e_nobody", "shell.exec").ok).toBe(true);
  });

  it("a loopback login is sovereign under LOCAL and rank floors are off; SHARED keeps rank 0", () => {
    const run = (profile: "local" | "shared") => {
      setTrustProfile(profile);
      const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
      engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
      const conn = new MockConnection(`c-${profile}`);
      engine.addConnection(conn);
      const result = engine.login(conn.id, `op_${profile}`);
      expect("entityId" in result).toBe(true);
      const entity = engine.entities.get((result as { entityId: string }).entityId as never);
      conn.clear();
      // `admin` is minRank 5 + admin.destructive gate.
      engine.processCommand(entity!.id, "admin");
      const out = stripAnsi(conn.allTextJoined());
      engine.stop();
      return { rank: entity!.properties.rank ?? 0, out };
    };
    const shared = run("shared");
    expect(shared.rank).toBe(0);
    expect(shared.out).toMatch(/must be at least/);
    const local = run("local");
    expect(local.rank).toBe(9);
    expect(local.out).not.toMatch(/must be at least/);
  });

  it("rate limiters pass everything under the LOCAL bypass", () => {
    const limiter = new RateLimiter({ maxTokens: 1, refillRate: 1, refillInterval: 60_000 });
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(false);
    RateLimiter.bypass = true;
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(true);
  });

  it("memory admission budgets are unlimited under LOCAL unless set explicitly", () => {
    expect(memoryLimitsFromEnv({})).toEqual({});
    const local = memoryLimitsFromEnv({ MARINA_PROFILE: "local" });
    expect(local.logical_bytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(local.spaces).toBe(Number.MAX_SAFE_INTEGER);
    const explicit = memoryLimitsFromEnv({
      MARINA_PROFILE: "local",
      MARINA_MEMORY_MAX_SPACES: "3",
    });
    expect(explicit.spaces).toBe(3);
    expect(explicit.sources).toBe(Number.MAX_SAFE_INTEGER);
  });
});
