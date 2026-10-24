// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { arenaLessonFilter } from "../src/arena/service";
import { type ForecastLesson, recallForecastLessons } from "../src/forecast/lessons";

const lesson = (text: string, origin?: string): ForecastLesson => ({
  text,
  resolvedAt: "2026-10-01T00:00:00Z",
  ...(origin ? { origin } : {}),
});

describe("arena lesson recall", () => {
  it("keeps only lessons from arena rounds of the same shape or this tracker's crew", () => {
    const scalar = arenaLessonFilter({
      tracker: "economist_yougov",
      target_type: "continuous_normal",
    });
    expect(scalar({ origin: "arena:number" })).toBe(true);
    expect(scalar({ origin: "arena:economist_yougov" })).toBe(true);
    expect(scalar({ origin: "arena:ranking" })).toBe(false);
    expect(scalar({ origin: "legacy:forecast-lesson" })).toBe(false);
    expect(scalar({ origin: "task:verdict" })).toBe(false);
    expect(scalar({})).toBe(false);
    const profile = arenaLessonFilter({ tracker: "civiqs", target_type: "profile_energy" });
    expect(profile({ origin: "arena:profile" })).toBe(true);
    expect(profile({ origin: "arena:number" })).toBe(false);
  });

  it("looks past unrelated top matches so the four slots go to relevant lessons", async () => {
    const ranked = [
      lesson("arXiv ranking rule", "legacy:forecast-lesson"),
      lesson("tools explanation rule", "task:verdict"),
      ...Array.from({ length: 5 }, (_, i) => lesson(`polling rule ${i}`, "arena:number")),
    ];
    let asked: { limit?: number } | undefined;
    const store = {
      async recall(_q: string, _asOf: string, opts?: { limit?: number }) {
        asked = opts;
        return ranked.slice(0, opts?.limit ?? 4);
      },
    };
    const accept = arenaLessonFilter({
      tracker: "economist_yougov",
      target_type: "continuous_normal",
    });
    const got = await recallForecastLessons(store, "q", "2026-10-24T00:00:00Z", "on", accept);
    expect(asked?.limit).toBe(16);
    expect(got.injected.map((l) => l.text)).toEqual([
      "polling rule 0",
      "polling rule 1",
      "polling rule 2",
      "polling rule 3",
    ]);
    // Without a filter: the old top-4, unchanged.
    const plain = await recallForecastLessons(store, "q", "2026-10-24T00:00:00Z", "on");
    expect(plain.injected.map((l) => l.text)[0]).toBe("arXiv ranking rule");
    expect(plain.injected).toHaveLength(4);
  });
});
