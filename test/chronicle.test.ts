import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { FeedPublisher } from "../src/net/feed-publisher";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent, EntityId, RoomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_chronicle.db";

describe("Chronicle — canonical append-only record", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let entityId: EntityId;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ db, startRoom: "test/start" as RoomId });
    engine.registerRoom("test/start" as RoomId, makeTestRoom());

    conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.login("c1", "Tester");
    if ("error" in result) throw new Error(result.error);
    entityId = result.entityId;
    conn.clear();
  });

  afterEach(() => {
    try {
      engine.shutdown();
    } catch {}
    try {
      db.close();
    } catch {}
    cleanupDb(TEST_DB);
  });

  // ─── Persistence layer ─────────────────────────────────────────────────

  describe("persistence", () => {
    it("starts empty", () => {
      expect(db.getChronicleCount()).toBe(0);
      expect(db.queryChronicle()).toEqual([]);
    });

    it("appends an event entry and reads it back", () => {
      const id = db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "Task #1 completed",
        body: "Test body.",
        participants: ["alice"],
        refs: ["feed:1", "task:1"],
      });
      expect(id).toBeGreaterThan(0);
      const entry = db.getChronicleEntry(id);
      expect(entry).toBeDefined();
      expect(entry?.kind).toBe("event");
      expect(entry?.participants).toEqual(["alice"]);
      expect(entry?.refs).toEqual(["feed:1", "task:1"]);
    });

    it("rejects a correction without supersedes", () => {
      expect(() =>
        db.appendChronicle({
          kind: "correction",
          source: "chronicler",
          title: "oops",
        }),
      ).toThrow(/supersedes/);
    });

    it("queryChronicle filters by participant via JSON contains-by-string", () => {
      db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "A",
        participants: ["alice"],
      });
      db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "B",
        participants: ["bob", "alice"],
      });
      db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "C",
        participants: ["bob"],
      });

      const aliceEntries = db.queryChronicle({ participant: "alice" });
      expect(aliceEntries).toHaveLength(2);
      const bobEntries = db.queryChronicle({ participant: "bob" });
      expect(bobEntries).toHaveLength(2);

      // No substring collision: "bo" is not a participant
      expect(db.queryChronicle({ participant: "bo" })).toHaveLength(0);
    });

    it("queryChronicle filters by kind and source", () => {
      db.appendChronicle({ kind: "event", source: "task_approved", title: "A" });
      db.appendChronicle({ kind: "event", source: "rank_change", title: "B" });
      db.appendChronicle({ kind: "narrative", source: "chronicler", title: "C" });

      expect(db.queryChronicle({ kind: "event" })).toHaveLength(2);
      expect(db.queryChronicle({ kind: "narrative" })).toHaveLength(1);
      expect(db.queryChronicle({ source: "rank_change" })).toHaveLength(1);
    });

    it("getCorrectionsFor walks the supersession chain", () => {
      const original = db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "First take",
      });
      const correctionA = db.appendChronicle({
        kind: "correction",
        source: "chronicler",
        title: "Revised once",
        supersedes: original,
      });
      db.appendChronicle({
        kind: "correction",
        source: "chronicler",
        title: "Revised twice",
        supersedes: correctionA,
      });

      const corrections = db.getChronicleCorrectionsFor(original);
      expect(corrections).toHaveLength(2);
      // Newest first
      expect(corrections[0]?.title).toBe("Revised twice");
      expect(corrections[1]?.title).toBe("Revised once");

      // Original entry is unchanged — append-only invariant
      const stillOriginal = db.getChronicleEntry(original);
      expect(stillOriginal?.title).toBe("First take");
    });
  });

  // ─── Engine emitters (via FeedPublisher) ───────────────────────────────

  describe("engine emitters", () => {
    let publisher: FeedPublisher;

    beforeEach(() => {
      publisher = new FeedPublisher({
        db,
        resolveEntity: (id) => engine.entities.get(id)?.name,
      });
    });

    it("records a chronicle entry on rank_change", () => {
      publisher.handleEvent({
        type: "rank_change",
        entity: entityId,
        name: "Tester",
        oldRank: 1,
        newRank: 2,
        direction: "promoted",
        timestamp: Date.now(),
      } as EngineEvent);

      const entries = db.queryChronicle({ source: "rank_change" });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.title).toContain("Tester");
      expect(entries[0]?.title).toContain("rank 2");
      expect(entries[0]?.participants).toContain("Tester");
      // refs include feed event + rank domain ref
      expect(entries[0]?.refs.some((r) => r.startsWith("feed:"))).toBe(true);
      expect(entries[0]?.refs).toContain("rank:2");
    });

    it("records chronicle entries on crew lifecycle", () => {
      publisher.handleEvent({
        type: "crew_created",
        crew: "crew-x" as never,
        name: "scouts",
        owner: entityId,
        formation: "research",
        lifetime: "persisted",
        timestamp: Date.now(),
      } as EngineEvent);
      publisher.handleEvent({
        type: "crew_completed",
        crew: "crew-x" as never,
        resultNoteId: 42,
        timestamp: Date.now(),
      } as EngineEvent);
      publisher.handleEvent({
        type: "crew_dissolved",
        crew: "crew-y" as never,
        reason: "idle timeout",
        timestamp: Date.now(),
      } as EngineEvent);

      const created = db.queryChronicle({ source: "crew_created" });
      expect(created).toHaveLength(1);
      expect(created[0]?.title).toContain("scouts");

      const completed = db.queryChronicle({ source: "crew_completed" });
      expect(completed).toHaveLength(1);
      expect(completed[0]?.refs).toContain("note:42");

      const dissolved = db.queryChronicle({ source: "crew_dissolved" });
      expect(dissolved).toHaveLength(1);
      expect(dissolved[0]?.body).toContain("idle timeout");
    });

    it("chronicles task_approved but not task_claimed/submitted", () => {
      db.createTask({
        title: "Build a thing",
        description: "",
        creatorId: entityId,
        creatorName: "Tester",
      });
      publisher.handleEvent({
        type: "task_claimed",
        entity: entityId,
        taskId: 1,
        timestamp: Date.now(),
      });
      publisher.handleEvent({
        type: "task_submitted",
        entity: entityId,
        taskId: 1,
        timestamp: Date.now(),
      });
      publisher.handleEvent({
        type: "task_approved",
        entity: entityId,
        taskId: 1,
        timestamp: Date.now(),
      });

      const approvedEntries = db.queryChronicle({ source: "task_approved" });
      expect(approvedEntries).toHaveLength(1);
      expect(approvedEntries[0]?.title).toContain("Build a thing");
      expect(db.queryChronicle({ source: "task_claimed" })).toHaveLength(0);
      expect(db.queryChronicle({ source: "task_submitted" })).toHaveLength(0);
    });

    it("records market consensus", () => {
      publisher.handleEvent({
        type: "market_consensus",
        entity: entityId,
        room: "market:abc" as RoomId,
        question: "Will it rain tomorrow?",
        yesPercent: 73,
        noPercent: 27,
        participants: 5,
        agreement: 0.85,
        timestamp: Date.now(),
      } as EngineEvent);

      const entries = db.queryChronicle({ source: "market_consensus" });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.title).toContain("Will it rain");
      expect(entries[0]?.body).toContain("YES 73%");
      expect(entries[0]?.refs).toContain("market:market:abc");
    });
  });

  // ─── Read commands ─────────────────────────────────────────────────────

  describe("chronicle command", () => {
    it("empty state shows a helpful message", () => {
      engine.processCommand(entityId, "chronicle");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("chronicle is empty");
    });

    it("lists recent entries", () => {
      db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "Task #1 completed by alice",
        participants: ["alice"],
      });
      db.appendChronicle({
        kind: "event",
        source: "rank_change",
        title: "bob rose to rank 2",
        participants: ["bob"],
      });

      conn.clear();
      engine.processCommand(entityId, "chronicle");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("Chronicle");
      expect(text).toContain("alice");
      expect(text).toContain("bob");
    });

    it("shows full entry with provenance via `chronicle show`", () => {
      const id = db.appendChronicle({
        kind: "event",
        source: "crew_completed",
        title: 'Crew "scouts" completed',
        body: "Result recorded in note #99.",
        refs: ["feed:1", "crew:c_1", "note:99"],
      });

      conn.clear();
      engine.processCommand(entityId, `chronicle show ${id}`);
      const text = stripAnsi(conn.lastText());
      expect(text).toContain(`Chronicle #${id}`);
      expect(text).toContain("note:99");
      expect(text).toContain("Result recorded in note #99");
    });

    it("`chronicle show` surfaces the supersession chain", () => {
      const original = db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "Initial reading",
      });
      db.appendChronicle({
        kind: "correction",
        source: "chronicler",
        title: "Revised reading",
        supersedes: original,
      });

      conn.clear();
      engine.processCommand(entityId, `chronicle show ${original}`);
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("Initial reading");
      expect(text).toContain("Revised reading");
      expect(text).toContain("correction");
    });

    it("filters by duration via `chronicle since`", () => {
      // Old entry — fake via direct DB write would require time travel.
      // Instead, add two entries and trust the since filter on a wide window.
      db.appendChronicle({ kind: "event", source: "task_approved", title: "A" });
      db.appendChronicle({ kind: "event", source: "task_approved", title: "B" });

      conn.clear();
      engine.processCommand(entityId, "chronicle since 1h");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("2 entries");
    });

    it("filters by participant via `chronicle about`", () => {
      db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "A",
        participants: ["alice"],
      });
      db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "B",
        participants: ["bob"],
      });

      conn.clear();
      engine.processCommand(entityId, "chronicle about alice");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("about");
      expect(text).toContain("alice");
      expect(text).toContain("1 entries");
    });

    it("`chronicle about` reports nothing for an unknown name", () => {
      db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "A",
        participants: ["alice"],
      });

      conn.clear();
      engine.processCommand(entityId, "chronicle about nobody");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("Nothing in the chronicle involves nobody");
    });

    it("`chronicle kinds` summarizes sources", () => {
      db.appendChronicle({ kind: "event", source: "task_approved", title: "A" });
      db.appendChronicle({ kind: "event", source: "task_approved", title: "B" });
      db.appendChronicle({ kind: "event", source: "rank_change", title: "C" });

      conn.clear();
      engine.processCommand(entityId, "chronicle kinds");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("task_approved");
      expect(text).toContain("rank_change");
    });
  });

  // ─── Chronicler write commands ────────────────────────────────────────

  describe("write commands (Chronicler-gated)", () => {
    function makeChronicler(): EntityId {
      const c = new MockConnection("chronicler-conn");
      engine.addConnection(c);
      const result = engine.login("chronicler-conn", "Chronicler");
      if ("error" in result) throw new Error(result.error);
      const e = engine.entities.get(result.entityId);
      if (e) e.properties.role = "chronicler";
      c.clear();
      return result.entityId;
    }

    it("rejects record from non-Chronicler entities", () => {
      conn.clear();
      engine.processCommand(entityId, "chronicle record A thing happened | Body text refs feed:1");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("Only the Chronicler");
      expect(db.queryChronicle({ kind: "narrative" })).toHaveLength(0);
    });

    it("Chronicler can record a narrative with refs", () => {
      const chronId = makeChronicler();
      engine.processCommand(
        chronId,
        "chronicle record A thing happened | The thing's body. refs feed:1,task:2 participants alice,bob",
      );
      const entries = db.queryChronicle({ kind: "narrative" });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.title).toBe("A thing happened");
      expect(entries[0]?.body).toContain("The thing's body");
      expect(entries[0]?.refs).toEqual(["feed:1", "task:2"]);
      expect(entries[0]?.participants).toEqual(["alice", "bob"]);
      expect(entries[0]?.source).toBe("chronicler");
    });

    it("refuses a narrative without refs (citation discipline)", () => {
      const chronId = makeChronicler();
      const chronConn = engine.entities.get(chronId);
      expect(chronConn).toBeDefined();

      engine.processCommand(chronId, "chronicle record A thing | Body");
      // No narrative was written
      expect(db.queryChronicle({ kind: "narrative" })).toHaveLength(0);
    });

    it("Chronicler can correct a prior narrative", () => {
      const chronId = makeChronicler();
      const priorId = db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "Initial reading",
        body: "First take",
        refs: ["feed:1"],
      });
      engine.processCommand(
        chronId,
        `chronicle correct ${priorId} Revised reading | New body. refs feed:1,feed:2`,
      );
      const corrections = db.queryChronicle({ kind: "correction" });
      expect(corrections).toHaveLength(1);
      expect(corrections[0]?.supersedes).toBe(priorId);
      expect(corrections[0]?.title).toBe("Revised reading");
      // Original is untouched
      expect(db.getChronicleEntry(priorId)?.title).toBe("Initial reading");
    });

    it("refuses correction of event-kind entries", () => {
      const chronId = makeChronicler();
      const eventId = db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "Task #1 done",
      });
      engine.processCommand(
        chronId,
        `chronicle correct ${eventId} New interpretation | body refs feed:1`,
      );
      expect(db.queryChronicle({ kind: "correction" })).toHaveLength(0);
    });

    it("Chronicler can record a daily digest with auto-period", () => {
      const chronId = makeChronicler();
      engine.processCommand(
        chronId,
        "chronicle digest day Day in review | Things were chronicled. refs feed:1,feed:2",
      );
      const digests = db.queryChronicle({ kind: "digest" });
      expect(digests).toHaveLength(1);
      expect(digests[0]?.period).toMatch(/^day:\d{4}-\d{2}-\d{2}$/);
      expect(digests[0]?.title).toBe("Day in review");
    });

    it("Chronicler can record a weekly digest with auto-period", () => {
      const chronId = makeChronicler();
      engine.processCommand(
        chronId,
        "chronicle digest week Week in review | Synthesis of the week. refs feed:1",
      );
      const digests = db.queryChronicle({ kind: "digest" });
      expect(digests).toHaveLength(1);
      expect(digests[0]?.period).toMatch(/^week:\d{4}-W\d{2}$/);
    });

    it("digest accepts explicit period override", () => {
      const chronId = makeChronicler();
      engine.processCommand(
        chronId,
        "chronicle digest day Past day | Backfilled. refs feed:1 period day:2026-01-15",
      );
      const digests = db.queryChronicle({ kind: "digest" });
      expect(digests[0]?.period).toBe("day:2026-01-15");
    });
  });

  // ─── chronicle pending ────────────────────────────────────────────────

  describe("chronicle pending", () => {
    it("reports nothing pending on an empty chronicle", () => {
      conn.clear();
      engine.processCommand(entityId, "chronicle pending");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("No un-narrated events");
    });

    it("lists event entries when no narrative has been written yet", () => {
      db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "Task #1 completed",
        participants: ["alice"],
      });
      db.appendChronicle({
        kind: "event",
        source: "rank_change",
        title: "bob rose to rank 2",
        participants: ["bob"],
      });

      conn.clear();
      engine.processCommand(entityId, "chronicle pending");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("Pending");
      expect(text).toContain("Task #1");
      expect(text).toContain("bob rose");
      expect(text).toContain("2 events");
    });

    it("cursor advances past the most recent narrative", () => {
      // Two events, then a narrative covering them, then a third event.
      db.appendChronicle({ kind: "event", source: "task_approved", title: "old #1" });
      db.appendChronicle({ kind: "event", source: "task_approved", title: "old #2" });
      // Force a narrative AFTER the two events
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "Two tasks completed",
        body: "Both shipped today.",
        refs: ["feed:1", "feed:2"],
      });
      // Wait 2ms so the new event has a strictly-later created_at than the
      // narrative (sqlite ms resolution can collide otherwise on fast tests)
      Bun.sleepSync(2);
      db.appendChronicle({ kind: "event", source: "rank_change", title: "fresh event" });

      conn.clear();
      engine.processCommand(entityId, "chronicle pending");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("fresh event");
      expect(text).not.toContain("old #1");
      expect(text).not.toContain("old #2");
    });

    it("--since override surfaces older events too", () => {
      db.appendChronicle({ kind: "event", source: "task_approved", title: "old event" });
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "covered",
        refs: ["feed:1"],
      });

      conn.clear();
      engine.processCommand(entityId, "chronicle pending since 24h");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("old event");
      expect(text).toContain("last 24h");
    });
  });

  // ─── Pass 3: chronicle as cognitive context ───────────────────────────

  describe("queryChronicle `like` filter", () => {
    it("matches title OR body, case-insensitive substring", () => {
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "Alice shipped the bridge migration",
        body: "Completed in three days.",
      });
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "Bob refactored the codebase",
        body: "A bridge component was simplified.",
      });
      db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "Unrelated task done",
      });

      // Title-only match
      const aliceMatches = db.queryChronicle({ like: "alice" });
      expect(aliceMatches).toHaveLength(1);
      expect(aliceMatches[0]?.title).toContain("Alice");

      // Body-only match
      const bridgeMatches = db.queryChronicle({ like: "bridge" });
      expect(bridgeMatches).toHaveLength(2);
    });

    it("escapes SQL LIKE wildcards in user input", () => {
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "Discount was 50% off",
      });
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "Generic event",
      });

      // `%` should be literal, not match-everything
      const matches = db.queryChronicle({ like: "50%" });
      expect(matches).toHaveLength(1);
      expect(matches[0]?.title).toContain("50%");
    });
  });

  describe("recap chronicle", () => {
    it("`recap chronicle` shows recent entries grouped by kind", () => {
      db.appendChronicle({ kind: "event", source: "task_approved", title: "Task done" });
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "Today's synthesis",
        refs: ["feed:1"],
      });
      db.appendChronicle({
        kind: "digest",
        source: "chronicler",
        title: "Day in review",
        refs: ["feed:1"],
        period: "day:2026-05-18",
      });

      conn.clear();
      engine.processCommand(entityId, "recap chronicle");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("Chronicle — recent");
      expect(text).toContain("Today's synthesis");
      expect(text).toContain("Day in review");
      expect(text).toContain("Task done");
      // Digests should be listed before narratives, narratives before events
      const digestIdx = text.indexOf("Day in review");
      const narrIdx = text.indexOf("Today's synthesis");
      const eventIdx = text.indexOf("Task done");
      expect(digestIdx).toBeLessThan(narrIdx);
      expect(narrIdx).toBeLessThan(eventIdx);
    });

    it("`recap chronicle day` filters to the last 24h", () => {
      db.appendChronicle({ kind: "event", source: "task_approved", title: "Recent task" });

      conn.clear();
      engine.processCommand(entityId, "recap chronicle day");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("Chronicle — last 24h");
      expect(text).toContain("Recent task");
    });

    it("`recap chronicle week` filters to the last 7d", () => {
      db.appendChronicle({ kind: "event", source: "task_approved", title: "Recent task" });

      conn.clear();
      engine.processCommand(entityId, "recap chronicle week");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("Chronicle — last 7d");
    });

    it("`recap chronicle day` reports nothing when empty", () => {
      conn.clear();
      engine.processCommand(entityId, "recap chronicle day");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("Nothing chronicled in the last 24h");
    });
  });

  describe("recap <topic> includes chronicle hits", () => {
    it("surfaces chronicle entries that mention the topic", () => {
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "The bridge launch",
        body: "Three engineers shipped the new bridge.",
        refs: ["feed:1"],
      });

      conn.clear();
      engine.processCommand(entityId, "recap bridge");
      const text = stripAnsi(conn.lastText());
      expect(text).toContain("Chronicle");
      expect(text).toContain("The bridge launch");
    });

    it("omits the Chronicle section when no chronicle entries match", () => {
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "Unrelated entry",
        refs: ["feed:1"],
      });

      conn.clear();
      engine.processCommand(entityId, "recap zzz-no-match-here");
      const text = stripAnsi(conn.lastText());
      expect(text).not.toContain("Chronicle\n");
    });
  });

  describe("ask includes chronicle as a context source", () => {
    it("surfaces chronicle entries to the model and the user", async () => {
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "Alice and Bob shipped the redesign",
        body: "Their two-day push wrapped the navigation rebuild.",
        refs: ["feed:1"],
        participants: ["Alice", "Bob"],
      });

      const seenContext: string[] = [];
      // Stand up a fake answerer so we can inspect what context the model would see
      const { askCommand } = await import("../src/engine/commands/ask");
      const cmd = askCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db,
        answerQuestion: async (_q: string, context: string) => {
          seenContext.push(context);
          return "stubbed answer";
        },
      });
      engine.commands.registerBuiltin(cmd);

      conn.clear();
      engine.processCommand(entityId, "ask navigation rebuild");
      // Wait a beat for the async handler to complete
      await new Promise((r) => setTimeout(r, 50));

      const text = stripAnsi(conn.lastText());
      expect(text).toContain("Chronicle");
      expect(text).toContain("Alice and Bob shipped");

      expect(seenContext.length).toBeGreaterThan(0);
      expect(seenContext[0]).toContain("[chronicle:narrative:");
      expect(seenContext[0]).toContain("Alice and Bob shipped");
    });
  });

  // ─── Pass 4: standing flow + arrival digest ───────────────────────────

  describe("standing flow on citation", () => {
    it("does not flow standing for engine `event` entries without participants resolver", () => {
      // FeedPublisher in beforeEach() above was built without
      // resolveEntityIdByName — so emitting an event-kind entry should NOT
      // flow standing even though the participant is real. Citation discipline
      // is preserved; standing is just optional.
      const publisher = new FeedPublisher({
        db,
        resolveEntity: (id) => engine.entities.get(id)?.name,
      });
      publisher.handleEvent({
        type: "rank_change",
        entity: entityId,
        name: "Tester",
        oldRank: 1,
        newRank: 2,
        direction: "promoted",
        timestamp: Date.now(),
      } as EngineEvent);
      // Standing should remain at 0 — no chronicled credit flowed
      const ledger = db.ledgerForEntity(entityId, 10);
      expect(ledger.filter((r) => r.kind === "chronicled")).toHaveLength(0);
    });

    it("flows chronicled standing for engine entries when resolver is wired", () => {
      // Create the agent first so the name resolver finds it
      const agent = engine.entities.create({
        name: "Alice",
        short: "Alice",
        long: "Alice the agent.",
        kind: "agent",
        room: "test/start" as RoomId,
      });

      const publisher = new FeedPublisher({
        db,
        resolveEntity: (id) => engine.entities.get(id)?.name,
        resolveEntityIdByName: (name) => engine.entities.findAgentByName(name)?.id,
      });

      publisher.handleEvent({
        type: "rank_change",
        entity: agent.id,
        name: "Alice",
        oldRank: 1,
        newRank: 2,
        direction: "promoted",
        timestamp: Date.now(),
      } as EngineEvent);

      const ledger = db.ledgerForEntity(agent.id, 10);
      const chronicled = ledger.filter((r) => r.kind === "chronicled");
      expect(chronicled).toHaveLength(1);
      expect(chronicled[0]?.amount).toBeCloseTo(0.25); // event-kind weight
      expect(chronicled[0]?.ref).toMatch(/^chronicle:\d+$/);
    });

    it("flows heavier standing for narrative entries than event entries", () => {
      // Spawn agents whose names will be resolved
      const alice = engine.entities.create({
        name: "Alice",
        short: "Alice",
        long: "Alice the agent.",
        kind: "agent",
        room: "test/start" as RoomId,
      });

      const chronEntity = engine.entities.get(entityId);
      if (chronEntity) chronEntity.properties.role = "chronicler";

      // Register the chronicle command with the name resolver wired
      const { chronicleCommand } = require("../src/engine/commands/chronicle");
      engine.commands.registerBuiltin(
        chronicleCommand({
          getEntity: (id: string) => engine.entities.get(id as EntityId),
          db,
          resolveEntityIdByName: (name: string) => engine.entities.findAgentByName(name)?.id,
        }),
      );

      engine.processCommand(
        entityId,
        "chronicle record Alice's milestone | She shipped it. refs feed:1 participants Alice",
      );

      const ledger = db.ledgerForEntity(alice.id, 10);
      const chronicled = ledger.filter((r) => r.kind === "chronicled");
      expect(chronicled).toHaveLength(1);
      expect(chronicled[0]?.amount).toBeCloseTo(2.0); // narrative-kind weight
    });

    it("is idempotent — re-recording the same chronicle entry credits once", () => {
      const alice = engine.entities.create({
        name: "Alice",
        short: "Alice",
        long: "Alice the agent.",
        kind: "agent",
        room: "test/start" as RoomId,
      });

      // Append a chronicle entry directly, then call the citation helper
      // twice with the same id — the second call should not duplicate the
      // ledger row (idempotent on (entity_id, kind, ref)).
      const id = db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "Test",
        body: "Body",
        participants: ["Alice"],
        refs: ["feed:1"],
      });

      const { recordChronicleCitation } = require("../src/agent/standing");
      const resolver = (name: string) => engine.entities.findAgentByName(name)?.id;
      recordChronicleCitation(db, { id, kind: "narrative", participants: ["Alice"] }, resolver);
      recordChronicleCitation(db, { id, kind: "narrative", participants: ["Alice"] }, resolver);

      const ledger = db.ledgerForEntity(alice.id, 10);
      const chronicled = ledger.filter((r) => r.kind === "chronicled");
      expect(chronicled).toHaveLength(1);
    });

    it("silently skips unresolvable participants", () => {
      const { recordChronicleCitation } = require("../src/agent/standing");
      const id = db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "ghost",
        participants: ["Phantom"],
        refs: ["feed:1"],
      });
      // No error even when the resolver returns undefined
      expect(() =>
        recordChronicleCitation(
          db,
          { id, kind: "narrative", participants: ["Phantom"] },
          () => undefined,
        ),
      ).not.toThrow();
    });
  });

  describe("newcomer arrival digest", () => {
    // The bootstrap fires from the brief command on the first compass tick;
    // engine.sendBrief() invokes it directly for testing.
    function loginAndBrief(name: string, connId: string): MockConnection {
      const c = new MockConnection(connId);
      engine.addConnection(c);
      const result = engine.login(connId, name);
      if ("error" in result) throw new Error(result.error);
      c.clear();
      engine.sendBrief(result.entityId);
      return c;
    }

    it("includes recent chronicle entries in the first-login bootstrap", () => {
      db.appendChronicle({
        kind: "narrative",
        source: "chronicler",
        title: "The polity learned to coordinate",
        refs: ["feed:1"],
      });
      db.appendChronicle({
        kind: "digest",
        source: "chronicler",
        title: "Day in review",
        refs: ["feed:1"],
        period: "day:2026-05-18",
      });

      const newConn = loginAndBrief("Newbie", "c-newbie");
      const allText = newConn.allText().map(stripAnsi).join("\n---\n");
      expect(allText).toContain("Welcome to Marina");
      expect(allText).toContain("Recent chronicle:");
      expect(allText).toContain("The polity learned to coordinate");
      expect(allText).toContain("Day in review");
    });

    it("omits the arrival digest section when chronicle is empty", () => {
      const newConn = loginAndBrief("EmptyNewbie", "c-empty");
      const allText = newConn.allText().map(stripAnsi).join("\n---\n");
      expect(allText).toContain("Welcome to Marina");
      expect(allText).not.toContain("Recent chronicle:");
    });

    it("omits the arrival digest section when only events exist", () => {
      db.appendChronicle({
        kind: "event",
        source: "task_approved",
        title: "Some task done",
      });
      const newConn = loginAndBrief("EventOnly", "c-eventonly");
      const allText = newConn.allText().map(stripAnsi).join("\n---\n");
      expect(allText).not.toContain("Recent chronicle:");
    });
  });
});
