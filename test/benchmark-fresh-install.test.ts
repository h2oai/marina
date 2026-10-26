// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Zero to a recorded benchmark result with in-world commands only, on a fresh
// world: a temporary working directory (not the checkout), a fresh database,
// a bare PATH (no `bun` on it), and a local stub upstream, so no model is paid
// and nothing is downloaded (the frozen, tracked `smoke` set). The operator
// runs `benchmark list` → `benchmark fetch smoke` → `benchmark run smoke
// model:<id>`; the run must land as a completed ledger row with its items,
// its result file beside the world (never in the checkout).

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MarinaClient, type Perception } from "../src/sdk/client";
import { until } from "./helpers";

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** An OpenAI-compatible stand-in for a local llama.cpp server. */
function stubUpstream() {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models"))
        return Response.json({ object: "list", data: [{ id: "stub", object: "model" }] });
      if (url.pathname.endsWith("/chat/completions")) {
        calls++;
        const body = (await req.json()) as { model?: string };
        return Response.json({
          id: `stub-${calls}`,
          object: "chat.completion",
          created: 1,
          model: body.model ?? "stub",
          choices: [
            { index: 0, message: { role: "assistant", content: "391" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/v1`, calls: () => calls };
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

function text(perceptions: Perception[]): string {
  return perceptions
    .map((p) => p.data?.text ?? p.data?.message ?? "")
    .filter((t): t is string => typeof t === "string")
    .join("\n");
}

test("fresh install: benchmark list → fetch → run → ledger row, in-world only", async () => {
  const cwd = tmp("marina-bench-cwd-");
  const home = tmp("marina-bench-home-");
  const upstream = stubUpstream();
  const port = freePort();
  const child = Bun.spawn([process.execPath, "--no-env-file", resolve("src/main.ts")], {
    cwd,
    env: {
      // No `bun` on PATH: the harness must be started with the server's own Bun.
      PATH: tmp("marina-bench-path-"),
      HOME: home,
      WS_HOST: "127.0.0.1",
      WS_PORT: String(port),
      MCP_PORT: "0",
      LOG_PORT: "0",
      DB_PATH: join(cwd, "marina.db"),
      MARINA_PROFILE: "local",
      MARINA_WORLD: "empty",
      MARINA_ROOM_AGENTS: "false",
      AGENT_AUTORESPAWN: "false",
      LLAMA_BASE_URL: upstream.url,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([out, err]) => `${out}\n${err}`);
  cleanups.push(() => child.kill("SIGKILL"));
  await until(
    async () => {
      if (child.exitCode !== null) throw new Error(await output);
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 20_000 },
  );

  const client = new MarinaClient(`ws://127.0.0.1:${port}`, {
    principal: "person",
    autoReconnect: false,
  });
  cleanups.push(() => client.disconnect());
  await client.connect("operator");

  const list = text(await client.command("benchmark list"));
  expect(list).toContain("smoke");
  expect(list).toMatch(/smoke\s+\S*\s*\[tracked \(ready\)\]|smoke[^\n]*ready/);

  const fetched = text(await client.command("benchmark fetch smoke"));
  expect(fetched).toContain("needs no download");

  const started = text(await client.command("benchmark run smoke model:llama/stub --limit 3"));
  const id = started.match(/br_[0-9a-f]+_[0-9a-z]+/)?.[0];
  expect(id, started).toBeDefined();

  // The ledger row: read the world's own database (WAL; read-only).
  const db = new Database(join(cwd, "marina.db"), { readonly: true });
  cleanups.push(() => db.close());
  let row: { status: string; answered: number; total: number } | null = null;
  await until(
    () => {
      row = db
        .query<{ status: string; answered: number; total: number }, [string]>(
          "SELECT status, answered, total FROM benchmark_runs WHERE id = ?",
        )
        .get(id!);
      return row !== null && row.status !== "running";
    },
    { timeoutMs: 60_000 },
  );
  expect(row, await Promise.race([output, Bun.sleep(100).then(() => "")])).toMatchObject({
    status: "completed",
    answered: 3,
    total: 3,
  });
  const items = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM benchmark_items WHERE run_id = ?")
    .get(id!);
  expect(items?.n).toBe(3);
  expect(upstream.calls()).toBeGreaterThanOrEqual(3);

  // The in-world readout shows it too.
  const result = text(await client.command(`benchmark result ${id}`));
  expect(result).toContain(id!);
  // Its result file sits beside the world, never in the checkout.
  expect(readdirSync(join(cwd, "data", "benchmark-results"))).toContain(`${id}.json`);
  expect(existsSync(join(cwd, "benchmarks"))).toBe(false);
}, 120_000);
