// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** The native-vs-described visual task set is deterministic and scored exactly. */

import { describe, expect, it } from "bun:test";
import { scoreAnswer, visualTasks } from "../benchmarks/vision-native/items";
import { probeImage } from "../src/engine/media/image-ops";

describe("vision-native benchmark items", () => {
  it("renders the same pixels and answers for the same seed", async () => {
    const a = await visualTasks(1, ["count", "code", "chart", "grid", "dense"]);
    const b = await visualTasks(1, ["count", "code", "chart", "grid", "dense"]);
    expect(a.map((t) => t.id)).toEqual(["count-s1", "code-s1", "chart-s1", "grid-s1", "dense-s1"]);
    for (const [i, task] of a.entries()) {
      expect(task.answer).toBe(b[i]!.answer);
      expect(Buffer.from(task.png).equals(Buffer.from(b[i]!.png))).toBe(true);
      const info = probeImage(task.png);
      expect([info?.width, info?.height]).toEqual([task.width, task.height]);
    }
  });

  it("scores answers by kind", async () => {
    const [count, code, chart, grid] = await visualTasks(1);
    expect(scoreAnswer(count!, `There are ${count!.answer} red circles.`)).toBe(true);
    expect(scoreAnswer(count!, "0")).toBe(false);
    expect(scoreAnswer(code!, code!.answer.toLowerCase())).toBe(true);
    expect(scoreAnswer(chart!, `**${chart!.answer}**`)).toBe(true);
    expect(scoreAnswer(grid!, grid!.answer.replace(",", ", "))).toBe(true);
    expect(scoreAnswer(grid!, "9,9")).toBe(false);
  });
});
