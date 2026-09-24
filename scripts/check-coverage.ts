#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Soft coverage floor.
 *
 * Parses `coverage/lcov.info` (produced by `bun run test:coverage`) and prints
 * per-directory LINE coverage, calling out the directories that carry the most
 * untested surface area. By default it only REPORTS — nothing fails, so a
 * nightly run or a local check never blocks on a number. With `--strict` it
 * exits non-zero when overall line coverage is below `MARINA_COVERAGE_MIN_LINES`
 * (default: `DEFAULT_LINE_FLOOR_PERCENT` below).
 *
 * Usage:
 *   bun run scripts/check-coverage.ts [path/to/lcov.info] [--strict] [--min N]
 */

const DEFAULT_LCOV = "coverage/lcov.info";

/**
 * The repo's soft line-coverage floor, as a percentage.
 *
 * This script — not `bunfig.toml` — owns the floor. Bun 1.4.2 enforces
 * `coverageThreshold` PER FILE (a run reporting 12.50%/17.41% exits 1 under a
 * 0.05 scalar) and ignores the documented table form outright, so it cannot
 * express "the repo as a whole should stay above N". See the comment in
 * bunfig.toml.
 *
 * The number below is the LINE-WEIGHTED total across source files: a 2,000-line
 * module at 40% contributes 2,000 lines here, where Bun's "All files" row —
 * an unweighted mean of per-file percentages — counts it once. On the 2026-09
 * full-suite run those read 78.6% and 84.6% respectively; 75 leaves the
 * weighted figure a few points of headroom.
 */
const DEFAULT_LINE_FLOOR_PERCENT = 75;

/**
 * Directories worth a dedicated line in the report: recently split modules and
 * the persistence/query layer, where a regression hides easily behind a healthy
 * repo-wide average. A prefix with no files is simply skipped.
 */
const HIGHLIGHT_PREFIXES = [
  "src/net/model-api/",
  "src/net/dashboard-api/",
  "src/persistence/interfaces/",
  "src/persistence/db-",
  "src/agent/tools/",
];

interface FileCoverage {
  file: string;
  linesFound: number;
  linesHit: number;
}

/** Parse the subset of LCOV that `bun test --coverage-reporter=lcov` emits. */
export function parseLcov(text: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let file = "";
  let found = 0;
  let hit = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      file = line.slice(3);
      found = 0;
      hit = 0;
    } else if (line.startsWith("DA:")) {
      // DA:<line>,<execution count> — authoritative even when LF/LH are absent.
      const [, count] = line.slice(3).split(",");
      found++;
      if (Number(count) > 0) hit++;
    } else if (line === "end_of_record" && file) {
      files.push({ file, linesFound: found, linesHit: hit });
      file = "";
    }
  }
  return files;
}

const pct = (hit: number, found: number): number => (found === 0 ? 100 : (hit / found) * 100);
const fmt = (value: number): string => `${value.toFixed(2)}%`.padStart(7);

/** Roll a set of files up into one `{ hit, found }` pair. */
function total(files: FileCoverage[]): { hit: number; found: number } {
  return files.reduce(
    (acc, f) => ({ hit: acc.hit + f.linesHit, found: acc.found + f.linesFound }),
    { hit: 0, found: 0 },
  );
}

function groupByDirectory(files: FileCoverage[]): Map<string, FileCoverage[]> {
  const groups = new Map<string, FileCoverage[]>();
  for (const f of files) {
    const slash = f.file.lastIndexOf("/");
    const dir = slash === -1 ? "." : f.file.slice(0, slash);
    const bucket = groups.get(dir);
    if (bucket) bucket.push(f);
    else groups.set(dir, [f]);
  }
  return groups;
}

function report(files: FileCoverage[], minLines: number, strict: boolean): number {
  // Coverage of a test file measures the test, not the code under test.
  const source = files.filter(
    (f) => !f.file.startsWith("test/") && !f.file.startsWith("..") && !f.file.includes("/test/"),
  );
  const overall = total(source);
  const overallPct = pct(overall.hit, overall.found);

  console.log(`Coverage (lines) — ${source.length} source files, ${overall.found} lines\n`);

  const groups = [...groupByDirectory(source).entries()]
    .map(([dir, entries]) => ({ dir, ...total(entries), count: entries.length }))
    .filter((g) => g.found > 0)
    .sort((a, b) => a.dir.localeCompare(b.dir));

  console.log("  Directory".padEnd(46) + "Lines    Files");
  console.log(`  ${"-".repeat(44)} -------  -----`);
  for (const g of groups) {
    console.log(`  ${g.dir.padEnd(44)}${fmt(pct(g.hit, g.found))}  ${String(g.count).padStart(5)}`);
  }

  const highlights = HIGHLIGHT_PREFIXES.map((prefix) => ({
    prefix,
    files: source.filter((f) => f.file.startsWith(prefix)),
  })).filter((h) => h.files.length > 0);

  if (highlights.length > 0) {
    console.log("\n  Watched surfaces");
    console.log(`  ${"-".repeat(44)} -------  -----`);
    for (const h of highlights) {
      const t = total(h.files);
      console.log(
        `  ${h.prefix.padEnd(44)}${fmt(pct(t.hit, t.found))}  ${String(h.files.length).padStart(5)}`,
      );
    }
  }

  const worst = [...source]
    .filter((f) => f.linesFound >= 40)
    .sort((a, b) => pct(a.linesHit, a.linesFound) - pct(b.linesHit, b.linesFound))
    .slice(0, 10);
  if (worst.length > 0) {
    console.log("\n  Least-covered files (>= 40 lines)");
    console.log(`  ${"-".repeat(44)} -------  -----`);
    for (const f of worst) {
      console.log(
        `  ${f.file.slice(-44).padEnd(44)}${fmt(pct(f.linesHit, f.linesFound))}  ${String(f.linesFound).padStart(5)}`,
      );
    }
  }

  console.log(`\nOverall line coverage: ${overallPct.toFixed(2)}% (floor ${minLines}%)`);

  if (overallPct + 1e-9 < minLines) {
    if (strict) {
      console.error(
        `FAIL: line coverage ${overallPct.toFixed(2)}% is below the ${minLines}% floor.`,
      );
      return 1;
    }
    console.warn(`WARN: line coverage ${overallPct.toFixed(2)}% is below the ${minLines}% floor.`);
  }
  return 0;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const strict = argv.includes("--strict");
  const minFlagAt = argv.indexOf("--min");
  const minLines = Number(
    minFlagAt >= 0 ? argv[minFlagAt + 1] : (process.env.MARINA_COVERAGE_MIN_LINES ?? ""),
  );
  const floor = Number.isFinite(minLines) && minLines > 0 ? minLines : DEFAULT_LINE_FLOOR_PERCENT;
  const path = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--min") ?? DEFAULT_LCOV;

  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(
      `No coverage report at ${path}. Run \`bun run test:coverage\` first (see docs/guides/testing.md).`,
    );
    process.exit(strict ? 1 : 0);
  }

  process.exit(report(parseLcov(await file.text()), floor, strict));
}
