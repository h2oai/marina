// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Retriever } from "../src/arena/research/retrieve";
import type { AnswerSpec } from "../src/forecast/answer-types";
import {
  durableLessonStore,
  type ForecastLesson,
  failureMode,
  lessonFromOutcome,
  memoryLessonStore,
  selectLessons,
  visibleAt,
} from "../src/forecast/lessons";
import { forecastTyped, type ModelPart } from "../src/forecast/typed";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";

const choice: AnswerSpec = {
  type: "choice",
  options: [
    { id: "A", label: "Home win" },
    { id: "B", label: "Away win" },
  ],
};

const lesson = (text: string, resolvedAt: string): ForecastLesson => ({
  text,
  answerType: "choice",
  resolvedAt,
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("lesson visibility (the leakage rule)", () => {
  it("a lesson is visible only at or after the moment its outcome was known", () => {
    const l = lesson("x", "2026-09-10T00:00:00.000Z");
    expect(visibleAt(l, "2026-09-09T23:59:59.000Z")).toBe(false);
    expect(visibleAt(l, "2026-09-10T00:00:00.000Z")).toBe(true);
    expect(visibleAt(l, "2026-10-01T00:00:00.000Z")).toBe(true);
    expect(visibleAt({ resolvedAt: "not a date" }, "2026-10-01T00:00:00.000Z")).toBe(false);
  });

  it("selects visible lessons newest first, within the limit and byte budget", () => {
    const all = [
      lesson("old", "2026-09-01T00:00:00.000Z"),
      lesson("future", "2026-09-30T00:00:00.000Z"),
      lesson("mid", "2026-09-05T00:00:00.000Z"),
      lesson("x".repeat(500), "2026-09-04T00:00:00.000Z"),
    ];
    const got = selectLessons(all, "2026-09-20T00:00:00.000Z", { limit: 2 });
    expect(got.map((l) => l.text)).toEqual(["mid", "x".repeat(500)]);
    const tight = selectLessons(all, "2026-09-20T00:00:00.000Z", { maxBytes: 10 });
    expect(tight.map((l) => l.text)).toEqual(["mid"]);
  });

  it("the in-process store never returns a lesson from the forecast's future", async () => {
    const store = memoryLessonStore();
    await store.write(
      lesson(
        "[lesson] choice · football match winner · favour the home side",
        "2026-09-01T00:00:00.000Z",
      ),
    );
    await store.write(
      lesson(
        "[lesson] choice · football match winner · draws are rare",
        "2026-09-20T00:00:00.000Z",
      ),
    );
    const before = await store.recall("football match winner", "2026-09-10T00:00:00.000Z");
    expect(before.map((l) => l.text)).toEqual([
      "[lesson] choice · football match winner · favour the home side",
    ]);
    const after = await store.recall("football match winner", "2026-09-25T00:00:00.000Z");
    expect(after).toHaveLength(2);
  });

  it("the durable store writes canonical records and applies the same rule on recall", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marina-lessons-"));
    dirs.push(dir);
    const db = new MarinaDB(join(dir, "m.db"));
    try {
      db.createUser({ id: crypto.randomUUID(), name: "Forecaster" });
      const run = (r: MemoryOperationRequest) =>
        residentMemoryOperation(db, "Forecaster", r) as Promise<{ ok: true; result: unknown }>;
      const space = (
        await run({ operation: "create_space", input: { name: "forecast-lessons-t" } })
      ).result as { id: string };
      const store = durableLessonStore(run, { spaceId: space.id });
      const w = await store.write({
        ...lesson(
          "[lesson] choice · tennis match winner · rule: favour the higher seed",
          "2026-09-01T00:00:00.000Z",
        ),
        failure: "wrong option",
        score: 0,
      });
      expect(typeof w.id).toBe("string");
      await store.write(
        lesson(
          "[lesson] choice · tennis match winner · rule: upsets cluster on clay",
          "2026-09-15T00:00:00.000Z",
        ),
      );
      expect(await store.recall("tennis match winner", "2026-08-20T00:00:00.000Z")).toEqual([]);
      const mid = await store.recall("tennis match winner", "2026-09-10T00:00:00.000Z");
      expect(mid.map((l) => l.text)).toEqual([
        "[lesson] choice · tennis match winner · rule: favour the higher seed",
      ]);
      expect(mid[0]!.failure).toBe("wrong option");
      expect((await store.recall("tennis match winner", "2026-09-20T00:00:00.000Z")).length).toBe(
        2,
      );
      // Retired through `revise` (validity closed, history kept): never served again.
      const current = (await run({ operation: "get", space_id: space.id, id: w.id! })).result as {
        version: number;
        content: string;
        metadata: Record<string, unknown>;
        valid_time: { from: number | null };
      };
      await run({
        operation: "revise",
        space_id: space.id,
        id: w.id!,
        input: {
          expected_version: current.version,
          content: current.content,
          metadata: { ...current.metadata, retired_reason: "test" },
          valid_time: { from: current.valid_time.from, until: Date.now() - 1 },
        },
      });
      const after = await store.recall("tennis match winner", "2026-09-20T00:00:00.000Z");
      expect(after.map((l) => l.text)).toEqual([
        "[lesson] choice · tennis match winner · rule: upsets cluster on clay",
      ]);
    } finally {
      db.close();
    }
  });
});

describe("durable store under contention", () => {
  it("retries a busy store with the same request key, and gives up on other errors", async () => {
    const keys: Array<string | undefined> = [];
    let calls = 0;
    const store = durableLessonStore(
      async (req) => {
        keys.push(req.key);
        calls++;
        if (calls < 3) throw Object.assign(new Error("busy"), { status: 503, retryAfterMs: 1 });
        return { ok: true as const, result: { id: "r1" } };
      },
      { sleep: async () => {} },
    );
    expect(await store.write(lesson("x", "2026-09-01T00:00:00.000Z"))).toEqual({ id: "r1" });
    expect(calls).toBe(3);
    expect(new Set(keys).size).toBe(1);
    const failing = durableLessonStore(
      async () => {
        throw Object.assign(new Error("forbidden"), { status: 403 });
      },
      { sleep: async () => {} },
    );
    await expect(failing.write(lesson("x", "2026-09-01T00:00:00.000Z"))).rejects.toThrow(
      /forbidden/,
    );
  });
});

describe("lessons from outcomes", () => {
  it("names the failure mode mechanically", () => {
    const base = { question: "q", truth: "100", resolvedAt: "2026-09-01T00:00:00.000Z" };
    expect(failureMode({ ...base, answer: { type: "number" }, prediction: "100", score: 1 })).toBe(
      "hit",
    );
    expect(failureMode({ ...base, answer: { type: "number" }, prediction: "106", score: 0 })).toBe(
      "numeric over 6.0%",
    );
    expect(failureMode({ ...base, answer: choice, prediction: "B", truth: "A", score: 0 })).toBe(
      "wrong option",
    );
    expect(failureMode({ ...base, answer: { type: "text" }, prediction: "", score: 0 })).toBe(
      "no-answer",
    );
  });

  it("adds a category and rule from a writer, and survives a failing writer", async () => {
    const input = {
      question: "Who wins the match?",
      answer: choice,
      prediction: "B",
      truth: "A",
      score: 0,
      resolvedAt: "2026-09-01T00:00:00.000Z",
    };
    const writer: ModelPart = {
      name: "w",
      complete: async () => '{"category":"football match winner","rule":"Weight home advantage."}',
    };
    const l = await lessonFromOutcome(input, writer);
    expect(l.category).toBe("football match winner");
    expect(l.rule).toBe("Weight home advantage.");
    expect(l.text).toBe(
      "[lesson] choice · football match winner · score 0.00 (wrong option) · rule: Weight home advantage.",
    );
    expect(l.resolvedAt).toBe(input.resolvedAt);
    const broken = await lessonFromOutcome(input, {
      name: "w",
      complete: async () => {
        throw new Error("down");
      },
    });
    expect(broken.text).toBe("[lesson] choice · score 0.00 (wrong option)");
  });
});

describe("typed forecasts recall lessons", () => {
  const empty: Retriever = async () => ({
    report: "",
    sources: [],
    costUsd: 0,
    searches: 0,
    retriever: "none",
  });

  it("puts only lessons known at the cutoff in the prompt, and records them", async () => {
    const seen: string[] = [];
    const analyst: ModelPart = {
      name: "a",
      complete: async (_s, user) => {
        seen.push(user);
        return '{"answer":"A","confidence":0.6,"reason":"base rate"}';
      },
    };
    const store = memoryLessonStore([
      lesson(
        "[lesson] choice · football match winner · rule: weight home advantage",
        "2026-09-01T00:00:00.000Z",
      ),
      lesson(
        "[lesson] choice · football match winner · rule: LATER LESSON",
        "2026-09-25T00:00:00.000Z",
      ),
    ]);
    const out = await forecastTyped(
      {
        question: "Football match winner: home or away?",
        answer: choice,
        endTime: "2026-09-22T00:00:00.000Z",
        asOf: "2026-09-15T00:00:00.000Z",
      },
      {
        retriever: empty,
        analysts: [analyst],
        lessons: store,
        options: { runs: 1, critique: false, researchRounds: 1, plan: false },
        now: () => new Date("2026-10-01T00:00:00.000Z"),
      },
    );
    expect(out.lessons?.map((l) => l.text)).toEqual([
      "[lesson] choice · football match winner · rule: weight home advantage",
    ]);
    expect(seen.join("\n")).toContain("weight home advantage");
    expect(seen.join("\n")).not.toContain("LATER LESSON");
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
