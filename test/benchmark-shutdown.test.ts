// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lookupRunKey, noteRunKeyCall, withRunKey } from "../src/engine/benchmark-run-keys";
import { BenchmarkRunner } from "../src/engine/benchmark-runner";
import { MarinaDB } from "../src/persistence/database";
import { MarinaClient } from "../src/sdk/client";
import { stripAnsi, until } from "./helpers";
import { scopeProcessState } from "./process-state";

test("SIGTERM cancels an unanswered benchmark, records failure and releases the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-benchmark-shutdown-"));
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
  const port = probe.port!;
  await probe.stop(true);
  const child = Bun.spawn([process.execPath, "--no-env-file", resolve("src/main.ts")], {
    cwd: resolve("."),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      WS_HOST: "127.0.0.1",
      WS_PORT: String(port),
      MCP_PORT: "0",
      LOG_PORT: "0",
      MARINA_PROFILE: "local",
      MARINA_WORLD: "empty",
      MARINA_ROOM_AGENTS: "false",
      AGENT_AUTORESPAWN: "false",
      MARINA_LESSONS: "off",
      MARINA_DECISIONS: "off",
      DB_PATH: join(dir, "world.db"),
      ASSETS_DIR: join(dir, "assets"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const logs = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const client = new MarinaClient(`ws://127.0.0.1:${port}/ws`, {
    autoReconnect: false,
    pingInterval: 0,
    commandMode: "correlated",
    commandGrammar: "world",
  });
  let db: Database | undefined;
  let requested = false;
  client.on("perception", (p) => {
    if (JSON.stringify(p.data).includes("model_request")) requested = true;
  });
  try {
    await until(
      async () => {
        if (child.exitCode !== null) throw Error((await logs).join("\n"));
        try {
          return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
        } catch {
          return false;
        }
      },
      { timeoutMs: 10000 },
    );
    await client.connect("BenchmarkSleeper");
    await client.command("channel create model-stalled");
    const output = (
      await client.command(
        "benchmark run smoke model:marina:stalled --limit 1 --concurrency 1 --seed 317",
      )
    )
      .map((p) => p.data.text)
      .join("\n");
    const id = stripAnsi(output).match(/\bid:\s+(\S+)/)?.[1];
    if (!id) throw new Error(output);
    expect(id).toBeDefined();
    await until(() => requested, { timeoutMs: 10000 });
    child.kill("SIGTERM");
    await until(() => child.exitCode !== null, { timeoutMs: 10000 });
    expect(await child.exited).toBe(0);
    db = new Database(join(dir, "world.db"));
    const row = db
      .query(
        "SELECT status,breakdown_json,replicate_group,target_json,seed FROM benchmark_runs WHERE id=?",
      )
      .get(id!);
    expect(row).toMatchObject({
      status: "failed",
      breakdown_json: JSON.stringify({ error: "benchmark interrupted by shutdown" }),
      seed: 317,
    });
    expect((row as { target_json: string }).target_json).toContain("stalled");
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    const text = (await logs).join("\n");
    expect(text).not.toContain("Shutdown deadline exceeded");
    expect(text).not.toContain("Cannot use a closed database");
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw Error(`${String(error)}\n${(await logs).join("\n")}`);
  } finally {
    client.disconnect();
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 25000);

test("an admitted priced call settles after harness cancellation and survives database reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-benchmark-late-cost-"));
  using _state = scopeProcessState({ env: { MARINA_DATA_DIR: dir } });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false,
    finished = false,
    credential = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      credential = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const state = lookupRunKey(credential);
      if (!state) return new Response("Missing run key", { status: 401 });
      entered = true;
      return withRunKey(state, async () => {
        await barrier;
        noteRunKeyCall({ ok: true, costUsd: 0.123 }); // Synthetic price; no provider call.
        finished = true;
        return Response.json({ choices: [{ message: { role: "assistant", content: "4" } }] });
      });
    },
  });
  let db = new MarinaDB(join(dir, "world.db"));
  const runner = new BenchmarkRunner(
    db,
    () => {},
    () => ({ endpoint: `http://127.0.0.1:${server.port}` }),
  );
  try {
    const { id } = runner.start({
      benchmark: "smoke",
      limit: 1,
      concurrency: 1,
      seed: 719,
      model: "fixture/late-cost",
      arm: "bare",
      replicateGroup: "late-cost",
    });
    await until(() => entered, { timeoutMs: 10000 });
    await runner.stopAll();
    expect(lookupRunKey(credential)).toBeUndefined();
    expect(db.getBenchmarkRun(id)).toMatchObject({
      status: "failed",
      cost_usd: 0,
      replicate_group: "late-cost",
    });
    release();
    await until(() => finished, { timeoutMs: 2000 });
    expect(db.getBenchmarkRun(id)).toMatchObject({ status: "failed", cost_usd: 0.123 });
    expect(db.listOutcomes()).toHaveLength(0);
    db.close();
    db = new MarinaDB(join(dir, "world.db"));
    expect(db.getBenchmarkRun(id)).toMatchObject({
      status: "failed",
      cost_usd: 0.123,
      replicate_group: "late-cost",
    });
    expect(() => runner.start({ benchmark: "smoke" })).toThrow("shutting down");
  } finally {
    release();
    await runner.stopAll();
    await server.stop(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
