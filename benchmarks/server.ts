#!/usr/bin/env bun
/**
 * Benchmark Web UI Server
 * Serves the web UI and provides API endpoints for running/viewing benchmarks.
 *
 * Usage: bun run benchmarks/server.ts [--port 3303]
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import type { BenchmarkResult } from "./types";

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string", short: "p", default: "3303" },
  },
  strict: false,
});

const PORT = Number.parseInt(args.port ?? "3303", 10);
const RESULTS_DIR = join(import.meta.dir, "results");
const WEBUI_DIR = join(import.meta.dir, "webui");

// --- Active runs tracking ---

interface RunState {
  id: string;
  status: "downloading" | "running" | "complete" | "error";
  progress: number;
  total: number;
  score: number;
  error?: string;
  outputBuffer: { text: string; type: string }[];
  lastPollAt: number;
}

const activeRuns = new Map<string, RunState>();
let runCounter = 0;

// --- Benchmark definitions (mirrors harness.ts registry) ---

const BENCHMARKS = [
  {
    key: "mmlu-pro",
    name: "MMLU-Pro",
    phase: "A",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "12K 10-choice MC questions across 57 subjects",
  },
  {
    key: "ifeval",
    name: "IFEval",
    phase: "A",
    adapter: "ifeval",
    scoring: "ifeval",
    description: "541 prompts with verifiable instruction constraints",
  },
  {
    key: "truthfulqa",
    name: "TruthfulQA MC2",
    phase: "A",
    adapter: "multiple-choice",
    scoring: "accuracy",
    description: "817 MC questions testing truthfulness",
  },
  {
    key: "humaneval",
    name: "HumanEval",
    phase: "A",
    adapter: "code-gen",
    scoring: "pass-at-k",
    description: "164 Python function completion tasks",
  },
  {
    key: "narrativeqa",
    name: "NarrativeQA",
    phase: "B",
    adapter: "free-form",
    scoring: "judge",
    description: "Story comprehension — memory vs no-memory",
  },
  {
    key: "mt-bench",
    name: "MT-Bench",
    phase: "B",
    adapter: "free-form",
    scoring: "judge",
    description: "80 multi-turn conversation quality questions",
  },
  {
    key: "retention",
    name: "Memory Retention",
    phase: "B",
    adapter: "free-form",
    scoring: "accuracy",
    description: "100 cross-session knowledge retention tasks",
  },
];

// --- Results loading ---

function loadAllResults(): BenchmarkResult[] {
  if (!existsSync(RESULTS_DIR)) return [];

  const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json"));
  const results: BenchmarkResult[] = [];

  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf-8"));
      results.push(data);
    } catch {
      // Skip invalid files
    }
  }

  return results.sort((a, b) => b.timestamp - a.timestamp);
}

// --- Run benchmark in subprocess ---

function startBenchmarkRun(config: {
  benchmark: string;
  mode: string;
  compare?: string;
  limit?: string;
  concurrency?: string;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  seed?: string;
}): string {
  const runId = `run-${++runCounter}-${Date.now()}`;

  const state: RunState = {
    id: runId,
    status: "downloading",
    progress: 0,
    total: 0,
    score: 0,
    outputBuffer: [],
    lastPollAt: Date.now(),
  };
  activeRuns.set(runId, state);

  // Build command args
  const cmdArgs = [
    "run",
    "benchmarks/harness.ts",
    "--benchmark",
    config.benchmark,
    "--mode",
    config.mode,
  ];
  if (config.compare) cmdArgs.push("--compare", config.compare);
  if (config.limit) cmdArgs.push("--limit", config.limit);
  if (config.concurrency) cmdArgs.push("--concurrency", config.concurrency);
  if (config.endpoint) cmdArgs.push("--endpoint", config.endpoint);
  if (config.model) cmdArgs.push("--model", config.model);
  if (config.apiKey) cmdArgs.push("--api-key", config.apiKey);
  if (config.seed) cmdArgs.push("--seed", config.seed);

  const proc = Bun.spawn(["bun", ...cmdArgs], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });

  // Read stdout asynchronously
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.replace(/\r/g, "").trim();
          if (!trimmed) continue;
          processOutputLine(state, trimmed);
        }
      }
      // Process remaining buffer
      if (buffer.trim()) processOutputLine(state, buffer.trim());
    } catch {
      // Stream ended
    }
  })();

  // Read stderr
  (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.replace(/\r/g, "").trim();
          if (trimmed) {
            state.outputBuffer.push({ text: trimmed, type: "warn" });
          }
        }
      }
    } catch {
      // Stream ended
    }
  })();

  // Wait for process exit
  proc.exited.then((code) => {
    if (code === 0) {
      state.status = "complete";
      state.outputBuffer.push({
        text: "Benchmark complete",
        type: "success",
      });
    } else {
      state.status = "error";
      state.error = `Process exited with code ${code}`;
      state.outputBuffer.push({
        text: `Process exited with code ${code}`,
        type: "error",
      });
    }
  });

  return runId;
}

function processOutputLine(state: RunState, line: string): void {
  // Parse progress updates like "Progress: 5/100"
  const progressMatch = line.match(/Progress:\s*(\d+)\/(\d+)/);
  if (progressMatch) {
    state.progress = Number.parseInt(progressMatch[1], 10);
    state.total = Number.parseInt(progressMatch[2], 10);
    state.status = "running";
    return; // Don't buffer progress lines
  }

  // Parse score from summary
  const scoreMatch = line.match(/Overall Score:\s*([\d.]+)%/);
  if (scoreMatch) {
    state.score = Number.parseFloat(scoreMatch[1]) / 100;
  }

  // Parse status lines
  if (line.includes("Loading dataset")) {
    state.status = "downloading";
    state.outputBuffer.push({ text: line, type: "info" });
  } else if (line.includes("Running...")) {
    state.status = "running";
    state.outputBuffer.push({ text: line, type: "info" });
  } else if (line.includes("Downloading")) {
    state.status = "downloading";
    state.outputBuffer.push({ text: line, type: "info" });
  } else if (line.includes("Results saved")) {
    state.outputBuffer.push({ text: line, type: "success" });
  } else if (line.includes("Error") || line.includes("error")) {
    state.outputBuffer.push({ text: line, type: "error" });
  } else {
    state.outputBuffer.push({ text: line, type: "info" });
  }
}

// --- MIME types ---

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// --- HTTP Server ---

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // API routes
    if (path.startsWith("/api/")) {
      const resp = await handleApi(req, path);
      // Add CORS headers to all API responses
      for (const [k, v] of Object.entries(CORS_HEADERS)) {
        resp.headers.set(k, v);
      }
      return resp;
    }

    // Serve static files from webui/
    return serveStatic(path);
  },
});

async function handleApi(req: Request, path: string): Promise<Response> {
  // GET /api/health
  if (path === "/api/health") {
    return json({ status: "ok", activeRuns: activeRuns.size });
  }

  // GET /api/benchmarks
  if (path === "/api/benchmarks") {
    return json(BENCHMARKS);
  }

  // GET /api/results
  if (path === "/api/results") {
    return json(loadAllResults());
  }

  // POST /api/run — start a benchmark
  if (path === "/api/run" && req.method === "POST") {
    try {
      const body = await req.json();
      if (!body.benchmark) {
        return json({ error: "benchmark is required" }, 400);
      }
      const runId = startBenchmarkRun(body);
      return json({ runId, status: "started" });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400);
    }
  }

  // GET /api/run/:id — poll run status
  const runMatch = path.match(/^\/api\/run\/(.+)$/);
  if (runMatch && req.method === "GET") {
    const runId = runMatch[1];
    const state = activeRuns.get(runId);
    if (!state) {
      return json({ status: "not_found" }, 404);
    }

    // Drain output buffer (only send new lines since last poll)
    const output = state.outputBuffer.splice(0);
    state.lastPollAt = Date.now();

    const resp: Record<string, unknown> = {
      status: state.status,
      progress: state.progress,
      total: state.total,
      score: state.score,
      output,
    };

    if (state.error) resp.error = state.error;

    // Clean up completed runs after they've been polled
    if (state.status === "complete" || state.status === "error") {
      // Keep for one more poll cycle so the client sees the final state
      setTimeout(() => activeRuns.delete(runId), 5000);
    }

    return json(resp);
  }

  // GET /api/runs — list all active runs
  if (path === "/api/runs") {
    const runs = [...activeRuns.values()].map((r) => ({
      id: r.id,
      status: r.status,
      progress: r.progress,
      total: r.total,
      score: r.score,
    }));
    return json(runs);
  }

  return json({ error: "Not found" }, 404);
}

function serveStatic(path: string): Response {
  const filePath = path === "/" ? "/index.html" : path;
  const fullPath = join(WEBUI_DIR, filePath);

  if (!existsSync(fullPath)) {
    // SPA fallback
    const indexPath = join(WEBUI_DIR, "index.html");
    if (existsSync(indexPath)) {
      return new Response(Bun.file(indexPath), {
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response("Not found", { status: 404 });
  }

  const ext = extname(fullPath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  return new Response(Bun.file(fullPath), {
    headers: { "Content-Type": contentType },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Cleanup stale runs ---
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of activeRuns) {
    // Remove runs that haven't been polled in 5 minutes
    if (now - state.lastPollAt > 300000) {
      activeRuns.delete(id);
    }
  }
}, 60000);

console.log("\n  Marina Benchmark UI");
console.log(`  ${"─".repeat(40)}`);
console.log(`  Server: http://localhost:${PORT}`);
console.log(`  Results: ${RESULTS_DIR}`);
console.log("  Press Ctrl+C to stop\n");
