// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI never runs a model benchmark or downloads a dataset. Benchmark runs call
 * paid model APIs and fetch gigabytes of data; CI only unit-tests the
 * benchmark code against synthetic fixtures and typechecks it.
 *
 * Guarded paths: every GitHub workflow, the package scripts CI invokes, and
 * every test file (a test may import pure benchmark helpers, but never a
 * benchmark entry point whose module body starts a run).
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/**
 * Package scripts that start a benchmark run, a dataset download, a paid model
 * run or an external filing (forecasting competitions, the arena).
 */
const RUN_SCRIPTS = [
  "arena",
  "arena:portfolio",
  "bench",
  "bench:compare",
  "bench:native",
  "bench:tier0",
  "bench:ui",
  "browsecomp-plus",
  "forecast",
  "forecastbench",
  "futurex",
  "metaculus",
  "repro",
  "swebench",
  "tau2",
];
/** The paid runners' script entry points (each runs `main()` at module load). */
const PAID_RUNNERS =
  "futurex|forecastbench|metaculus|browsecomp-plus|swebench|tau2|repro|forecast|arena|arena-portfolio";
/**
 * Entry points that run a benchmark, download data, spend on models or file
 * externally when executed: the harnesses, the paid runner scripts, the
 * SWE-bench Pro grader, and the Prophet Arena CLI (`prophet eval|run|submit`).
 */
const RUN_ENTRY = new RegExp(
  [
    String.raw`benchmarks\/(harness|tier0|download-all|download|server|native\/cli|run-[\w-]+)(\.ts)?\b`,
    String.raw`scripts\/(${PAID_RUNNERS})(\.ts)?(?![\w.-])`,
    String.raw`benchmarks\/swebench\/pro_grade\.py`,
    String.raw`\bprophet\s+(eval|run|submit)\b`,
  ].join("|"),
);
/** Entry points whose module body runs `main()` unguarded, so importing one starts a run. */
const UNGUARDED_ENTRY = new RegExp(
  String.raw`from\s+["']\.\.\/(benchmarks\/(harness|download-all|native\/cli)|scripts\/(${PAID_RUNNERS}))["']`,
);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

function runScriptRef(text: string): string | undefined {
  for (const name of RUN_SCRIPTS) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`bun run ${escaped}(?![\\w:-])`).test(text)) return `bun run ${name}`;
  }
  return text.match(RUN_ENTRY)?.[0];
}

/** Every package script reachable from `entry` through `bun run <script>`. */
function reachableScripts(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  const body = pkg.scripts[entry];
  if (body === undefined) return seen;
  seen.add(entry);
  for (const [, name] of body.matchAll(/bun run ([\w:-]+)/g)) {
    if (name !== undefined && name in pkg.scripts) reachableScripts(name, seen);
  }
  return seen;
}

describe("CI never runs benchmarks", () => {
  const workflowDir = join(ROOT, ".github/workflows");
  const workflows = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f));

  it("no workflow references a benchmark run or dataset download", () => {
    const hits = workflows.flatMap((file) => {
      const ref = runScriptRef(readFileSync(join(workflowDir, file), "utf8"));
      return ref ? [`${file}: ${ref}`] : [];
    });
    expect(hits).toEqual([]);
  });

  it("no package script a workflow invokes reaches a benchmark run", () => {
    const invoked = new Set<string>();
    for (const file of workflows) {
      const text = readFileSync(join(workflowDir, file), "utf8");
      for (const [, name] of text.matchAll(/bun run ([\w:-]+)/g)) {
        if (name !== undefined && name in pkg.scripts) invoked.add(name);
      }
    }
    // The test runners are reached from workflows; assert on them explicitly too.
    for (const name of ["test", "test:fast", "test:shard", "typecheck"]) invoked.add(name);
    const hits: string[] = [];
    for (const entry of invoked) {
      for (const name of reachableScripts(entry)) {
        if (RUN_SCRIPTS.includes(name)) hits.push(`${entry} → ${name}`);
        const ref = (pkg.scripts[name] ?? "").match(RUN_ENTRY)?.[0];
        if (ref) hits.push(`${entry} → ${name}: ${ref}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the test runners never reference a benchmark entry point", () => {
    const runners = ["test-backend.ts", "test-fast.ts", "test-shard.ts"].map((f) =>
      join(ROOT, "scripts", f),
    );
    const hits = runners.flatMap((file) => {
      const ref = runScriptRef(readFileSync(file, "utf8"));
      return ref ? [`${file}: ${ref}`] : [];
    });
    expect(hits).toEqual([]);
  });

  it("recognises every guarded runner's own entry point", () => {
    // A renamed script would otherwise slip past the entry-point patterns.
    const missed = RUN_SCRIPTS.filter((name) => {
      const body = pkg.scripts[name];
      return body === undefined || !RUN_ENTRY.test(body);
    });
    expect(missed.filter((name) => !name.startsWith("bench"))).toEqual([]);
    expect(RUN_ENTRY.test("benchmarks/swebench/pro_grade.py")).toBe(true);
    expect(RUN_ENTRY.test("prophet run marina_agent.py")).toBe(true);
    expect(RUN_ENTRY.test("scripts/arena-calibration-history.ts")).toBe(false);
  });

  it("no test imports a benchmark entry point that runs on import", () => {
    const testDir = join(ROOT, "test");
    const hits = readdirSync(testDir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => UNGUARDED_ENTRY.test(readFileSync(join(testDir, f), "utf8")));
    expect(hits).toEqual([]);
  });
});
