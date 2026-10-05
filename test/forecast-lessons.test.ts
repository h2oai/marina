// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forecasts and the one lesson pool (`src/learning`): what reaches a typed
 * forecast (on / observe / off, the leakage rule), the FutureX settlement
 * margin (no same-end-time leak in a replay), the bridge from the retired
 * forecast-lesson store, and lessons retired with an invalidated ledger run.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FuturexRow } from "../benchmarks/futurex/dataset";
import {
  futurexOutcome,
  futurexResolvedAt,
  SETTLEMENT_MARGIN_MS,
} from "../benchmarks/futurex/lessons";
import { endTimeIso, requestFor } from "../benchmarks/futurex/map";
import type { Retriever } from "../src/arena/research/retrieve";
import type { AnswerSpec } from "../src/forecast/answer-types";
import { LEGACY_LESSON_SUBJECT } from "../src/forecast/lessons";
import { forecastTyped, type ModelPart } from "../src/forecast/typed";
import { forecastLessonsFor } from "../src/learning/forecast-bridge";
import { retireLessonsForRun } from "../src/learning/intake";
import {
  LEGACY_FORECAST_ACCOUNT,
  LEGACY_FORECAST_OWNER,
  LEGACY_LESSON_SOURCE,
  migrateLegacyForecastLessons,
} from "../src/learning/legacy-forecast";
import {
  type Lesson,
  type LessonWriter,
  memoryLessonSink,
  recordOutcome,
} from "../src/learning/outcomes";
import { findLessons, lessonSinkFor } from "../src/learning/service";
import { durableLessonSink } from "../src/learning/store";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";

const ON = { MARINA_LESSONS: "on" } as NodeJS.ProcessEnv;
const OBSERVE = { MARINA_LESSONS: "observe" } as NodeJS.ProcessEnv;
const OFF = { MARINA_LESSONS: "off" } as NodeJS.ProcessEnv;

const choice: AnswerSpec = {
  type: "choice",
  options: [
    { id: "A", label: "Home win" },
    { id: "B", label: "Away win" },
  ],
};

const lesson = (text: string, resolvedAt: string, over: Partial<Lesson> = {}): Lesson => ({
  domain: "forecast",
  text,
  kind: "failure",
  trust: "trusted",
  resolvedAt,
  source: "forecast:test",
  ...over,
});

const empty: Retriever = async () => ({
  report: "",
  sources: [],
  costUsd: 0,
  searches: 0,
  retriever: "none",
});

const dirs: string[] = [];
function freshDb(): MarinaDB {
  const dir = mkdtempSync(join(tmpdir(), "forecast-lessons-"));
  dirs.push(dir);
  return new MarinaDB(join(dir, "m.db"));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** One typed forecast with a recording analyst; returns the answer and every prompt. */
async function forecastWith(
  lessons: ReturnType<typeof forecastLessonsFor>,
  req: Parameters<typeof forecastTyped>[0],
) {
  const seen: string[] = [];
  const analyst: ModelPart = {
    name: "a",
    complete: async (_s, user) => {
      seen.push(user);
      return '{"answer":"A","confidence":0.6,"reason":"base rate"}';
    },
  };
  const out = await forecastTyped(req, {
    retriever: empty,
    analysts: [analyst],
    lessons,
    options: { runs: 1, critique: false, researchRounds: 1, plan: false },
    now: () => new Date("2026-10-01T00:00:00.000Z"),
  });
  return { out, prompt: seen.join("\n") };
}

describe("typed forecasts recall the lesson pool", () => {
  const sink = memoryLessonSink([
    lesson("football match winner: weight home advantage", "2026-09-01T00:00:00.000Z"),
    lesson("football match winner: LATER LESSON", "2026-09-25T00:00:00.000Z"),
  ]);
  const req = {
    question: "Football match winner: home or away?",
    answer: choice,
    endTime: "2026-09-22T00:00:00.000Z",
    asOf: "2026-09-15T00:00:00.000Z",
  };

  it("on: only lessons known at the cutoff reach the prompt, and are recorded", async () => {
    const { out, prompt } = await forecastWith(
      forecastLessonsFor(undefined, { sink, env: ON }),
      req,
    );
    expect(out.lessons?.map((l) => l.text)).toEqual([
      "football match winner: weight home advantage",
    ]);
    expect(out.observedLessons).toBeUndefined();
    expect(prompt).toContain("weight home advantage");
    expect(prompt).not.toContain("LATER LESSON");
  });

  it("observe: the lessons are recorded on the answer and never shown to a model", async () => {
    const { out, prompt } = await forecastWith(
      forecastLessonsFor(undefined, { sink, env: OBSERVE }),
      req,
    );
    expect(out.observedLessons?.map((l) => l.text)).toEqual([
      "football match winner: weight home advantage",
    ]);
    expect(out.lessons).toEqual([]);
    expect(prompt).not.toContain("weight home advantage");
  });

  it("off: nothing is recalled", async () => {
    const { out, prompt } = await forecastWith(
      forecastLessonsFor(undefined, { sink, env: OFF }),
      req,
    );
    expect(out.lessons ?? []).toEqual([]);
    expect(out.observedLessons).toBeUndefined();
    expect(prompt).not.toContain("home advantage");
  });

  it("a verifier correction replaces the run's draft before combining", async () => {
    const analyst: ModelPart = {
      name: "a",
      complete: async () => '{"answer":"B","confidence":0.6,"reason":"guess"}',
    };
    const verifier: ModelPart = {
      name: "v",
      complete: async () =>
        '{"verdict":"correct","answer":"A","reason":"the rules count a draw as home"}',
    };
    const out = await forecastTyped(
      { question: "Home or away?", answer: choice },
      {
        retriever: empty,
        analysts: [analyst],
        verifier,
        options: { runs: 2, critique: false, researchRounds: 1, plan: false, verify: true },
      },
    );
    expect(out.formatted).toBe("A");
    expect(
      out.runs.every((r) => r.verified?.verdict === "correct" && r.verified.draft === "B"),
    ).toBe(true);
  });
});

describe("FutureX replay: no lesson leaks across rows that share an end time", () => {
  const row = (id: string, end: string): FuturexRow => ({
    id,
    level: 1,
    end_time: end,
    prompt: `Football match winner ${id}?\nA. Home win\nB. Away win`,
    en_title: `Football match winner ${id}?`,
    ground_truth: "['A']",
  });
  const writer: LessonWriter = {
    name: "w",
    complete: async () => '{"category":"football match winner","rule":"weight home advantage"}',
  };

  it("a sibling's lesson resolves after the shared end time, so a replay at that end time never sees it", async () => {
    const shared = "2026-09-20 12:00:00"; // UTC+8, as the dataset writes it
    const a = row("a", shared);
    const b = row("b", shared);
    const later = row("c", "2026-09-23 12:00:00");
    const resolvedAt = futurexResolvedAt(a)!;
    expect(Date.parse(resolvedAt) - Date.parse(endTimeIso(shared)!)).toBe(SETTLEMENT_MARGIN_MS);
    // Row a is scored and learned from.
    const sink = memoryLessonSink();
    await recordOutcome(
      { sink, writer },
      futurexOutcome({
        row: a,
        result: { id: "a", spec: "choice", prediction: "A", fallback: false },
        item: { score: 1, metric: "exact" },
        label: "cheap",
        resolvedAt,
      }),
    );
    expect(sink.all()).toHaveLength(1);
    const lessons = forecastLessonsFor(undefined, { sink, env: ON });
    // Row b, replayed: its cutoff is the shared end time (now is long after).
    const sibling = await forecastWith(lessons, requestFor(b));
    expect(sibling.out.cutoff.basis).toBe("endTime");
    expect(sibling.out.lessons).toEqual([]);
    expect(sibling.prompt).not.toContain("weight home advantage");
    // A row whose cutoff is after the settlement may use it.
    const next = await forecastWith(lessons, requestFor(later));
    expect(next.out.lessons?.length).toBe(1);
    expect(next.prompt).toContain("weight home advantage");
  });
});

describe("the retired forecast-lesson store, bridged into the pool", () => {
  async function seedLegacy(db: MarinaDB) {
    db.createUser({ id: crypto.randomUUID(), name: LEGACY_FORECAST_ACCOUNT });
    const run = (r: MemoryOperationRequest) =>
      residentMemoryOperation(db, LEGACY_FORECAST_ACCOUNT, r) as Promise<{
        ok: true;
        result: unknown;
      }>;
    const space = (await run({ operation: "create_space", input: { name: "forecast-lessons" } }))
      .result as { id: string };
    const written = (
      await run({
        operation: "remember",
        space_id: space.id,
        input: {
          content: "[lesson] choice · tennis match winner · rule: favour the higher seed",
          type: "inference",
          tier: "reflection",
          subject: LEGACY_LESSON_SUBJECT,
          metadata: {
            kind: LEGACY_LESSON_SUBJECT,
            resolved_at: "2026-09-01T00:00:00.000Z",
            answer_type: "choice",
            category: "tennis match winner",
            failure: "wrong option",
            score: 0,
            origin: "backtest",
          },
          valid_time: { from: Date.parse("2026-09-01T00:00:00.000Z"), until: null },
        },
      })
    ).result as { id?: string; record?: { id?: string } };
    return { spaceId: space.id, id: written.id ?? written.record?.id ?? "" };
  }

  it("copies each record as an unverified lesson with provenance, keeps the original, and frees the name", async () => {
    const db = freshDb();
    try {
      const legacy = await seedLegacy(db);
      const m = await migrateLegacyForecastLessons(db);
      expect(m).toMatchObject({ found: 1, copied: 1, failed: 0, renamed: true });
      expect(db.getUserByName(LEGACY_FORECAST_ACCOUNT)).toBeFalsy();
      expect(db.getUserByName(LEGACY_FORECAST_OWNER)).toBeTruthy();
      // Served from the pool, labelled, under the original resolution time.
      const store = forecastLessonsFor(db, { env: ON });
      const got = await store.recall("tennis match winner", "2026-09-10T00:00:00.000Z");
      expect(got.map((l) => l.text)).toEqual([
        "[lesson] choice · tennis match winner · rule: favour the higher seed (unverified)",
      ]);
      expect(await store.recall("tennis match winner", "2026-08-20T00:00:00.000Z")).toEqual([]);
      const [copy] = await findLessons(db, ["forecast"], { source: LEGACY_LESSON_SOURCE });
      expect(copy?.trust).toBe("unverified");
      expect(copy?.provenance).toMatchObject({ store: LEGACY_LESSON_SUBJECT, id: legacy.id });
      expect(copy?.refs).toEqual([`legacy-lesson:${legacy.id}`]);
      // The original stays readable under its (now server-owned) owner.
      const original = (
        await residentMemoryOperation(db, LEGACY_FORECAST_OWNER, {
          operation: "get",
          space_id: legacy.spaceId,
          id: legacy.id,
        })
      ).result as { content: string };
      expect(original.content).toContain("favour the higher seed");
      // Nothing left to do on a second run.
      expect((await migrateLegacyForecastLessons(db)).found).toBe(0);
    } finally {
      db.close();
    }
  });

  it("is idempotent per record: a re-run never writes a second copy", async () => {
    const db = freshDb();
    try {
      await seedLegacy(db);
      db.updateUserLastLogin(db.getUserByName(LEGACY_FORECAST_ACCOUNT)!.id);
      await Bun.sleep(5);
      db.updateUserLastLogin(db.getUserByName(LEGACY_FORECAST_ACCOUNT)!.id);
      // Someone logged in: the account keeps its name, and runs again find the same record.
      const first = await migrateLegacyForecastLessons(db);
      const second = await migrateLegacyForecastLessons(db);
      expect(first).toMatchObject({ copied: 1, renamed: false });
      expect(second).toMatchObject({ copied: 1, renamed: false });
      expect(db.getUserByName(LEGACY_FORECAST_ACCOUNT)).toBeTruthy();
      expect(await findLessons(db, ["forecast"], { source: LEGACY_LESSON_SOURCE })).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("an invalidated ledger run retires the lessons that cite it", () => {
  it("retires every current lesson with the run in its refs, with the reason recorded", async () => {
    const sink = memoryLessonSink([
      lesson("from run 1", "2026-09-01T00:00:00.000Z", { id: "l1", refs: ["bench:r1"] }),
      lesson("compared with run 1", "2026-09-01T00:00:00.000Z", {
        id: "l2",
        domain: "benchmark",
        refs: ["bench:r2", "bench:r1"],
      }),
      lesson("from run 2", "2026-09-01T00:00:00.000Z", { id: "l3", refs: ["bench:r2"] }),
    ]);
    const db = freshDb();
    try {
      const r = await retireLessonsForRun(
        db,
        "r1",
        { reason: "provider outage", by: "u1" },
        { sink },
      );
      expect(r.retired.map((l) => l.id).sort()).toEqual(["l1", "l2"]);
      expect(sink.retirements().get("l1")?.reason).toBe(
        "benchmark run r1 invalidated: provider outage",
      );
      expect(sink.retirements().has("l3")).toBe(false);
      // Retired lessons are never served again; the others are.
      expect(
        (await sink.recall("forecast", "from run", "2026-09-30T00:00:00.000Z")).map((l) => l.id),
      ).toEqual(["l3"]);
    } finally {
      db.close();
    }
  });

  it("retires on the durable pool too, and is a no-op when nothing cites the run", async () => {
    const db = freshDb();
    try {
      const sink = lessonSinkFor(db);
      await sink.write(
        lesson("durable lesson from run 9", "2026-09-01T00:00:00.000Z", { refs: ["bench:r9"] }),
      );
      expect((await retireLessonsForRun(db, "r8", { reason: "x", by: "u" })).retired).toEqual([]);
      const r = await retireLessonsForRun(db, "r9", { reason: "x", by: "u" });
      expect(r.retired).toHaveLength(1);
      expect(await findLessons(db, ["forecast"], { ref: "bench:r9" })).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("memory-service retries", () => {
  it("retries a busy store with the same request key, and gives up on other errors", async () => {
    const keys: Array<string | undefined> = [];
    let calls = 0;
    const sink = durableLessonSink(
      async (req) => {
        keys.push(req.key);
        calls++;
        if (calls < 3) throw Object.assign(new Error("busy"), { status: 503, retryAfterMs: 1 });
        return { ok: true as const, result: { id: "r1" } };
      },
      async () => "space-1",
      { sleep: async () => {} },
    );
    expect(await sink.write(lesson("x", "2026-09-01T00:00:00.000Z"))).toEqual({ id: "r1" });
    expect(calls).toBe(3);
    expect(new Set(keys).size).toBe(1);
    const failing = durableLessonSink(
      async () => {
        throw Object.assign(new Error("forbidden"), { status: 403 });
      },
      async () => "space-1",
      { sleep: async () => {} },
    );
    await expect(failing.write(lesson("x", "2026-09-01T00:00:00.000Z"))).rejects.toThrow(
      /forbidden/,
    );
  });
});
