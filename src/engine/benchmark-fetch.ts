// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-world dataset download (`benchmark fetch <name>`): runs the harness's own
 * downloader (`benchmarks/download-all.ts <key>`) for ONE registered
 * benchmark, so a fresh install reaches every benchmark without an
 * out-of-band script. The downloader's requests pass the server's SSRF guard
 * (`guardedFetch`). Argv only (never a shell), the key checked against the
 * registry first, one download per key at a time.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { MARINA_ROOT } from "../runtime-paths";
import { benchmarkEntry } from "./benchmark-registry";
import { getErrorMessage } from "./errors";

/** The downloader script, in the checkout the server runs from. */
export const DATASET_FETCH_SCRIPT = join(MARINA_ROOT, "benchmarks", "download-all.ts");

/** Longest a single dataset download may run before it is stopped. */
const FETCH_TIMEOUT_MS = 30 * 60_000;

export interface DatasetFetchResult {
  ok: boolean;
  /** The downloader's output (tail), or why it could not run. */
  output: string;
}

/** Downloads one benchmark's dataset; injectable so tests never touch the network. */
export type DatasetFetcher = (key: string) => Promise<DatasetFetchResult>;

/** Where a benchmark's items come from, as `benchmark list` / `fetch` describe it. */
export function datasetSourceKind(key: string): "tracked" | "generated" | "cache" | undefined {
  return benchmarkEntry(key)?.source.kind;
}

/** The default fetcher: `bun benchmarks/download-all.ts <key>` in the checkout. */
export const spawnDatasetFetch: DatasetFetcher = async (key) => {
  if (datasetSourceKind(key) !== "cache")
    return { ok: false, output: `${key} has no dataset to download` };
  if (!existsSync(DATASET_FETCH_SCRIPT))
    return {
      ok: false,
      output: `the benchmark downloader is not part of this install (${DATASET_FETCH_SCRIPT})`,
    };
  try {
    const proc = Bun.spawn(["bun", DATASET_FETCH_SCRIPT, key], {
      cwd: MARINA_ROOT,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), FETCH_TIMEOUT_MS);
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    const output = `${out}${err ? `\n${err}` : ""}`.trim().split("\n").slice(-8).join("\n");
    return { ok: code === 0, output };
  } catch (error) {
    return { ok: false, output: getErrorMessage(error) };
  }
};

const inFlight = new Set<string>();

/**
 * Start a download for `key` in the background; `onDone` fires once with the
 * result. Returns false (and starts nothing) when one is already running.
 */
export function startDatasetFetch(
  key: string,
  fetcher: DatasetFetcher,
  onDone: (result: DatasetFetchResult) => void,
): boolean {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  void fetcher(key)
    .catch((error): DatasetFetchResult => ({ ok: false, output: getErrorMessage(error) }))
    .then((result) => {
      inFlight.delete(key);
      onDone(result);
    });
  return true;
}
