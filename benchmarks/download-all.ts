// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot: fetch and cache benchmark datasets.
 * Run: bun run benchmarks/download-all.ts            (the default set below)
 *      bun run benchmarks/download-all.ts <key> ...  (named registry keys only)
 *
 * The in-world `benchmark fetch <key>` runs this script for one key.
 * Downloaders handle their own HuggingFace endpoints (every request through
 * the server's SSRF guard) and write JSON caches into benchmarks/datasets/.
 * Re-runs skip if cache is already populated.
 */

import {
  downloadAIME,
  downloadAIME2025,
  downloadARC,
  downloadBBH,
  downloadFRAMES,
  downloadGPQA,
  downloadGSM8K,
  downloadHellaSwag,
  downloadHLEVerifiedGold,
  downloadHLEVerifiedGoldImages,
  downloadHumanEval,
  downloadMATH,
  downloadMTBench,
  downloadMuSR,
  downloadNarrativeQA,
  downloadSimpleQA,
} from "./download";
import { BENCHMARKS } from "./registry";

const DATASETS_DIR = `${import.meta.dir}/datasets`;

interface Job {
  name: string;
  /** The registry key (`benchmark fetch <key>`). */
  key: string;
  run: () => Promise<{ length: number }>;
}

const JOBS: Job[] = [
  { name: "arc-challenge", key: "arc-challenge", run: () => downloadARC(DATASETS_DIR, 3000) },
  { name: "hellaswag", key: "hellaswag", run: () => downloadHellaSwag(DATASETS_DIR, 3000) },
  { name: "musr", key: "musr", run: () => downloadMuSR(DATASETS_DIR, 1000) },
  { name: "bbh", key: "bbh", run: () => downloadBBH(DATASETS_DIR, 1000) },
  { name: "gsm8k", key: "gsm8k", run: () => downloadGSM8K(DATASETS_DIR, 2000) },
  { name: "math", key: "math", run: () => downloadMATH(DATASETS_DIR, 500) },
  { name: "simpleqa", key: "simple-qa", run: () => downloadSimpleQA(DATASETS_DIR, 2000) },
  { name: "humaneval", key: "humaneval", run: () => downloadHumanEval(DATASETS_DIR, 200) },
  { name: "narrativeqa", key: "narrativeqa", run: () => downloadNarrativeQA(DATASETS_DIR, 500) },
  { name: "mt-bench", key: "mt-bench", run: () => downloadMTBench(DATASETS_DIR, 100) },
  { name: "frames", key: "frames", run: () => downloadFRAMES(DATASETS_DIR, 1000) },
  { name: "aime-2024", key: "aime", run: () => downloadAIME(DATASETS_DIR, 50) },
  { name: "aime-2025", key: "aime-2025", run: () => downloadAIME2025(DATASETS_DIR, 50) },
  // GPQA is gated on HuggingFace (Idavidrein/gpqa) — requires HF_TOKEN
  // with accepted terms. Downloader returns a clear error if missing.
  { name: "gpqa-diamond", key: "gpqa", run: () => downloadGPQA(DATASETS_DIR, 200) },
  {
    name: "hle-verified-gold",
    key: "hle-verified-gold",
    run: () => downloadHLEVerifiedGold(DATASETS_DIR),
  },
  {
    name: "hle-verified-gold-mm",
    key: "hle-verified-gold-mm",
    run: () => downloadHLEVerifiedGoldImages(DATASETS_DIR),
  },
];

/**
 * The jobs for `keys` (registry keys): the default-set job when there is one,
 * else the harness registry's own loader. No keys = the default set; an
 * unknown key is an error.
 */
export function jobsFor(keys: readonly string[]): Job[] | { error: string } {
  if (!keys.length) return JOBS;
  const jobs: Job[] = [];
  for (const key of keys) {
    const known = JOBS.find((j) => j.key === key);
    const def = Object.hasOwn(BENCHMARKS, key) ? BENCHMARKS[key] : undefined;
    if (known) jobs.push(known);
    else if (def) jobs.push({ name: key, key, run: () => def.download(DATASETS_DIR) });
    else
      return {
        error: `unknown benchmark "${key}" (known: ${Object.keys(BENCHMARKS).join(", ")})`,
      };
  }
  return jobs;
}

async function main() {
  const selected = jobsFor(process.argv.slice(2));
  if ("error" in selected) {
    console.error(`[download-all] ${selected.error}`);
    process.exit(2);
  }
  const results: { name: string; status: string; count?: number; error?: string }[] = [];
  for (const job of selected) {
    const t0 = performance.now();
    console.log(`[download-all] ${job.name}…`);
    try {
      const items = await job.run();
      const dt = Math.round(performance.now() - t0);
      console.log(`  ✓ ${job.name} — ${items.length} items (${dt}ms)`);
      results.push({ name: job.name, status: "ok", count: items.length });
    } catch (err) {
      const dt = Math.round(performance.now() - t0);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${job.name} — ${msg.slice(0, 200)} (${dt}ms)`);
      results.push({ name: job.name, status: "fail", error: msg.slice(0, 200) });
    }
  }
  console.log("\n=== download-all summary ===");
  for (const r of results) {
    if (r.status === "ok") console.log(`  ${r.name.padEnd(20)} ${r.count} items`);
    else console.log(`  ${r.name.padEnd(20)} FAIL — ${r.error}`);
  }
  const failed = results.filter((r) => r.status === "fail").length;
  if (failed > 0) process.exit(1);
}

if (import.meta.main)
  main().catch((e) => {
    console.error("[download-all] fatal:", e);
    process.exit(1);
  });
