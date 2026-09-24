#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic, time-balanced test sharding for CI.
 *
 *   bun run scripts/test-shard.ts <index> <total> [--serial] [-- <extra bun test args>]
 *   bun run scripts/test-shard.ts --list [<total>]        # print every bucket + coverage check
 *   bun run scripts/test-shard.ts --list <index> <total>  # print one bucket
 *
 * Partitioning:
 *   1. Every `test/*.test.ts` file (sorted by name) is a unit — the same glob
 *      `bun run test` uses once the dashboard / desktop / demo trees are ignored.
 *   2. Files present in `test/timing.json` (Bun's `--timings` format:
 *      `{ "version": 1, "files": { "<path>": <ms> } }`) are assigned greedily,
 *      slowest first, to the currently lightest bucket (LPT). Ties break on the
 *      sorted file name, so the result is stable across machines.
 *   3. Files missing from the snapshot (new or renamed tests) fall back to a
 *      name hash: `fnv1a(path) % total`. They carry the median measured weight
 *      for balancing purposes so a burst of new files does not skew one bucket.
 *
 * Regenerate the snapshot (see test/README.md):
 *   bun run test -- --timings test/timing.json --update-timings
 *
 * `--list` asserts that the buckets are disjoint and cover every file exactly
 * once, then prints per-bucket file counts and estimated seconds.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TIMING_PATH = resolve(ROOT, "test/timing.json");
const IGNORE = [
  "--path-ignore-patterns",
  "**/dashboard/**",
  "--path-ignore-patterns",
  "**/examples/coding-agent-demo/**",
  "--path-ignore-patterns",
  "**/marina-desktop/**",
];

interface TimingFile {
  version?: number;
  files?: Record<string, number>;
}

function listTestFiles(): string[] {
  const glob = new Bun.Glob("test/*.test.ts");
  return [...glob.scanSync({ cwd: ROOT })].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function loadTimings(): Record<string, number> {
  if (!existsSync(TIMING_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(TIMING_PATH, "utf8")) as TimingFile;
    return parsed.files ?? {};
  } catch {
    return {};
  }
}

/** FNV-1a 32-bit — stable across runtimes, no dependency. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 500;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface Bucket {
  index: number;
  files: string[];
  estimatedMs: number;
  hashed: string[];
}

export function partition(
  files: string[],
  timings: Record<string, number>,
  total: number,
): Bucket[] {
  const buckets: Bucket[] = Array.from({ length: total }, (_, index) => ({
    index,
    files: [],
    estimatedMs: 0,
    hashed: [],
  }));
  const known = files.filter((f) => typeof timings[f] === "number");
  const unknown = files.filter((f) => typeof timings[f] !== "number");
  const fallbackMs = median(known.map((f) => timings[f]!));

  // Unknown files first: deterministic by name hash, independent of the snapshot.
  for (const file of unknown) {
    const bucket = buckets[fnv1a(file) % total]!;
    bucket.files.push(file);
    bucket.hashed.push(file);
    bucket.estimatedMs += fallbackMs;
  }

  // Known files: LPT greedy — slowest first onto the lightest bucket.
  const bySlowest = [...known].sort((a, b) => {
    const diff = timings[b]! - timings[a]!;
    return diff !== 0 ? diff : a < b ? -1 : a > b ? 1 : 0;
  });
  for (const file of bySlowest) {
    let lightest = buckets[0]!;
    for (const bucket of buckets) {
      if (bucket.estimatedMs < lightest.estimatedMs) lightest = bucket;
    }
    lightest.files.push(file);
    lightest.estimatedMs += timings[file]!;
  }

  for (const bucket of buckets) bucket.files.sort();
  return buckets;
}

/** Throws when the buckets do not cover `files` exactly once. */
export function assertCoverage(files: string[], buckets: Bucket[]): void {
  const seen = new Map<string, number>();
  for (const bucket of buckets) {
    for (const file of bucket.files) seen.set(file, (seen.get(file) ?? 0) + 1);
  }
  const missing = files.filter((f) => !seen.has(f));
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([f]) => f);
  const extra = [...seen.keys()].filter((f) => !files.includes(f));
  if (missing.length || duplicated.length || extra.length) {
    throw new Error(
      `shard coverage broken: missing=${JSON.stringify(missing)} duplicated=${JSON.stringify(
        duplicated,
      )} extra=${JSON.stringify(extra)}`,
    );
  }
}

function usage(): never {
  console.error(
    "usage: bun run scripts/test-shard.ts <index> <total> [-- <bun test args>]\n" +
      "       bun run scripts/test-shard.ts --list [<index>] <total>",
  );
  process.exit(2);
}

function parseIndexTotal(args: string[]): { index: number | null; total: number } {
  const nums = args.map((a) => Number.parseInt(a, 10));
  if (nums.length === 1 && Number.isInteger(nums[0]) && nums[0]! > 0) {
    return { index: null, total: nums[0]! };
  }
  if (nums.length === 2 && nums.every((n) => Number.isInteger(n))) {
    const [index, total] = nums as [number, number];
    if (total <= 0 || index < 0 || index >= total) usage();
    return { index, total };
  }
  return usage();
}

/** Files run in parallel worker processes unless `--serial` is given or the
 *  caller already passed its own `--parallel[=N]` (measured: ~4x faster).
 *  Contended workers run slower than a lone process, so parallel mode raises
 *  the per-test default timeout from 5 s to 15 s (a caller's `--timeout` wins). */
function parallelArgs(own: string[], passthrough: string[]): string[] {
  if (own.includes("--serial")) return [];
  if (passthrough.some((a) => a.startsWith("--parallel"))) return [];
  const timeout = passthrough.some((a) => a.startsWith("--timeout")) ? [] : ["--timeout=15000"];
  return ["--parallel", ...timeout];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dashdash = argv.indexOf("--");
  const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
  const passthrough = dashdash === -1 ? [] : argv.slice(dashdash + 1);
  const list = own.includes("--list");
  const positional = own.filter((a) => a !== "--list" && a !== "--serial");

  const files = listTestFiles();
  const timings = loadTimings();
  const { index, total } = positional.length
    ? parseIndexTotal(positional)
    : list
      ? { index: null, total: 3 }
      : usage();
  const buckets = partition(files, timings, total);
  assertCoverage(files, buckets);

  if (list) {
    const unknownCount = files.filter((f) => typeof timings[f] !== "number").length;
    console.log(
      `${files.length} test files, ${total} shards, ${unknownCount} without a timing.json entry (name-hash fallback)`,
    );
    for (const bucket of buckets) {
      if (index !== null && bucket.index !== index) continue;
      console.log(
        `\nshard ${bucket.index}/${total}: ${bucket.files.length} files, ~${(
          bucket.estimatedMs / 1000
        ).toFixed(1)}s estimated${bucket.hashed.length ? ` (${bucket.hashed.length} hashed)` : ""}`,
      );
      for (const file of bucket.files) {
        const ms = timings[file];
        console.log(`  ${file}${typeof ms === "number" ? ` (${ms} ms)` : " (no timing)"}`);
      }
    }
    const counts = buckets.map((b) => b.files.length);
    console.log(`\ncoverage ok: ${counts.join(" + ")} = ${files.length}`);
    return;
  }

  if (index === null) usage();
  const bucket = buckets[index]!;
  if (bucket.files.length === 0) {
    console.log(`shard ${index}/${total}: no files assigned — nothing to run`);
    return;
  }
  console.log(
    `shard ${index}/${total}: ${bucket.files.length} files, ~${(bucket.estimatedMs / 1000).toFixed(
      1,
    )}s estimated`,
  );
  const started = performance.now();
  const proc = Bun.spawn(
    ["bun", "test", ...IGNORE, ...parallelArgs(own, passthrough), ...passthrough, ...bucket.files],
    {
      cwd: ROOT,
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
    },
  );
  const code = await proc.exited;
  console.log(
    `shard ${index}/${total}: exit ${code} after ${((performance.now() - started) / 1000).toFixed(
      1,
    )}s`,
  );
  process.exit(code);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
