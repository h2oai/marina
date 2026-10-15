// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** The hard visual set is deterministic, valid, and its answers follow from the scene. */

import { describe, expect, it } from "bun:test";
import {
  HARD_FAMILY,
  HARD_KINDS,
  type HardTask,
  hardTasks,
  matchesSpec,
  type SpecScene,
  scoreHard,
} from "../benchmarks/vision-native/items-hard";
import { summarize } from "../benchmarks/vision-native/summary";
import { probeImage } from "../src/engine/media/image-ops";
import { AGENT_VIEW_IMAGE_LIMITS } from "../src/engine/media/vision";

const tasks = await hardTasks(3);
const byKind = (kind: string) => tasks.filter((t) => t.kind === kind);
const meta = <T>(t: HardTask) => t.meta as T;

describe("vision-native hard items", () => {
  it("covers every kind with unique ids and a family", () => {
    expect(tasks).toHaveLength(HARD_KINDS.length * 3);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    expect(new Set(Object.values(HARD_FAMILY)).size).toBeGreaterThanOrEqual(6);
    for (const kind of HARD_KINDS) expect(byKind(kind)).toHaveLength(3);
  });

  it("renders the same pixels and answers for the same seed", async () => {
    const again = await hardTasks(1);
    for (const t of again) {
      const first = tasks.find((x) => x.id === t.id)!;
      expect(t.answer).toBe(first.answer);
      expect(t.images.length).toBe(first.images.length);
      t.images.forEach((img, i) => {
        expect(Buffer.from(img.png).equals(Buffer.from(first.images[i]!.png))).toBe(true);
      });
    }
  });

  it("produces valid PNGs a model sees at full size", () => {
    for (const t of tasks) {
      for (const img of t.images) {
        const info = probeImage(img.png);
        expect(info?.mime).toBe("image/png");
        expect([info?.width, info?.height]).toEqual([img.width, img.height]);
        expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(
          AGENT_VIEW_IMAGE_LIMITS.maxSide ?? Number.POSITIVE_INFINITY,
        );
        expect(img.width * img.height).toBeLessThanOrEqual(
          AGENT_VIEW_IMAGE_LIMITS.maxPixels ?? Number.POSITIVE_INFINITY,
        );
      }
    }
  });

  it("derives chart answers from the plotted data", () => {
    for (const t of byKind("bar-read")) {
      const m = meta<{ values: number[]; target: number }>(t);
      expect(new Set(m.values).size).toBe(8);
      expect(m.values.every((v) => v % 5 !== 0)).toBe(true);
      expect(t.answer).toBe(String(m.values[m.target]));
    }
    for (const t of byKind("series-compare")) {
      const m = meta<{ blue: number[]; orange: number[] }>(t);
      expect(m.blue.every((b, i) => b !== m.orange[i])).toBe(true);
      expect(t.answer).toBe(String(m.blue.filter((b, i) => b > m.orange[i]!).length));
    }
    for (const t of byKind("log-axis")) {
      const m = meta<{ values: number[]; target: number }>(t);
      expect(m.values.every((v) => v >= 1 && v <= 100_000)).toBe(true);
      expect(Number(t.answer)).toBe(m.values[m.target]!);
    }
  });

  it("derives table answers from the cells", () => {
    for (const t of byKind("table-lookup")) {
      const m = meta<{ rowIds: string[]; cells: number[][]; target: [number, number] }>(t);
      expect(new Set(m.rowIds).size).toBe(m.rowIds.length);
      expect(t.answer).toBe(String(m.cells[m.target[0]]![m.target[1]]));
    }
    for (const t of byKind("table-sum")) {
      const m = meta<{ regions: string[]; units: number[]; region: string }>(t);
      const rows = m.regions.filter((r) => r === m.region).length;
      expect(rows).toBeGreaterThanOrEqual(3);
      const sum = m.units.reduce((s, u, i) => s + (m.regions[i] === m.region ? u : 0), 0);
      expect(t.answer).toBe(String(sum));
    }
  });

  it("derives spatial counts from unambiguous geometry", () => {
    for (const t of byKind("inside-count")) {
      const m = meta<{
        rect: { x0: number; y0: number; x1: number; y1: number };
        shapes: Array<{ x: number; y: number; s: number; inside: boolean; target: boolean }>;
      }>(t);
      for (const s of m.shapes) {
        const fullyIn =
          s.x - s.s > m.rect.x0 &&
          s.x + s.s < m.rect.x1 &&
          s.y - s.s > m.rect.y0 &&
          s.y + s.s < m.rect.y1;
        const fullyOut =
          s.x + s.s < m.rect.x0 ||
          s.x - s.s > m.rect.x1 ||
          s.y + s.s < m.rect.y0 ||
          s.y - s.s > m.rect.y1;
        expect(s.inside ? fullyIn : fullyOut).toBe(true);
      }
      expect(t.answer).toBe(String(m.shapes.filter((s) => s.inside && s.target).length));
    }
    for (const t of byKind("clutter-count")) {
      const m = meta<{ targets: Array<{ x: number; y: number; s: number }>; distractors: number }>(
        t,
      );
      expect(m.targets.length).toBeGreaterThanOrEqual(8);
      expect(m.targets.length + m.distractors).toBeGreaterThanOrEqual(40);
      for (const [i, a] of m.targets.entries()) {
        for (const b of m.targets.slice(i + 1)) {
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.s + b.s);
        }
      }
      expect(t.answer).toBe(String(m.targets.length));
    }
  });

  it("makes multi-image answers unique", () => {
    for (const t of byKind("spot-diff")) {
      expect(t.images).toHaveLength(2);
      const m = meta<{ a: unknown[][]; b: unknown[][] }>(t);
      const diffs: string[] = [];
      m.a.forEach((row, i) => {
        row.forEach((cell, j) => {
          if (JSON.stringify(cell) !== JSON.stringify(m.b[i]![j]))
            diffs.push(`${"ABCDEFG"[j]}${i + 1}`);
        });
      });
      expect(diffs).toEqual([t.answer]);
    }
    for (const t of byKind("match-spec")) {
      expect(t.images).toHaveLength(3);
      const m = meta<{ spec: Parameters<typeof matchesSpec>[1]; scenes: SpecScene[] }>(t);
      const hits = m.scenes.flatMap((s, i) => (matchesSpec(s, m.spec) ? [String(i + 1)] : []));
      expect(hits).toEqual([t.answer]);
    }
  });

  it("makes geometry and small-print answers unique", () => {
    for (const t of byKind("line-length")) {
      const m = meta<{ segs: Array<{ letter: string; length: number }> }>(t);
      const sorted = [...m.segs].sort((a, b) => b.length - a.length);
      expect(sorted[0]!.letter).toBe(t.answer);
      expect(sorted[0]!.length / sorted[1]!.length).toBeGreaterThan(1.03);
    }
    for (const t of byKind("angle")) {
      const n = Number(t.answer);
      expect(n >= 20 && n <= 160).toBe(true);
    }
    for (const t of byKind("small-print")) {
      const m = meta<{ grid: string[]; star: [number, number]; step: [number, number] }>(t);
      expect(new Set(m.grid).size).toBe(36);
      const [r, c] = [m.star[0] + m.step[0], m.star[1] + m.step[1]];
      expect(r >= 0 && r < 6 && c >= 0 && c < 6).toBe(true);
      expect(t.answer).toBe(m.grid[r * 6 + c]!);
    }
  });
});

describe("scoreHard", () => {
  it("applies absolute and relative tolerances", () => {
    const abs = { answer: "37", scoring: { type: "number", abs: 1 } } as const;
    expect(scoreHard(abs, "38")).toBe(true);
    expect(scoreHard(abs, "About 36.")).toBe(true);
    expect(scoreHard(abs, "39")).toBe(false);
    expect(scoreHard(abs, "none")).toBe(false);
    const rel = { answer: "3400", scoring: { type: "number", rel: 0.1 } } as const;
    expect(scoreHard(rel, "3,700")).toBe(true);
    expect(scoreHard(rel, "3,800")).toBe(false);
    const exact = { answer: "296", scoring: { type: "number", abs: 0 } } as const;
    expect(scoreHard(exact, "296")).toBe(true);
    expect(scoreHard(exact, "297")).toBe(false);
    expect(scoreHard(exact, "38+41+43+35+42+97 = 296\n\n296")).toBe(true);
    expect(scoreHard(exact, "296\n\nWait, 297")).toBe(false);
  });

  it("refuses hedged choices and reads cells either way round", () => {
    const choice = {
      answer: "C",
      scoring: { type: "choice", options: ["A", "B", "C", "D"] },
    } as const;
    expect(scoreHard(choice, "C")).toBe(true);
    expect(scoreHard(choice, "**C**")).toBe(true);
    expect(scoreHard(choice, "B or C")).toBe(false);
    const cell = { answer: "G2", scoring: { type: "cell" } } as const;
    expect(scoreHard(cell, "G2")).toBe(true);
    expect(scoreHard(cell, "2G")).toBe(true);
    expect(scoreHard(cell, "g-2")).toBe(true);
    expect(scoreHard(cell, "B5")).toBe(false);
  });
});

describe("summarize", () => {
  it("reports per-mode intervals and a paired comparison", () => {
    const rows = [
      { task: "a", kind: "angle", mode: "describe", correct: false, cost: 0.02 },
      { task: "a", kind: "angle", mode: "native", correct: true, cost: 0.01 },
      { task: "b", kind: "angle", mode: "describe", correct: true, cost: 0.02 },
      { task: "b", kind: "angle", mode: "native", correct: true, cost: 0.01 },
      { task: "c", kind: "bar-read", mode: "native", correct: true, cost: 0.01 },
    ];
    const s = summarize(rows, { family: { angle: "geometry", "bar-read": "chart" } });
    expect(s.modes.native!.n).toBe(3);
    expect(s.modes.describe!.correct).toBe(1);
    expect(s.modes.native!.wilson.low).toBeGreaterThan(0);
    expect(s.paired.n).toBe(2);
    expect(s.paired.mcnemar).toMatchObject({ b: 0, c: 1 });
    expect(s.paired.diff).toBeCloseTo(0.5);
    expect(s.byKind.angle!.native!.correct).toBe(2);
    expect(s.byFamily.geometry!.describe!.n).toBe(2);
  });
});
