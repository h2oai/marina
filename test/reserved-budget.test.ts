// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReservedBudget } from "../benchmarks/reserved-budget";

test("independent connections share reservations across restarts and uncertain calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "reserved-budget-"));
  const path = join(dir, "budget.db");
  const a = new ReservedBudget(path, 1);
  const b = new ReservedBudget(path, 1);
  try {
    a.addScope("first", 0.8);
    b.addScope("second", 0.8);
    const first = a.reserve("first", 0.6);
    expect(() => b.reserve("second", 0.6)).toThrow("Budget exhausted");
    a.settle(first, 0.2);
    const uncertain = b.reserve("second", 0.6);
    b.settle(uncertain);
    expect(a.total()).toBeCloseTo(0.8);
    expect(() => a.reserve("first", 0.3)).toThrow("Budget exhausted");
    const restarted = new ReservedBudget(path, 1);
    expect(restarted.total()).toBeCloseTo(0.8);
    restarted.close();
    expect(() => a.settle(first, 0)).toThrow("settled");
    expect(() => a.addScope("first", 2)).toThrow("Cannot change");
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true });
  }
});

test("scopes enforce their own cap and invalid usage never releases reservations", () => {
  const b = new ReservedBudget(":memory:", 100);
  try {
    b.addScope("attempt", 1);
    const id = b.reserve("attempt", 0.9);
    expect(() => b.reserve("attempt", 0.2)).toThrow("Budget exhausted");
    for (const usd of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1])
      expect(() => b.settle(id, usd)).toThrow("bound");
    expect(b.total()).toBe(0.9);
    expect(() => b.reserve("missing", 0.1)).toThrow("Unknown");
  } finally {
    b.close();
  }
});

test("concurrent processes cannot admit more than the shared cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reserved-budget-processes-"));
  const path = join(dir, "budget.db");
  const b = new ReservedBudget(path, 1);
  try {
    b.addScope("parallel", 1);
    const script = join(dir, "reserve.ts");
    writeFileSync(
      script,
      `import { ReservedBudget } from ${JSON.stringify(join(import.meta.dir, "../benchmarks/reserved-budget.ts"))};
const budget = new ReservedBudget(${JSON.stringify(path)}, 1);
try { budget.reserve("parallel", 0.4); console.log("admitted"); }
catch (error) {
  if (!(error instanceof Error) || !error.message.includes("Budget exhausted")) throw error;
  console.log("refused");
} finally { budget.close(); }`,
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const child = Bun.spawn([process.execPath, "--env-file=/dev/null", script], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, err }).toEqual({ code: 0, err: "" });
        return out.trim();
      }),
    );
    expect(results.filter((r) => r === "admitted")).toHaveLength(2);
    expect(results.filter((r) => r === "refused")).toHaveLength(3);
    expect(b.total()).toBeCloseTo(0.8);
    expect(() => new ReservedBudget(path, 2)).toThrow("Cannot change");
  } finally {
    b.close();
    rmSync(dir, { recursive: true });
  }
});
