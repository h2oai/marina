// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import type { Sample } from "../src/resolvers";
import { findLatestSample, parseSampleFromContent, writeSample } from "../src/resolvers";
import type { EngineEvent } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_sample_writer.db";

function makeSample(overrides: Partial<Sample> = {}): Sample {
  return {
    kind: "echoing",
    id: "smoke",
    ts: Date.now(),
    status: "changed",
    value: { hello: "world" },
    source: "echoing://local",
    ...overrides,
  };
}

describe("sample-writer", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("writes a fact-tier note for resolved status", () => {
    const events: EngineEvent[] = [];
    const { noteId, emittedFeedEvent } = writeSample({
      db,
      sample: makeSample({ status: "resolved" }),
      authorName: "alice",
      emitEvent: (e) => events.push(e),
    });
    expect(noteId).toBeGreaterThan(0);
    expect(emittedFeedEvent).toBe(true);
    const note = db.getNote(noteId)!;
    expect(note.tier).toBe("fact");
    expect(note.content).toContain("[sample:echoing smoke");
    expect(note.note_type).toBe("sample");
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("feed_event");
    if (ev.type === "feed_event") {
      expect(ev.kind).toBe("sample.resolved");
      expect(ev.ref).toBe("sample:echoing/smoke");
    }
  });

  it("writes a process-tier note for no-change and skips the feed", () => {
    const events: EngineEvent[] = [];
    const { noteId, emittedFeedEvent } = writeSample({
      db,
      sample: makeSample({ status: "no-change", value: undefined }),
      authorName: "alice",
      emitEvent: (e) => events.push(e),
    });
    const note = db.getNote(noteId)!;
    expect(note.tier).toBe("process");
    expect(emittedFeedEvent).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("writes a process-tier note for error and skips the feed", () => {
    const { noteId, emittedFeedEvent } = writeSample({
      db,
      sample: makeSample({
        status: "error",
        value: undefined,
        reason: "kalshi 503",
      }),
      authorName: "alice",
    });
    const note = db.getNote(noteId)!;
    expect(note.tier).toBe("process");
    expect(note.content).toContain("error: smoke — kalshi 503");
    expect(emittedFeedEvent).toBe(false);
  });

  it("links sample to watch spec via derived_from when watchSpecNoteId provided", () => {
    const specId = db.createNote("alice", "[watch:echoing smoke]\nspec note", undefined, {
      noteType: "watch",
    });
    const { noteId } = writeSample({
      db,
      sample: makeSample({ status: "resolved" }),
      authorName: "alice",
      watchSpecNoteId: specId,
    });
    const links = db.getNoteLinks(noteId);
    const derivedFrom = links.find((l) => l.relationship === "derived_from");
    expect(derivedFrom?.target_id).toBe(specId);
  });

  it("links sample to previous sample via supersedes when previousSampleNoteId provided", () => {
    const first = writeSample({
      db,
      sample: makeSample({ ts: 1000 }),
      authorName: "alice",
    });
    const second = writeSample({
      db,
      sample: makeSample({ ts: 2000 }),
      authorName: "alice",
      previousSampleNoteId: first.noteId,
    });
    const links = db.getNoteLinks(second.noteId);
    const supersedes = links.find((l) => l.relationship === "supersedes");
    expect(supersedes?.target_id).toBe(first.noteId);
  });

  it("findLatestSample returns the most recent sample for a (kind, id)", () => {
    writeSample({ db, sample: makeSample({ ts: 1000 }), authorName: "alice" });
    writeSample({ db, sample: makeSample({ ts: 2000 }), authorName: "alice" });
    const latest = findLatestSample(db, "echoing", "smoke");
    expect(latest).toBeDefined();
    expect(latest?.sample.ts).toBe(2000);
  });

  it("findLatestSample returns undefined for unknown (kind, id)", () => {
    expect(findLatestSample(db, "echoing", "nonexistent")).toBeUndefined();
  });

  it("parseSampleFromContent round-trips a written sample", () => {
    const original = makeSample({
      status: "resolved",
      ts: 1_700_000_000_000,
      value: { outcome: "yes", resolvedAt: "2026-05-07" },
      rawHash: "abc123",
    });
    const { noteId } = writeSample({ db, sample: original, authorName: "alice" });
    const note = db.getNote(noteId)!;
    const parsed = parseSampleFromContent(note.content);
    expect(parsed).toBeDefined();
    expect(parsed?.kind).toBe("echoing");
    expect(parsed?.id).toBe("smoke");
    expect(parsed?.status).toBe("resolved");
    expect(parsed?.ts).toBe(1_700_000_000_000);
    expect(parsed?.value).toEqual({ outcome: "yes", resolvedAt: "2026-05-07" });
    expect(parsed?.rawHash).toBe("abc123");
  });

  it("parseSampleFromContent returns undefined for malformed content", () => {
    expect(parseSampleFromContent("not a sample")).toBeUndefined();
    expect(parseSampleFromContent("[sample:echoing smoke 2026]\nno json")).toBeUndefined();
  });
});
