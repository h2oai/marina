// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadSkillFile } from "../src/agent/skill-import";
import { evalExpression } from "../src/engine/commands/calc-eval";
import { parseSeriesTokens, quantCommand } from "../src/engine/commands/quant";
import type { Entity, EntityId, RoomContext } from "../src/types";
import { stripAnsi } from "./helpers";

async function runQuant(args: string): Promise<string> {
  const sent: string[] = [];
  const entity = { id: "e_1", name: "tester" } as unknown as Entity;
  const cmd = quantCommand({ getEntity: () => entity });
  const ctx = { send: (_id: string, msg: string) => sent.push(msg) } as unknown as RoomContext;
  await cmd.handler(ctx, {
    entity: "e_1" as EntityId,
    verb: "quant",
    args,
    tokens: args.split(/\s+/),
    raw: `quant ${args}`,
  } as never);
  return stripAnsi(sent.join("\n"));
}

describe("quant command", () => {
  test("is a rank-0 read-only command", () => {
    const cmd = quantCommand({ getEntity: () => undefined });
    expect(cmd.name).toBe("quant");
    expect(cmd.minRank).toBe(0);
    expect(cmd.usage?.every((u) => typeof u !== "string" && u.effect === "read")).toBe(true);
  });

  test("no subcommand or help prints usage; an unknown one is named", async () => {
    expect(await runQuant("")).toContain("quant fit <values>");
    expect(await runQuant("help")).toContain("quant buckets");
    expect(await runQuant("frobnicate")).toContain("frobnicate");
  });

  test("fit: a trending series picks a trend method and reports quantiles", async () => {
    const out = await runQuant(
      "fit 3.1 3.3 3.6 3.4 3.9 4.0 4.2 4.1 4.4 4.3 4.6 4.8 4.7 5.0 5.1 steps:2",
    );
    expect(out).toContain("quant fit");
    expect(out).toMatch(/method: auto → (trend|damped)/);
    expect(out).toContain("2 step(s) ahead, 15 values");
    expect(out).toContain("RMS of its own 2-step misses");
    expect(out).toMatch(/quantiles: 5% [\d.]+ \| 10%/);
    expect(out).toContain("candidates: persistence 5.1");
  });

  test("fit: dated values, a target date and a fixed method", async () => {
    const out = await runQuant(
      "fit 2026-01-31=3.1, 2026-02-28=3.3, 2026-03-31=3.6 to:2026-06-30 method:persistence",
    );
    expect(out).toContain("method: persistence");
    expect(out).toContain("3 step(s) ahead, 3 values");
    expect(out).toContain("mean: 3.6");
    expect(out).toContain("treat as rough");
  });

  test("fit with buckets after -- prints bucket probabilities", async () => {
    const out = await runQuant("fit 5 5 5 5 5 5 5 5 5 5 5 5 -- <5, 5, >5");
    expect(out).toContain("sd: 0");
    expect(out).toMatch(/5\s+100\.0%\s+← most likely/);
    expect(out).toContain("most likely: 5");
  });

  test("fit edge cases: one value, missing values, nothing usable, bad input", async () => {
    expect(await runQuant("fit 7")).toContain("one value: no spread");
    expect(await runQuant("fit NaN 1 na 2")).toContain("2 values, 2 skipped");
    expect(await runQuant("fit NaN null")).toContain("no usable values");
    expect(await runQuant("fit")).toContain("no values given");
    expect(await runQuant("fit 1 2 banana")).toContain('not a number: "banana"');
    expect(await runQuant("fit 1 2 3 method:magic")).toContain('unknown method "magic"');
    expect(await runQuant("fit 1 2 3 steps:0")).toContain("steps must be");
    expect(await runQuant("fit 2026-01-01=1 2")).toContain("mix of dated and undated");
  });

  test("buckets from a normal, with labels for multiple choice", async () => {
    const out = await runQuant("buckets mean:3.4 sd:0.3 -- A: <3; B: 3-3.5; C: 3.5-4; D: >=4");
    expect(out).toContain("normal(mean 3.4, sd 0.3)");
    expect(out).toMatch(/B\s+53\.\d%\s+← most likely/);
    expect(out).toContain("most likely: B");
  });

  test("buckets from quantiles and from cuts", async () => {
    const q = await runQuant("buckets q:0.1=38,0.5=42,0.9=47 -- <40, 40-45, >=45");
    expect(q).toMatch(/<40\s+30\.0%/);
    expect(q).toMatch(/40-45\s+44\.0%\s+← most likely/);
    const pct = await runQuant("buckets q:10%=38,50%=42,90=47 -- <40, 40-45, >=45");
    expect(pct).toMatch(/40-45\s+44\.0%/);
    const cuts = await runQuant("buckets mean:10 sd:0 cuts:5,10,15 closed:upper");
    expect(cuts).toMatch(/\(5, 10\]\s+100\.0%/);
    expect(cuts).toContain("sd is 0");
  });

  test("buckets report partial coverage with each bucket's share", async () => {
    const out = await runQuant("buckets mean:10 sd:2 -- [8, 10], (10, 12]");
    expect(out).toContain("coverage: 68.3%");
    expect(out).toContain("share 50.0%");
    expect(out).toContain("tie");
  });

  test("buckets refuse incomplete or conflicting input", async () => {
    expect(await runQuant("buckets mean:1 -- <1")).toContain("give mean: and sd:");
    expect(await runQuant("buckets mean:1 sd:1")).toContain("no buckets given");
    expect(await runQuant("buckets mean:1 sd:-1 -- <1")).toContain("sd must be");
    expect(await runQuant("buckets mean:1 sd:1 q:0.1=1,0.9=2 -- <1")).toContain("not both");
    expect(await runQuant("buckets mean:1 sd:1 cuts:1 -- <1")).toContain("not both");
    expect(await runQuant("buckets q:0.5=3 -- <1")).toContain("at least two");
    expect(await runQuant("buckets mean:1 sd:1 -- 5-1")).toContain("inverted");
    expect(await runQuant("buckets mean:x sd:1 -- <1")).toContain("expected a number");
  });
});

describe("parseSeriesTokens", () => {
  test("plain, dated and missing values", () => {
    expect(parseSeriesTokens(["1", "-2.5", "3e2"]).series).toEqual([1, -2.5, 300]);
    const dated = parseSeriesTokens(["2026-01=1", "2026-02:2", "2026-03-15=na"]);
    expect(dated.missing).toBe(1);
    expect(dated.series).toEqual([
      { date: "2026-01", value: 1 },
      { date: "2026-02", value: 2 },
      { date: "2026-03-15", value: Number.NaN },
    ]);
    expect(() => parseSeriesTokens(["2026-13-45=1"])).toThrow("invalid date");
  });
});

describe("the quantitative-estimates skill", () => {
  const path = "seeds/skills/quantitative-estimates.md";

  test("parses as a skill package", () => {
    const skill = loadSkillFile(path);
    expect(skill.name).toBe("quantitative-estimates");
    expect(skill.importance).toBe(8);
  });

  test("every calc example it teaches evaluates without error", () => {
    const md = readFileSync(path, "utf8");
    const examples = [...md.matchAll(/`calc ([^`<]+)`/g)].map((m) => m[1]!);
    expect(examples.length).toBeGreaterThan(15);
    for (const expr of examples) {
      const result = evalExpression(expr);
      expect({ expr, error: result.error }).toEqual({ expr, error: undefined });
      expect(result.outputs.length).toBeGreaterThan(0);
    }
  });

  test("every quant example it teaches runs without error", async () => {
    const md = readFileSync(path, "utf8");
    const examples = [...md.matchAll(/^quant (.+)$/gm)].map((m) => m[1]!);
    expect(examples.length).toBeGreaterThanOrEqual(6);
    for (const args of examples) {
      const out = await runQuant(args);
      expect(out.split("\n")[0]).toBe(`quant ${args.split(" ")[0]}`);
    }
  });
});
