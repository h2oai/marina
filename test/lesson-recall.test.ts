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
import { grant } from "../src/engine/safety-gates";
import { forecastLessonsFor } from "../src/learning/forecast-bridge";
import { type Lesson, memoryLessonSink } from "../src/learning/outcomes";
import {
  disableOutcomeLearning,
  enableOutcomeLearning,
  findLessons,
  LESSONS_ACCOUNT,
  lessonSinkFor,
  lessonsBlock,
  lessonsRun,
  recallAcross,
  recallLessons,
  retireLessons,
  supersedeLesson,
} from "../src/learning/service";
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

  it("never creates the lessons account or a space when recalling unarmed", async () => {
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

  it("recalls forecast + arena lessons from the one pool under one budget", async () => {
    const store = forecastLessonsFor(undefined, { sink, env: ON });
    const got = await store.recall("election", "2026-09-30T00:00:00.000Z");
    expect(got.map((l) => l.id)).toEqual(expect.arrayContaining(["g1", "a1"]));
    expect(got.every((l) => !l.observed)).toBe(true);
    const capped = await store.recall("election", "2026-09-30T00:00:00.000Z", { limit: 1 });
    expect(capped.length).toBe(1);
  });

  it("observe returns the lessons marked observed (recorded, never injected); off nothing", async () => {
    const observed = await forecastLessonsFor(undefined, { sink, env: OBSERVE }).recall(
      "election",
      "2026-09-30T00:00:00.000Z",
    );
    expect(observed.length).toBe(2);
    expect(observed.every((l) => l.observed === true)).toBe(true);
    const off = forecastLessonsFor(undefined, { sink, env: OFF });
    expect(await off.recall("election", "2026-09-30T00:00:00.000Z")).toEqual([]);
  });

  it("reads the durable pool on a database without arming learning (P1-11)", async () => {
    const db = freshDb();
    try {
      await lessonSinkFor(db).write(
        lesson("", "forecast", "election turnout models miss late deciders", { id: undefined }),
      );
      disableOutcomeLearning(db);
      const got = await forecastLessonsFor(db, { env: ON }).recall(
        "election turnout",
        "2026-09-30T00:00:00.000Z",
      );
      expect(got.map((l) => l.text)).toEqual(["election turnout models miss late deciders"]);
      // The leakage rule still holds on the durable path.
      expect(
        await forecastLessonsFor(db, { env: ON }).recall(
          "election turnout",
          "2026-08-30T00:00:00.000Z",
        ),
      ).toEqual([]);
    } finally {
      db.close();
    }
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

describe("retired lessons (validity closed, history kept)", () => {
  it("the in-process sink stops serving a retired lesson and keeps it in its history", async () => {
    const sink = memoryLessonSink([
      lesson("m1", "code", "pin the lockfile before a flaky install"),
      lesson("m2", "code", "rerun the flaky install once before failing"),
    ]);
    const found = await findLessons({} as MarinaDB, ["code"], { match: "lockfile" }, { sink });
    expect(found.map((l) => l.id)).toEqual(["m1"]);
    const r = await retireLessons({} as MarinaDB, found, { reason: "wrong", by: "u1" }, { sink });
    expect(r.retired.map((l) => l.id)).toEqual(["m1"]);
    const got = await recallLessons(undefined, "code", "flaky install", { env: ON, sink });
    expect(got.recalled.map((l) => l.id)).toEqual(["m2"]);
    expect(sink.all().map((l) => l.id)).toEqual(["m1", "m2"]);
    expect(sink.retirements().get("m1")).toEqual({ reason: "wrong", by: "u1" });
    // Retiring twice is refused, not repeated.
    const again = await retireLessons({} as MarinaDB, found, { reason: "x", by: "u1" }, { sink });
    expect(again.failed).toHaveLength(1);
  });

  it("the durable sink never recalls a retired lesson, and retired ones never take its slots", async () => {
    const db = freshDb();
    try {
      const sink = lessonSinkFor(db);
      const at = "2026-09-01T00:00:00.000Z";
      // 55 retired lessons that match the query better than the live one: the
      // durable recall searches 50 deep, so without the search-layer filter
      // they would take every slot.
      for (let i = 0; i < 55; i++)
        await sink.write(
          lesson(`x${i}`, "tools", `retry retry retry the order api call, variant ${i}`, {
            source: "tools:bad-run",
            resolvedAt: at,
          }),
        );
      const live = await sink.write(
        lesson("live", "tools", "check the order api status page before you retry a call"),
      );
      const bad = await findLessons(db, ["tools"], { source: "tools:bad-run" }, { sink });
      expect(bad).toHaveLength(55);
      const r = await retireLessons(db, bad, { reason: "bad run", by: "curator" }, { sink });
      expect(r.retired).toHaveLength(55);
      expect(r.failed).toEqual([]);

      const got = await recallLessons(db, "tools", "retry the order api call", { env: ON, sink });
      expect(got.recalled.map((l) => l.id)).toEqual([live.id]);
      expect(await findLessons(db, ["tools"], { source: "tools:bad-run" }, { sink })).toEqual([]);

      // History: the retired version carries the retirement; the original is readable.
      const run = lessonsRun(db);
      const spaces = (await run({ operation: "spaces" })).result as {
        spaces: Array<{ id: string; name: string }>;
      };
      const space_id = spaces.spaces.find((s) => s.name === "lessons:tools")!.id;
      const cur = (await run({ operation: "get", space_id, id: bad[0]!.id! })).result as {
        version: number;
        metadata: Record<string, unknown>;
        valid_time: { until: number | null };
      };
      expect(cur.metadata.retired_reason).toBe("bad run");
      expect(cur.metadata.retired_by).toBe("curator");
      expect(cur.valid_time.until).not.toBeNull();
      const first = (
        await run({ operation: "get", space_id, id: bad[0]!.id!, input: { version: 1 } })
      ).result as { content: string; metadata: Record<string, unknown> };
      expect(first.content).toContain("retry retry retry");
      expect(first.metadata.retired_reason).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("supersede writes an unverified replacement and retires the original with a pointer", async () => {
    const db = freshDb();
    try {
      const sink = lessonSinkFor(db);
      const old = await sink.write(
        lesson("o", "benchmark", "always use temperature zero for the math benchmark"),
      );
      const [found] = await findLessons(db, ["benchmark"], { id: old.id! }, { sink });
      const next = await supersedeLesson(
        db,
        found!,
        "use temperature zero for math, but sample three runs for the hard split",
        { reason: "refined", by: "curator" },
        { sink },
      );
      expect(next.trust).toBe("unverified");
      expect(next.source).toBe(`supersede:${old.id}`);
      expect(next.resolvedAt).toBe(found!.resolvedAt);
      const got = await recallLessons(db, "benchmark", "temperature math benchmark", {
        env: ON,
        sink,
      });
      expect(got.recalled.map((l) => l.id)).toEqual([next.id]);
      const run = lessonsRun(db);
      const spaces = (await run({ operation: "spaces" })).result as {
        spaces: Array<{ id: string; name: string }>;
      };
      const space_id = spaces.spaces.find((s) => s.name === "lessons:benchmark")!.id;
      const cur = (await run({ operation: "get", space_id, id: old.id! })).result as {
        metadata: Record<string, unknown>;
      };
      expect(cur.metadata.superseded_by).toBe(next.id);
    } finally {
      db.close();
    }
  });
});

describe("lessons retire / supersede command", () => {
  function run(db: MarinaDB, args: string): Promise<string> {
    const out: string[] = [];
    const ctx = { send: (_e: EntityId, msg: string) => out.push(msg) } as unknown as RoomContext;
    return Promise.resolve(
      lessonsCommand({ db }).handler(ctx, {
        entity: "e_cur" as EntityId,
        verb: "lessons",
        args,
        tokens: args.split(" ").filter(Boolean),
        raw: `lessons ${args}`,
      } as never),
    ).then(() => out.join("\n"));
  }

  it("needs role.edit, previews criteria until confirm:yes, and stops recall", async () => {
    const db = freshDb();
    try {
      enableOutcomeLearning(db, { writer: null, judge: null, env: ON });
      const sink = lessonSinkFor(db);
      const a = await sink.write(lesson("a", "code", "squash migrations before a release"));
      await sink.write(lesson("b", "code", "never squash migrations that already shipped"));
      const before = await recallAcross(db, ["code"], "squash migrations", { env: ON });
      expect(before.recalled).toHaveLength(2);

      expect(await run(db, `retire ${a.id}`)).toContain("reason is required");
      expect(await run(db, `retire ${a.id} reason:wrong advice`)).toContain(
        "change an existing role or trait",
      );
      expect(await run(db, "retire squash reason:x")).toContain("No current lesson");

      grant(db, "e_cur", "role.edit");
      expect(await run(db, "retire match:squash reason:audit")).toContain(
        "2 lesson(s) would be retired",
      );
      const out = await run(db, `retire ${a.id!.slice(0, 8)} domain:code reason:wrong advice`);
      expect(out).toContain("Retired 1 lesson(s)");
      const after = await recallAcross(db, ["code"], "squash migrations", { env: ON });
      expect(after.recalled.map((l) => l.text)).toEqual([
        "never squash migrations that already shipped",
      ]);
      expect(await run(db, `retire ${a.id} reason:again`)).toContain("No current lesson");

      const sup = await run(
        db,
        "supersede " +
          after.recalled[0]!.id +
          " reason:clarify -- never squash migrations that already shipped to any environment",
      );
      expect(sup).toContain("Superseded");
      const last = await recallAcross(db, ["code"], "squash migrations", { env: ON });
      expect(last.recalled.map((l) => l.text)).toEqual([
        "never squash migrations that already shipped to any environment",
      ]);
      disableOutcomeLearning(db);
    } finally {
      db.close();
    }
  });
});
