#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-commit fast loop: the subset of backend test files that are cheap AND
 * self-contained.
 *
 *   bun run scripts/test-fast.ts [--list] [--check] [--serial] [-- <extra bun test args>]
 *
 * Selection rule (encoded as the explicit FAST_FILES array below so the loop is
 * deterministic and reviewable in diffs):
 *   1. measured total time <= FAST_MAX_MS (1500 ms) in test/timing.json, AND
 *   2. the file does not boot a full engine or server — heuristic: the source
 *      contains none of `new Engine(`, `startServer`, `Bun.serve`, `WebSocket`.
 *
 * Regenerate the list after re-measuring (see test/README.md):
 *   bun run test -- --timings test/timing.json --update-timings
 *   bun run scripts/test-fast.ts --check      # prints files to add / drop
 * then paste the printed array over FAST_FILES.
 *
 * `--list` prints the current list and its estimated total; `--check`
 * recomputes the rule against test/timing.json and the sources and reports
 * drift (files that no longer qualify, qualifying files not yet listed, listed
 * files that no longer exist) without running anything. Missing files are
 * skipped with a warning at run time so a rename never breaks the loop.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TIMING_PATH = resolve(ROOT, "test/timing.json");
export const FAST_MAX_MS = 1500;
const HEAVY_MARKERS = ["new Engine(", "startServer", "Bun.serve", "WebSocket"];
const IGNORE = [
  "--path-ignore-patterns",
  "**/dashboard/**",
  "--path-ignore-patterns",
  "**/examples/coding-agent-demo/**",
  "--path-ignore-patterns",
  "**/marina-desktop/**",
];

// Generated 2026-09-23 from test/timing.json (bun 1.4.2, full serial run).
// Regenerate with `bun run scripts/test-fast.ts --check`.
export const FAST_FILES: string[] = [
  "test/acp-server.test.ts",
  "test/adapters.test.ts",
  "test/agent-command-status.test.ts",
  "test/agent-config-persistence.test.ts",
  "test/agent-execution-trace.test.ts",
  "test/agent-modules.test.ts",
  "test/agent-runtime-cascade.test.ts",
  "test/agent-spend-guard.test.ts",
  "test/agent-thinking-config.test.ts",
  "test/ansi.test.ts",
  "test/anthropic-inbound.test.ts",
  "test/anthropic-text-content.test.ts",
  "test/anthropic-thinking.test.ts",
  "test/anthropic-tools.test.ts",
  "test/benchmark-numeric-extract.test.ts",
  "test/brief-bootstrap.test.ts",
  "test/cadence.test.ts",
  "test/calibration.test.ts",
  "test/canvas-ws-auth.test.ts",
  "test/channel-retention-prune.test.ts",
  "test/code-launcher.test.ts",
  "test/coding-project-manager.test.ts",
  "test/coding-service-manager.test.ts",
  "test/cognitive-events.test.ts",
  "test/conduct-resolve.test.ts",
  "test/conduct-run.test.ts",
  "test/conduct-tool.test.ts",
  "test/conductor-finder.test.ts",
  "test/connection-manager.test.ts",
  "test/connector-reload.test.ts",
  "test/context-manager-tools.test.ts",
  "test/cors-origin.test.ts",
  "test/database.test.ts",
  "test/deployment-gate.test.ts",
  "test/docs-contract.test.ts",
  "test/durable-keys.test.ts",
  "test/embedding-config.test.ts",
  "test/env-hygiene.test.ts",
  "test/eval-prompt.test.ts",
  "test/evidence-chain.test.ts",
  "test/evolution-analysis.test.ts",
  "test/evolution-persistence.test.ts",
  "test/evolution-protocol.test.ts",
  "test/evolution-qualification.test.ts",
  "test/exec-approver.test.ts",
  "test/federation-crypto.test.ts",
  "test/flywheel-integration.test.ts",
  "test/flywheel-manager.test.ts",
  "test/formatter.test.ts",
  "test/fts5.test.ts",
  "test/init-worlds.test.ts",
  "test/institutional-spaces.test.ts",
  "test/journey-state.test.ts",
  "test/key-crypto.test.ts",
  "test/lean-adapter-coding-task.test.ts",
  "test/lean-adapter-relevant-notes.test.ts",
  "test/lean-adapter-untrusted-perception.test.ts",
  "test/lean-system-prompt.test.ts",
  "test/local-workspace-edit.test.ts",
  "test/marina-remote-target.test.ts",
  "test/media-image-providers.test.ts",
  "test/media-video-providers.test.ts",
  "test/memory-adopt.test.ts",
  "test/memory-agent-journal.test.ts",
  "test/memory-answer.test.ts",
  "test/memory-assistance.test.ts",
  "test/memory-expansion.test.ts",
  "test/memory-federated-cache.test.ts",
  "test/memory-json-store.test.ts",
  "test/memory-platform-focus.test.ts",
  "test/memory-portable.test.ts",
  "test/memory-quality.test.ts",
  "test/memory-receipt.test.ts",
  "test/memory-retrieval.test.ts",
  "test/memory-service-wire.test.ts",
  "test/memory-symbolic.test.ts",
  "test/memory-transfer-integrity.test.ts",
  "test/memory-utility-agent.test.ts",
  "test/memory-utility-grader.test.ts",
  "test/migration-deliberation-rename.test.ts",
  "test/model-discovery.test.ts",
  "test/model-endpoint.test.ts",
  "test/model-memory-stream.test.ts",
  "test/orchestration-api.test.ts",
  "test/orchestration-patterns.test.ts",
  "test/otlp-exporter.test.ts",
  "test/otlp-log-exporter.test.ts",
  "test/otlp-trace-export.test.ts",
  "test/parse-input.test.ts",
  "test/perception-self-echo.test.ts",
  "test/phase6-db-primitives.test.ts",
  "test/phase8-connector-intent.test.ts",
  "test/pi-models.test.ts",
  "test/position.test.ts",
  "test/probe-api.test.ts",
  "test/production-smoke.test.ts",
  "test/prompt-sections-metric.test.ts",
  "test/prune-channel.test.ts",
  "test/rate-limiter.test.ts",
  "test/readiness-provider-render.test.ts",
  "test/recruit-command.test.ts",
  "test/reply-command.test.ts",
  "test/resolver-registry.test.ts",
  "test/resolver-resolving.test.ts",
  "test/retention.test.ts",
  "test/retrieval-quality.test.ts",
  "test/sample-writer.test.ts",
  "test/sandbox.test.ts",
  "test/score-executor.test.ts",
  "test/score-shape.test.ts",
  "test/score.test.ts",
  "test/secret-redaction.test.ts",
  "test/seed-registry.test.ts",
  "test/snapshot-compaction.test.ts",
  "test/spawn-gate-sites.test.ts",
  "test/standing-durable-identity.test.ts",
  "test/steer-dedup.test.ts",
  "test/structured-logs.test.ts",
  "test/successor-benchmark.test.ts",
  "test/task-node-type.test.ts",
  "test/tool-call-normalize.test.ts",
  "test/tool-policy.test.ts",
  "test/tools-deferred.test.ts",
  "test/trace-analytics.test.ts",
  "test/trace-dataset.test.ts",
  "test/trace-evaluation.test.ts",
  "test/trace-projection.test.ts",
  "test/trace-query.test.ts",
  "test/trace-routing-advice.test.ts",
  "test/trait-metadata-migration.test.ts",
  "test/transactions.test.ts",
  "test/url-guard.test.ts",
  "test/watch-spec.test.ts",
  "test/watching-role.test.ts",
  "test/workspace-gateway.test.ts",
  "test/workspace-registry.test.ts",
  "test/worktree.test.ts",
  "test/world-definitions.test.ts",
  "test/world-variants.test.ts",
];

function loadTimings(): Record<string, number> {
  if (!existsSync(TIMING_PATH)) return {};
  try {
    return (
      (JSON.parse(readFileSync(TIMING_PATH, "utf8")) as { files?: Record<string, number> }).files ??
      {}
    );
  } catch {
    return {};
  }
}

function isHeavy(file: string): boolean {
  const src = readFileSync(resolve(ROOT, file), "utf8");
  return HEAVY_MARKERS.some((marker) => src.includes(marker));
}

/** Recompute the rule from the snapshot + sources. */
export function computeFastFiles(timings: Record<string, number>): string[] {
  const glob = new Bun.Glob("test/*.test.ts");
  const all = [...glob.scanSync({ cwd: ROOT })].sort();
  return all.filter((file) => {
    const ms = timings[file];
    return typeof ms === "number" && ms <= FAST_MAX_MS && !isHeavy(file);
  });
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
  const timings = loadTimings();

  const present = FAST_FILES.filter((f) => existsSync(resolve(ROOT, f)));
  const missing = FAST_FILES.filter((f) => !existsSync(resolve(ROOT, f)));
  const estimatedMs = present.reduce((sum, f) => sum + (timings[f] ?? 0), 0);

  if (own.includes("--check")) {
    const fresh = computeFastFiles(timings);
    const listed = new Set(FAST_FILES);
    const add = fresh.filter((f) => !listed.has(f));
    const drop = FAST_FILES.filter((f) => !fresh.includes(f));
    console.log(`listed: ${FAST_FILES.length}, qualifying now: ${fresh.length}`);
    if (missing.length) console.log(`missing on disk: ${missing.join(", ")}`);
    if (add.length) console.log(`should be added (${add.length}):\n  ${add.join("\n  ")}`);
    if (drop.length) {
      console.log(`no longer qualify (${drop.length}):`);
      for (const f of drop) {
        const ms = timings[f];
        const why =
          typeof ms !== "number"
            ? "no timing"
            : ms > FAST_MAX_MS
              ? `${ms} ms > ${FAST_MAX_MS}`
              : "boots engine/server";
        console.log(`  ${f} (${why})`);
      }
    }
    if (!add.length && !drop.length && !missing.length) console.log("FAST_FILES is up to date");
    console.log("\n// paste over FAST_FILES:");
    console.log(`${fresh.map((f) => `  "${f}",`).join("\n")}`);
    process.exit(add.length || drop.length || missing.length ? 1 : 0);
  }

  if (own.includes("--list")) {
    for (const f of present) console.log(`${f} (${timings[f] ?? "?"} ms)`);
    console.log(
      `\n${present.length} files, ~${(estimatedMs / 1000).toFixed(1)}s estimated (serial)`,
    );
    if (missing.length) console.log(`skipped (missing): ${missing.join(", ")}`);
    return;
  }

  for (const f of missing) console.warn(`[test-fast] skipping missing file ${f}`);
  console.log(
    `[test-fast] ${present.length} files, ~${(estimatedMs / 1000).toFixed(1)}s estimated`,
  );
  const started = performance.now();
  const proc = Bun.spawn(
    ["bun", "test", ...IGNORE, ...parallelArgs(own, passthrough), ...passthrough, ...present],
    {
      cwd: ROOT,
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
    },
  );
  const code = await proc.exited;
  console.log(
    `[test-fast] exit ${code} after ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  process.exit(code);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
