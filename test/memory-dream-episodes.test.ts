// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 5b: the continuity journal as a region input and the compaction-event
 * trigger. The owner's newest journal episodes (its resident space's
 * `journal:` sources) are shown to the dreamer as evidence — a restatement
 * may take a number from them — and journaled bytes count as material;
 * nobody else's journal is ever read. A context compaction files a dream
 * REQUEST that waives material and cooldown; the 5-minute job runs it once
 * the agent is quiet, under the budget gate, and a dream clears it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import {
  DREAM_COOLDOWN_MS,
  DREAM_IDLE_MS,
  DREAM_MIN_JOURNAL_BYTES,
  gatherEpisodes,
  gatherRegion,
  journalBytesSince,
  parseEpisode,
  pendingRequest,
  regionPrompt,
  requestDream,
  runDream,
  runRequestedDreams,
  scheduleGate,
} from "../src/memory/dream";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";
import { scopeProcessState } from "./process-state";

const TEST_DB = tempDbPath("test_memory_dream_episodes.db");
const HOUR = 60 * 60 * 1000;

describe("episodes and the compaction trigger", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let ada: EntityId;
  let noteId: number;
  const now = Date.now();

  const message = (role: string, text: string) =>
    `,${JSON.stringify({ role, content: [{ type: "text", text }] })}`;

  /** One journal part in `owner`'s resident space, as `DurableResidentMemory` captures it. */
  const journal = (owner: string, part: string, at: number) => {
    const raw = db.memoryRepository().raw;
    const principal = `u_${owner}`;
    const space = `space_${owner}`;
    raw.run(
      "INSERT OR IGNORE INTO memory_spaces (id, owner_id, name, created_at) VALUES (?, ?, 'resident', ?)",
      [space, principal, at],
    );
    const id = `src_${owner}_${at}_${Math.random().toString(36).slice(2, 8)}`;
    raw.run(
      "INSERT INTO memory_sources (id, space_id, session_id, body, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, space, `journal:${owner}`, JSON.stringify(part), id, at],
    );
    const seq = (
      raw.query("SELECT seq FROM memory_sources WHERE id = ?").get(id) as { seq: number }
    ).seq;
    raw.run("INSERT OR IGNORE INTO memory_source_text (seq, text) VALUES (?, ?)", [seq, part]);
    return id;
  };

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Ada");
    ada = conn.entity!;
    conn.clear();
    for (const name of ["Ada", "Bob"]) {
      db.ensurePrincipal({ type: "human", displayName: name, principalId: `u_${name}` });
      if (!db.durableKeyForName(name)) db.createUser({ id: `u_${name}`, name, rank: 1 });
    }
    noteId = db.createNote("Ada", "The quartz build runs on the shared runner", undefined, {
      skipDedup: true,
    });
    // Filler, so the preservation bound (a quarter of the region) lets one record leave.
    for (const text of [
      "Lantern maintenance is scheduled for the first Monday of each month",
      "Indigo alerts page the on-call engineer after three failures",
      "Amber health checks poll every thirty seconds",
      "Cobalt tests need the fixture database reset before each run",
    ])
      db.createNote("Ada", text, undefined, { skipDedup: true });
    journal("Ada", "[", now - 3 * HOUR);
    journal("Ada", message("user", "How long does the quartz build take?"), now - 3 * HOUR + 1);
    journal(
      "Ada",
      message("assistant", "The quartz build took eleven minutes on the shared runner today."),
      now - 3 * HOUR + 2,
    );
    journal(
      "Ada",
      `,${JSON.stringify({ role: "toolResult", toolName: "marina_command", content: [{ type: "text", text: "build #42 finished in 11m03s" }] })}`,
      now - 3 * HOUR + 3,
    );
    journal("Ada", "]", now - 3 * HOUR + 4);
    journal("Bob", message("assistant", "Bob's secret: the vault code is 7781."), now - 2 * HOUR);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("gathers the owner's own episodes, oldest first, never another agent's; brackets and manifests are skipped", () => {
    const got = gatherEpisodes(db, "Ada", now - 24 * HOUR, now);
    expect(got.episodes.map((e) => e.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(got.episodes[2]!.text).toBe("marina_command: build #42 finished in 11m03s");
    expect(got.parts).toBe(5);
    expect(JSON.stringify(got)).not.toContain("7781");
    expect(gatherEpisodes(db, "Bob", now - 24 * HOUR, now).episodes).toHaveLength(1);
    expect(gatherEpisodes(db, "Nobody", now - 24 * HOUR, now).episodes).toEqual([]);
    expect(parseEpisode("[", 1)).toBeUndefined();
    expect(parseEpisode('{"format":"json-utf8-parts-v1"}', 1)).toBeUndefined();
    expect(parseEpisode(',{"role":"system","content":"x"}', 1)).toBeUndefined();
    expect(parseEpisode(',{"role":"assistant","content":"hi', 1)).toBeUndefined();
    expect(parseEpisode(',{"role":"user","content":"plain  text"}', 5)).toEqual({
      at: 5,
      role: "user",
      text: "plain text",
    });
    // The byte cap keeps the newest.
    const capped = gatherEpisodes(db, "Ada", now - 24 * HOUR, now, 60);
    expect(capped.episodes.map((e) => e.role)).toEqual(["toolResult"]);
  });

  it("the region carries the episodes; the prompt shows them; a restatement may take a number from them", async () => {
    const region = gatherRegion(db, "Ada", now - 24 * HOUR, now);
    expect(region.episodes).toHaveLength(3);
    expect(region.journalBytes).toBeGreaterThan(0);
    expect(regionPrompt(region)).toContain("Episodes (the agent's own recent journal");
    expect(regionPrompt(region)).toContain("eleven minutes");
    // "eleven" and "11m03s" live only in the journal: faithful because the episodes are sources.
    const summary = await runDream(db, "Ada", "command", {
      now: now + HOUR,
      model: "test/dreamer",
      complete: async () =>
        JSON.stringify({
          ops: [
            {
              op: "supersede",
              id: noteId,
              text: "The quartz build runs on the shared runner and took eleven minutes (11m03s)",
              refs: [],
              reason: "the journal said how long",
            },
          ],
        }),
    });
    expect(summary.state).toBe("observed");
    expect(summary.checks!.accepted).toBe(1);
    expect(summary.rejected).toEqual([]);
    // The dream row keeps no episode text.
    expect(db.getDream(summary.id!)!.ops_json).not.toContain("eleven");
  });

  it("journaled bytes are material on their own; a request waives material and cooldown, waits for quiet, and is cleared by the dream", async () => {
    using _state = scopeProcessState({ env: { MARINA_DREAMING: "on" } });
    // One note and a few journal parts: below both material thresholds.
    expect(scheduleGate(db, "Ada", now)).toMatch(/^material:/);
    const big = "x".repeat(DREAM_MIN_JOURNAL_BYTES);
    journal("Ada", message("assistant", big), now - HOUR);
    expect(journalBytesSince(db, "Ada", now - 24 * HOUR)).toBeGreaterThanOrEqual(
      DREAM_MIN_JOURNAL_BYTES,
    );
    expect(scheduleGate(db, "Ada", now)).toBeUndefined();

    // A dream (the notes were written after `now`, so it looks from an hour on), then the
    // cooldown holds — until a request.
    const t0 = now + HOUR;
    const first = await runDream(db, "Ada", "command", {
      now: t0,
      complete: async () => '{"ops":[]}',
    });
    expect(first.state).toBe("observed");
    expect(scheduleGate(db, "Ada", t0 + HOUR)).toMatch(/^cooldown:/);
    await engine.processCommand(ada, "memory dream request compaction of 12 messages");
    expect(conn.lastText()).toContain("Dream requested (compaction of 12 messages)");
    expect(pendingRequest(db, "Ada", t0 + HOUR)?.reason).toBe("compaction of 12 messages");
    expect(scheduleGate(db, "Ada", t0 + HOUR)).toBeUndefined();

    // The requested pass waits while the agent is active …
    db.recordPrimitiveUsage({
      actorName: "Ada",
      actorKind: "player",
      source: "command",
      primitive: "memory",
      action: "note",
      safeLabel: "note",
      success: true,
      createdAt: t0 + HOUR,
    });
    expect(
      await runRequestedDreams(db, { now: t0 + HOUR + 60_000, complete: async () => '{"ops":[]}' }),
    ).toEqual([]);
    expect(pendingRequest(db, "Ada", t0 + HOUR + 60_000)).toBeDefined();
    // … and runs once it has been quiet, as a `compaction` dream, clearing the request.
    const at = t0 + HOUR + DREAM_IDLE_MS + 1;
    db.createNote("Ada", "Fresh material for the requested dream", undefined, { skipDedup: true });
    db.memoryRepository().raw.run("UPDATE notes SET created_at = ? WHERE entity_name = 'Ada'", [
      at - 1000,
    ]);
    const ran = await runRequestedDreams(db, { now: at, complete: async () => '{"ops":[]}' });
    expect(ran.map((d) => [d.entityName, d.trigger, d.state])).toEqual([
      ["Ada", "compaction", "observed"],
    ]);
    expect(db.getDream(ran[0]!.id!)!.trigger).toBe("compaction");
    expect(pendingRequest(db, "Ada", at)).toBeUndefined();
    expect(
      await runRequestedDreams(db, { now: at + 1, complete: async () => '{"ops":[]}' }),
    ).toEqual([]);
    // A request over an empty window is met too; an old one expires.
    requestDream(db, "Ada", "stale", { now: at - 2 * 24 * HOUR });
    expect(pendingRequest(db, "Ada", at)).toBeUndefined();
    expect(scheduleGate(db, "Ada", at + 1)).toMatch(/^cooldown:/);
    expect(DREAM_COOLDOWN_MS).toBeGreaterThan(DREAM_IDLE_MS);
  });
});
