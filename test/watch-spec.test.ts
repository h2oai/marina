// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import {
  createWatchNote,
  ensureWatchesPool,
  getActiveWatch,
  listActiveWatches,
  parseRetirement,
  parseSpec,
  renderRetirement,
  renderSpec,
  retireWatchNote,
  type WatchSpec,
} from "../src/resolvers/watch-spec";
import { cleanupDb } from "./helpers";

const TEST_DB = `/tmp/marina-watch-spec-${process.pid}.db`;

function makeSpec(overrides: Partial<WatchSpec> = {}): WatchSpec {
  return {
    kind: "resolving",
    id: "kalshi/KXFED-26MAR",
    args: { venue: "kalshi", ticker: "KXFED-26MAR" },
    cadence: { kind: "interval", ms: 3_600_000 },
    retirement: { kind: "resolved" },
    notify: "bettor",
    createdBy: "alice",
    createdAt: Date.parse("2026-05-07T18:00:00Z"),
    ...overrides,
  };
}

describe("parseRetirement", () => {
  function rule(input: string | undefined) {
    const r = parseRetirement(input);
    if (!r.ok) throw new Error(r.error);
    return r.rule;
  }

  it("defaults to until-resolved when missing", () => {
    expect(rule(undefined)).toEqual({ kind: "resolved" });
  });

  it("recognises resolved / forever", () => {
    expect(rule("resolved")).toEqual({ kind: "resolved" });
    expect(rule("forever")).toEqual({ kind: "forever" });
  });

  it("parses sample-count as a positive integer", () => {
    expect(rule("5")).toEqual({ kind: "samples", n: 5 });
  });

  it("parses durations matching the cadence syntax", () => {
    expect(rule("7d")).toEqual({ kind: "duration", ms: 7 * 86_400_000 });
  });

  it("rejects hyphens / underscores", () => {
    expect(parseRetirement("until-resolved").ok).toBe(false); // user input form
    expect(parseRetirement("after_5").ok).toBe(false);
  });

  it("rejects zero or negative counts", () => {
    expect(parseRetirement("0").ok).toBe(false);
  });
});

describe("renderRetirement (storage form)", () => {
  it("renders all four kinds in human-readable form", () => {
    expect(renderRetirement({ kind: "resolved" })).toBe("until-resolved");
    expect(renderRetirement({ kind: "forever" })).toBe("forever");
    expect(renderRetirement({ kind: "samples", n: 5 })).toBe("after 5 samples");
    expect(renderRetirement({ kind: "duration", ms: 86_400_000 })).toBe("after 1d");
  });
});

describe("renderSpec / parseSpec round-trip", () => {
  it("serializes the canonical fields and re-parses identically", () => {
    const spec = makeSpec();
    const rendered = renderSpec(spec);
    expect(rendered).toContain("[watch:resolving kalshi/KXFED-26MAR]");
    expect(rendered).toContain("cadence: every 1h");
    expect(rendered).toContain("retirement: until-resolved");
    expect(rendered).toContain("notify: bettor");

    const parsed = parseSpec(rendered);
    expect(parsed?.kind).toBe("resolving");
    expect(parsed?.id).toBe("kalshi/KXFED-26MAR");
    expect(parsed?.cadence).toEqual({ kind: "interval", ms: 3_600_000 });
    expect(parsed?.retirement).toEqual({ kind: "resolved" });
    expect(parsed?.notify).toBe("bettor");
    expect(parsed?.args).toEqual({ venue: "kalshi", ticker: "KXFED-26MAR" });
  });

  it("preserves once cadence and forever retirement", () => {
    const spec = makeSpec({
      cadence: { kind: "once" },
      retirement: { kind: "forever" },
      notify: undefined,
    });
    const parsed = parseSpec(renderSpec(spec));
    expect(parsed?.cadence).toEqual({ kind: "once" });
    expect(parsed?.retirement).toEqual({ kind: "forever" });
    expect(parsed?.notify).toBeUndefined();
  });

  it("returns undefined for malformed content", () => {
    expect(parseSpec("not a watch")).toBeUndefined();
    expect(parseSpec("[watch:resolving kalshi/KXFED]\nargs: {bad json")).toBeUndefined();
  });
});

describe("watch DB helpers (pool + active/retired filtering)", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("ensureWatchesPool is idempotent and returns the same id", () => {
    const id1 = ensureWatchesPool(db);
    const id2 = ensureWatchesPool(db);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("createWatchNote writes a note in the watches pool", () => {
    const noteId = createWatchNote(db, makeSpec(), "alice");
    expect(noteId).toBeGreaterThan(0);
    const list = listActiveWatches(db);
    expect(list).toHaveLength(1);
    expect(list[0]?.spec.id).toBe("kalshi/KXFED-26MAR");
  });

  it("getActiveWatch returns the spec by note id", () => {
    const noteId = createWatchNote(db, makeSpec(), "alice");
    const w = getActiveWatch(db, noteId);
    expect(w?.spec.kind).toBe("resolving");
  });

  it("retireWatchNote excludes the spec from listActiveWatches", () => {
    const noteId = createWatchNote(db, makeSpec(), "alice");
    expect(listActiveWatches(db)).toHaveLength(1);
    retireWatchNote(db, noteId, "alice", "test cleanup");
    expect(listActiveWatches(db)).toHaveLength(0);
    expect(getActiveWatch(db, noteId)).toBeUndefined();
  });

  it("multiple active specs accumulate; retiring one keeps the others active", () => {
    const a = createWatchNote(db, makeSpec({ id: "kalshi/A" }), "alice");
    createWatchNote(db, makeSpec({ id: "kalshi/B" }), "alice");
    createWatchNote(db, makeSpec({ id: "kalshi/C" }), "alice");
    expect(listActiveWatches(db)).toHaveLength(3);
    retireWatchNote(db, a, "alice");
    const active = listActiveWatches(db);
    expect(active).toHaveLength(2);
    expect(active.map((w) => w.spec.id).sort()).toEqual(["kalshi/B", "kalshi/C"]);
  });
});
