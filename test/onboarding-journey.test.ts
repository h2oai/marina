// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The "first ten minutes" contract.
 *
 * A 2026-09 usability evaluation found the default world's onboarding rotted
 * around a fast-moving engine: `brief` hinted at a command that returned zero results, and the
 * `agent spawn` refusal gave a number that could never be satisfied. None of
 * it was caught because nothing tested the world a NEW USER actually lands in.
 *
 * This suite boots the real default world and enforces one structural rule:
 * every command the system's own output suggests must work when a fresh
 * entity runs it verbatim. If you change a hint, an empty-state message, or
 * the seeded world, this test tells you whether a newcomer's first session
 * still coheres.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId } from "../src/types";
import { seedGuidePool } from "../src/world/seed-guide";
import defaultWorld from "../worlds/default";
import { cleanupDb, MockConnection, stripAnsi } from "./helpers";

const plain = (s: string): string => stripAnsi(s);

describe("Onboarding journey (default world)", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let eid: EntityId;
  const dbPath = `/tmp/marina-onboarding-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({
      startRoom: defaultWorld.startRoom,
      tickInterval: 60_000,
      db,
      world: defaultWorld,
    });
    engine.registerWorldRooms(defaultWorld);
    seedGuidePool(db, defaultWorld.guideNotes);
    defaultWorld.seed?.(db);

    conn = new MockConnection("newcomer_conn");
    engine.addConnection(conn);
    const result = engine.login("newcomer_conn", "Newcomer");
    if (!("entityId" in result)) throw new Error(`login failed: ${JSON.stringify(result)}`);
    eid = result.entityId;
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  const run = (cmd: string): string => {
    conn.clear();
    engine.processCommand(eid, cmd);
    return plain(conn.allText().join("\n"));
  };

  // ── The self-referential contract: suggested commands must work ──────────

  it("every command in the brief hint line executes meaningfully", () => {
    run("brief"); // first brief is the welcome text
    const brief = run("brief"); // second is the compass, with the hint line
    const hintLine = brief.split("\n").find((l) => l.includes("Hint:"));
    expect(hintLine).toBeDefined();
    const hinted = hintLine!
      .replace(/.*Hint:\s*/, "")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(hinted.length).toBeGreaterThan(0);
    for (const cmd of hinted) {
      const out = run(cmd);
      expect(out, `hint "${cmd}" should not be an unknown command`).not.toContain(
        "Unknown command",
      );
      expect(out, `hint "${cmd}" should produce output`).not.toBe("");
      expect(out, `hint "${cmd}" should not return an empty result`).not.toContain(
        "No matching notes",
      );
    }
  });

  // ── Empty states guide instead of dead-ending ─────────────────────────────

  it("guide overview works and pool recall zero-hits point somewhere useful", () => {
    const guide = run("guide");
    expect(guide).toContain("guide");
    const miss = run("pool guide recall zebra unicorn");
    expect(miss).toContain("pool guide list");
  });

  // ── Refusals carry a path forward ─────────────────────────────────────────

  it("the agent.spawn refusal tells a solo operator how to elevate", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key-so-runtime-is-available";
    try {
      const out = run("agent spawn Scout");
      // Rank-0 newcomer: the gate refuses — but the refusal must name the
      // operator bootstrap instead of stranding them at a standing number.
      expect(out).toContain("MARINA_ADMINS");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
