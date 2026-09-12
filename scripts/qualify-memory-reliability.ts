// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Operator harness: disposable databases/processes; the agent subprocess uses HTTP only. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { cycles: { type: "string", default: "20" }, output: { type: "string" } },
});
const cycles = Number(values.cycles);
if (!Number.isInteger(cycles) || cycles < 2 || cycles > 100) throw new Error("Use 2–100 cycles");
const directory = mkdtempSync(join(tmpdir(), "marina-continuity-proof-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
let starts = 0,
  kills = 0,
  lostAcks = 0,
  freshAgents = 0;
const started = performance.now();
async function run(args: string[], env: Record<string, string> = {}, expected = 0) {
  const proc = Bun.spawn([process.execPath, "run", ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 30000);
  try {
    const [output, error, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (status !== expected)
      throw new Error(`Subprocess failed (${status}): ${error.slice(-2000)}`);
    return expected ? null : JSON.parse(output.trim().split("\n").at(-1)!);
  } finally {
    clearTimeout(timer);
  }
}
async function stop() {
  if (!server) return;
  server.kill("SIGKILL");
  await server.exited;
  server = undefined;
  kills++;
}
async function start(path: string): Promise<string> {
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      "scripts/memory.ts",
      "serve",
      "--db",
      path,
      "--port",
      "0",
      "--embeddings",
      "none",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  server = proc;
  const error = new Response(proc.stderr).text();
  const timer = setTimeout(() => proc.kill("SIGKILL"), 30000);
  const reader = proc.stdout.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`Service failed to start: ${(await error).slice(-2000)}`);
      buffer += new TextDecoder().decode(value);
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.startsWith("{")) {
          const ready = JSON.parse(line);
          if (ready.ready) {
            starts++;
            return ready.url;
          }
        }
        end = buffer.indexOf("\n");
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
try {
  const database = join(directory, "memory.db"),
    credentials = join(directory, "owner.json");
  await run([
    "scripts/memory.ts",
    "init",
    "--db",
    database,
    "--name",
    "continuity-agent",
    "--credentials",
    credentials,
  ]);
  const identity = JSON.parse(readFileSync(credentials, "utf8"));
  let url = await start(database);
  const agent = async (cycle: number, phase: string, expected = 0) => {
    freshAgents++;
    return run(
      ["examples/memory-service/reliability-agent.ts"],
      {
        MARINA_MEMORY_URL: url,
        MARINA_MEMORY_TOKEN: identity.token,
        MARINA_MEMORY_SPACE: identity.spaceId,
        MARINA_MEMORY_CYCLE: String(cycle),
        MARINA_MEMORY_PHASE: phase,
      },
      expected,
    );
  };
  for (let cycle = 1; cycle <= cycles; cycle++) {
    if (cycle % 4 === 1) {
      await agent(cycle, "lose-ack", 97);
      lostAcks++;
      await stop();
      url = await start(database);
    }
    await agent(cycle, "write");
    await stop();
    url = await start(database);
    await agent(cycle, "inspect");
  }
  const backup = join(directory, "backup.db"),
    restored = join(directory, "restored.db");
  const receipt = await run(["scripts/memory.ts", "backup", "--db", database, "--output", backup]);
  await stop();
  await run(["scripts/memory.ts", "restore", "--backup", backup, "--db", restored]);
  url = await start(restored);
  const recovery = await agent(cycles, "inspect");
  await stop();
  const report = {
    schema: "marina.memory.reliability-qualification.v1",
    observed_at: new Date().toISOString(),
    passed: true,
    cycles,
    server_starts: starts,
    sigkills: kills,
    fresh_agent_processes: freshAgents,
    lost_acknowledgements: lostAcks,
    source_batch_retry:
      "Same item and batch keys after agent exit before SDK receipt, followed by server SIGKILL",
    assertions: [
      "exactly one source per item",
      "owner storage accounting survives restart and snapshot restore",
      "fresh agent resumes checkpoint",
      "original Unicode bytes preserved",
      "revision CAS rejects stale review",
      "corrected premises invalidate dependents",
      "default retrieval excludes stale conclusions",
      "live WAL snapshot restores credentials, receipts and contents",
    ],
    restored: recovery,
    backup: { sha256: receipt.sha256, bytes: receipt.bytes, verified: receipt.verified },
    elapsed_ms: Math.round(performance.now() - started),
    limits:
      "Deterministic policy and small corpus; process crashes after committed writes, not physical power loss, multiday workload, in-flight tool effects or general LLM task-quality evidence",
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) writeFileSync(values.output, output);
  console.log(output);
} finally {
  await stop();
  rmSync(directory, { recursive: true });
}
