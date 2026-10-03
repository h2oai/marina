// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Recall of judged outcome lessons (src/learning/): the shared budget across
 * domains, the leakage rule, MARINA_LESSONS modes, inertness when learning is
 * not armed, the forecaster bridge and the `lessons` command.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lessonsCommand } from "../src/engine/commands/lessons";
import type { ForecastLesson, LessonStore } from "../src/forecast/lessons";
import { forecastLessonsFor } from "../src/learning/forecast-bridge";
import { type Lesson, memoryLessonSink } from "../src/learning/outcomes";
import {
  disableOutcomeLearning,
  enableOutcomeLearning,
  LESSONS_ACCOUNT,
  lessonsBlock,
  recallAcross,
  recallLessons,
} from "../src/learning/service";
import { withLessons } from "../src/net/model-api/verify";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId, RoomContext } from "../src/types";

const lesson = (id: string, domain: Lesson["domain"], text: string, over: Partial<Lesson> = {}) =>
  ({
    id,
    domain,
    text,
    kind: "failure",
    trust: "trusted",
    resolvedAt: "2026-09-01T00:00:00.000Z",
    source: `${domain}:test`,
    ...over,
  }) satisfies Lesson;

const ON = { MARINA_LESSONS: "on" } as NodeJS.ProcessEnv;
const OBSERVE = { MARINA_LESSONS: "observe" } as NodeJS.ProcessEnv;
const OFF = { MARINA_LESSONS: "off" } as NodeJS.ProcessEnv;

const dirs: string[] = [];
function freshDb(): MarinaDB {
  const dir = mkdtempSync(join(tmpdir(), "lesson-recall-"));
  dirs.push(dir);
  return new MarinaDB(join(dir, "m.db"));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("withLessons", () => {
  const msgs = [
    { role: "system", content: "rules" },
    { role: "system", content: "more rules" },
    { role: "user", content: "hi" },
  ];
  it("inserts one system message after the caller's leading system messages", () => {
    const out = withLessons(msgs, "LESSONS: x");
    expect(out.map((m) => m.content)).toEqual(["rules", "more rules", "LESSONS: x", "hi"]);
    expect(msgs.length).toBe(3); // never mutates the caller's array
  });
  it("is the identity for an empty block and appends when no user turn exists", () => {
    expect(withLessons(msgs, "")).toBe(msgs);
    expect(withLessons([{ role: "system", content: "s" }], "L").map((m) => m.content)).toEqual([
      "s",
      "L",
    ]);
  });
});

describe("recallAcross", () => {
  const sink = memoryLessonSink([
    lesson("t1", "tools", "confirm the order id before you cancel an order"),
    lesson("c1", "code", "run the order cancel tests before you claim the order fix", {
      resolvedAt: "2026-09-05T00:00:00.000Z",
    }),
    lesson("f1", "forecast", "order book depth shifts slowly", {
      resolvedAt: "2026-09-20T00:00:00.000Z",
    }),
    lesson("u1", "tools", "cancel order flows need an explicit yes", { trust: "unverified" }),
    lesson("r1", "tools", "cancel order rejected lesson", { trust: "rejected" }),
  ]);

  it("merges domains under one limit and byte budget, trusted first, rejected never", async () => {
    const got = await recallAcross(undefined, ["tools", "code"], "cancel order", {
      sink,
      env: ON,
      asOf: "2026-09-30T00:00:00.000Z",
      limit: 3,
    });
    const ids = got.recalled.map((l) => l.id);
    expect(ids).toContain("t1");
    expect(ids).toContain("c1");
    expect(ids).not.toContain("r1");
    expect(ids.indexOf("u1")).toBe(ids.length - 1); // unverified after trusted
    expect(got.inject).toEqual(got.recalled);
    const tight = await recallAcross(undefined, ["tools", "code"], "cancel order", {
      sink,
      env: ON,
      asOf: "2026-09-30T00:00:00.000Z",
      maxBytes: 60,
    });
    expect(tight.recalled.length).toBe(1);
  });

  it("applies the leakage rule: nothing resolved after asOf is served", async () => {
    const got = await recallAcross(undefined, ["tools", "code", "forecast"], "order", {
      sink,
      env: ON,
      asOf: "2026-09-02T00:00:00.000Z",
    });
    const ids = got.recalled.map((l) => l.id);
    expect(ids).not.toContain("c1");
    expect(ids).not.toContain("f1");
    expect(ids).toContain("t1");
  });

  it("observe recalls without injecting; off recalls nothing", async () => {
    const observed = await recallAcross(undefined, ["tools"], "cancel order", {
      sink,
      env: OBSERVE,
    });
    expect(observed.mode).toBe("observe");
    expect(observed.recalled.length).toBeGreaterThan(0);
    expect(observed.inject).toEqual([]);
    const off = await recallAcross(undefined, ["tools"], "cancel order", { sink, env: OFF });
    expect(off).toEqual({ inject: [], recalled: [], mode: "off" });
  });

  it("is inert when learning is not armed: no account or space is created", async () => {
    const db = freshDb();
    try {
      const got = await recallLessons(db, "code", "anything", { env: ON });
      expect(got.recalled).toEqual([]);
      expect(db.getUserByName(LESSONS_ACCOUNT)).toBeFalsy();
    } finally {
      db.close();
    }
  });

  it("formats a block with unverified lessons labelled", () => {
    const block = lessonsBlock([
      lesson("a", "code", "rule a"),
      lesson("b", "code", "rule b", { trust: "unverified" }),
    ]);
    expect(block).toStartWith("LESSONS (from past outcomes");
    expect(block).toContain("- rule a");
    expect(block).toContain("rule b (unverified)");
    expect(lessonsBlock([])).toBe("");
  });
});

describe("forecastLessonsFor", () => {
  const sink = memoryLessonSink([
    lesson("g1", "forecast", "election polls overstate incumbents early"),
    lesson("a1", "arena", "election approval series move slowly week to week"),
  ]);
  const legacyLesson: ForecastLesson = {
    id: "old-1",
    text: "election markets lag polls by a day",
    answerType: "choice",
    resolvedAt: "2026-08-01T00:00:00.000Z",
  };
  const written: ForecastLesson[] = [];
  const legacy: LessonStore = {
    async write(l) {
      written.push(l);
      return { id: "w" };
    },
    async recall() {
      return [legacyLesson];
    },
  };

  it("merges general forecast + arena lessons with the legacy store", async () => {
    const store = forecastLessonsFor(undefined, { sink, legacy, env: ON });
    const got = await store.recall("election", "2026-09-30T00:00:00.000Z");
    expect(got.map((l) => l.id)).toEqual(expect.arrayContaining(["g1", "a1", "old-1"]));
    const capped = await store.recall("election", "2026-09-30T00:00:00.000Z", { limit: 1 });
    expect(capped.length).toBe(1);
  });

  it("injects nothing under observe or off, and writes only to the legacy store", async () => {
    for (const env of [OBSERVE, OFF]) {
      const store = forecastLessonsFor(undefined, { sink, legacy, env });
      expect(await store.recall("election", "2026-09-30T00:00:00.000Z")).toEqual([]);
    }
    const store = forecastLessonsFor(undefined, { sink, legacy, env: ON });
    await store.write(legacyLesson);
    expect(written).toEqual([legacyLesson]);
    expect(sink.all().length).toBe(2);
  });
});

describe("lessons command", () => {
  function run(db: MarinaDB | undefined, args: string): Promise<string[]> {
    const out: string[] = [];
    const ctx = { send: (_e: EntityId, msg: string) => out.push(msg) } as unknown as RoomContext;
    const tokens = args.split(" ").filter(Boolean);
    return Promise.resolve(
      lessonsCommand({ db }).handler(ctx, {
        entity: "e_1" as EntityId,
        verb: "lessons",
        args,
        tokens,
        raw: `lessons ${args}`,
      } as never),
    ).then(() => out);
  }

  it("lists armed lessons for a topic and validates the domain", async () => {
    const db = freshDb();
    try {
      const sink = memoryLessonSink([lesson("k1", "code", "rerun flaky pytest cases once")]);
      enableOutcomeLearning(db, { sink, writer: null, judge: null, env: ON });
      const out = await run(db, "pytest domain:code");
      expect(out.join("\n")).toContain("rerun flaky pytest cases once");
      expect((await run(db, "pytest domain:nope")).join("\n")).toContain("Unknown domain");
      expect((await run(db, "")).join("\n")).toContain("Usage:");
      expect((await run(db, "kubernetes")).join("\n")).toContain("No lessons");
      disableOutcomeLearning(db);
    } finally {
      db.close();
    }
  });

  it("needs persistence", async () => {
    expect((await run(undefined, "x")).join("\n").length).toBeGreaterThan(0);
  });
});
