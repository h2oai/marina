// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    baseline: { type: "string" },
    output: { type: "string", default: "/tmp/marina-context-regression" },
  },
  strict: true,
});
assert(values.baseline, "--baseline must name the base checkout, with dependencies available");
const output = resolve(values.output!);
await mkdir(output, { recursive: true });
interface Row {
  records: number;
  tenants: number;
  mode: "cold" | "warm";
  samples: number;
  matchEvery: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}
const runs: { baseline: Row[][]; candidate: Row[][] } = { baseline: [], candidate: [] };
for (let round = 0; round < 3; round++) {
  // Alternating order reduces systematic warm-machine bias; never run contenders
  // concurrently. Keep raw percentiles as CI artifacts for longitudinal inspection.
  for (const label of round % 2
    ? (["candidate", "baseline"] as const)
    : (["baseline", "candidate"] as const)) {
    const path = `${output}/${label}-${round}.json`;
    const logPath = `${output}/${label}-${round}.log`;
    const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
      [
        process.execPath,
        "--env-file=/dev/null",
        "benchmarks/participation-context.ts",
        "--root",
        label === "baseline" ? resolve(values.baseline!) : process.cwd(),
        "--output",
        path,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 180_000,
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await writeFile(logPath, stdout + stderr);
    assert.equal(code, 0, `${label} benchmark failed; see ${logPath}`);
    const report = JSON.parse(await readFile(path, "utf8"));
    assert.equal(report.schema, "marina.context.benchmark.v1");
    assert.equal(report.rows.length, 4);
    runs[label].push(report.rows);
    console.log(`${label} round ${round + 1}: ${JSON.stringify(report.rows)}`);
  }
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[1]!;
const checks: {
  records: number;
  mode: string;
  baselineP99Ms: number | null;
  candidateP99Ms: number;
  allowedP99Ms: number;
  passed: boolean;
}[] = [];
for (const records of [1000, 10000])
  for (const mode of ["cold", "warm"] as const) {
    const tail = (label: keyof typeof runs) =>
      median(
        runs[label].map((rows) => {
          const row = rows.find((r) => r.records === records && r.mode === mode);
          assert(
            row &&
              Number.isFinite(row.p99Ms) &&
              row.p99Ms > 0 &&
              row.samples >= 250 &&
              row.tenants === 8 &&
              row.matchEvery === 100,
            "invalid benchmark sample",
          );
          return row.p99Ms;
        }),
      );
    const baselineP99Ms = tail("baseline"),
      candidateP99Ms = tail("candidate");
    // Shared runners are noisy. Gate material regressions using both a relative
    // allowance and a small absolute noise floor; retain an independent hard budget.
    const allowedP99Ms = Math.min(
      mode === "cold" ? 250 : 20,
      baselineP99Ms * 1.5 + (mode === "cold" ? 2 : 0.5),
    );
    checks.push({
      records,
      mode,
      baselineP99Ms,
      candidateP99Ms,
      allowedP99Ms,
      passed: candidateP99Ms <= allowedP99Ms,
    });
  }
// Also gate a broad-match candidate workload. Comparing the old implementation
// here would spend minutes repeating its known quadratic FTS join on each PR.
// Sparse/base comparison above remains independent and uses identical workloads.
const densePath = `${output}/candidate-dense.json`;
const dense: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
  [
    process.execPath,
    "--env-file=/dev/null",
    "benchmarks/participation-context.ts",
    "--records",
    "10000",
    "--match-every",
    "1",
    "--output",
    densePath,
  ],
  {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  },
);
const [denseCode, denseOut, denseErr] = await Promise.all([
  dense.exited,
  new Response(dense.stdout).text(),
  new Response(dense.stderr).text(),
]);
await writeFile(`${output}/candidate-dense.log`, denseOut + denseErr);
assert.equal(denseCode, 0, "Broad-match candidate benchmark failed");
const denseRows: Row[] = JSON.parse(await readFile(densePath, "utf8")).rows;
assert.equal(denseRows.length, 2);
for (const mode of ["cold", "warm"] as const) {
  const row = denseRows.find((r) => r.mode === mode);
  assert(
    row &&
      row.records === 10000 &&
      row.matchEvery === 1 &&
      row.samples >= 250 &&
      Number.isFinite(row.p99Ms) &&
      row.p99Ms > 0,
  );
  const allowedP99Ms = mode === "cold" ? 500 : 20;
  checks.push({
    records: 10000,
    mode,
    baselineP99Ms: null,
    candidateP99Ms: row.p99Ms,
    allowedP99Ms,
    passed: row.p99Ms <= allowedP99Ms,
  });
}
await writeFile(
  `${output}/report.json`,
  JSON.stringify({ schema: "marina.context.regression.v1", rounds: 3, checks }, null, 2),
);
console.table(checks);
assert(
  checks.every((c) => c.passed),
  `Context p99 regression: see ${output}/report.json`,
);
