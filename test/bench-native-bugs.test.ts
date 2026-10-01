// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBugs, runHiddenCases, scoreBugs } from "../benchmarks/native/bugs";

describe("bugs", () => {
  test("deterministic; planted defects are real and visible tests cover only some", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const a = generateBugs(seed);
      expect(generateBugs(seed)).toEqual(a);
      const o = a.oracle;
      expect(o.buggy.length).toBeGreaterThanOrEqual(3);
      expect(o.visiblyCaught.length).toBeLessThan(o.buggy.length);
      expect(o.claims.filter((c) => c.isFalse).length).toBe(2);
      for (const c of o.claims) expect(c.text.length).toBeLessThanOrEqual(60);
      expect(a.setup.find((s) => s.kind === "file" && s.path === o.modulePath)).toBeDefined();
    }
  });

  test("hidden cases: correct source passes all, planted source fails every bugged function", async () => {
    for (const seed of [1, 2, 3]) {
      const { oracle: o } = generateBugs(seed);
      const good = await runHiddenCases(o.correctSource, o.hidden);
      expect(good.error).toBeUndefined();
      expect(good.results.every(Boolean)).toBe(true);
      const bad = await runHiddenCases(o.plantedSource, o.hidden);
      const failing = new Set(o.hidden.filter((_, i) => !bad.results[i]).map((c) => c.fn));
      expect([...failing].sort()).toEqual([...o.buggy].sort());
    }
  });

  test("oracle: known-good deliverable scores 1, known-bad loses credit", async () => {
    const inst = generateBugs(2);
    const o = inst.oracle;
    const good = await scoreBugs(inst.answer, o, { files: { [o.modulePath]: o.correctSource } });
    expect(good).toMatchObject({ correct: true, score: 1 });
    expect(good.details.claimScore).toBe(1);
    const bad = await scoreBugs(`${o.tag} REPORT: fixed=; false=none`, o, {
      files: { [o.modulePath]: o.plantedSource },
    });
    expect(bad.correct).toBe(false);
    expect(bad.score).toBeLessThan(1);
    expect(bad.details.claimScore as number).toBeLessThan(1);
    const missing = await scoreBugs(inst.answer, o, {});
    expect(missing).toMatchObject({ correct: false, score: 0 });
    const broken = await scoreBugs(inst.answer, o, {
      files: { [o.modulePath]: "export const x = ;" },
    });
    expect(broken.score).toBe(0);
  });

  test("visible tests pass on the correct module and fail on the planted one", async () => {
    const inst = generateBugs(1);
    const visible = inst.setup.find((s) => s.kind === "file" && s.path.endsWith("visible.test.ts"));
    if (visible?.kind !== "file") throw new Error("no visible test");
    for (const [source, ok] of [
      [inst.oracle.correctSource, true],
      [inst.oracle.plantedSource, false],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), "native-visible-"));
      try {
        writeFileSync(join(dir, "mod.ts"), source);
        writeFileSync(join(dir, "visible.test.ts"), visible.content);
        const p = Bun.spawn([process.execPath, "test", "./visible.test.ts"], {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect((await p.exited) === 0).toBe(ok);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
