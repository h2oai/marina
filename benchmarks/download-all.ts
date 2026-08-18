// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot: fetch and cache every benchmark dataset the harness knows about.
 * Run: bun run benchmarks/download-all.ts
 *
 * Downloaders handle their own HuggingFace endpoints and write JSON caches
 * into benchmarks/datasets/. Re-runs skip if cache is already populated.
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
  downloadHumanEval,
  downloadMATH,
  downloadMTBench,
  downloadMuSR,
  downloadNarrativeQA,
  downloadSimpleQA,
} from "./download";

const DATASETS_DIR = `${import.meta.dir}/datasets`;

interface Job {
  name: string;
  run: () => Promise<{ length: number }>;
}

const JOBS: Job[] = [
  { name: "arc-challenge", run: () => downloadARC(DATASETS_DIR, 3000) },
  { name: "hellaswag", run: () => downloadHellaSwag(DATASETS_DIR, 3000) },
  { name: "musr", run: () => downloadMuSR(DATASETS_DIR, 1000) },
  { name: "bbh", run: () => downloadBBH(DATASETS_DIR, 1000) },
  { name: "gsm8k", run: () => downloadGSM8K(DATASETS_DIR, 2000) },
  { name: "math", run: () => downloadMATH(DATASETS_DIR, 500) },
  { name: "simpleqa", run: () => downloadSimpleQA(DATASETS_DIR, 2000) },
  { name: "humaneval", run: () => downloadHumanEval(DATASETS_DIR, 200) },
  { name: "narrativeqa", run: () => downloadNarrativeQA(DATASETS_DIR, 500) },
  { name: "mt-bench", run: () => downloadMTBench(DATASETS_DIR, 100) },
  { name: "frames", run: () => downloadFRAMES(DATASETS_DIR, 1000) },
  { name: "aime-2024", run: () => downloadAIME(DATASETS_DIR, 50) },
  { name: "aime-2025", run: () => downloadAIME2025(DATASETS_DIR, 50) },
  // GPQA is gated on HuggingFace (Idavidrein/gpqa) — requires HF_TOKEN
  // with accepted terms. Downloader returns a clear error if missing.
  { name: "gpqa", run: () => downloadGPQA(DATASETS_DIR, 200) },
];

async function main() {
  const results: { name: string; status: string; count?: number; error?: string }[] = [];
  for (const job of JOBS) {
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

main().catch((e) => {
  console.error("[download-all] fatal:", e);
  process.exit(1);
});
