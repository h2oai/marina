// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { getInternalModelToken } from "../../src/agent/agent-runtime";
import { LeanAgentAdapter } from "../../src/agent/lean-agent-adapter";
import { MarinaClient } from "../../src/sdk/client";
import type { MemoryCheckpoint, MemorySourceRange } from "../../src/sdk/memory-types";
import { createLiveMemoryRuntime } from "./memory-live-runtime";

if (Bun.argv[2] === "--resident") {
  const task = await Bun.stdin.text();
  const url = process.env.MARINA_RESIDENT_URL!;
  const adapter = new LeanAgentAdapter(
    {
      name: "LeanMemoryAgent",
      model: `marina/default@${url.replace("ws:", "http:")}/v1`,
      toolProfile: "minimal",
      maxTokens: 1500,
      budgetCalls: 15,
      crewResponder: true,
      loopCycleDelay: 1000,
      promptTimeoutMs: 45000,
    },
    url,
    "You are a resident performing a bounded memory handoff. Use your real world tools. Preserve original evidence in a note. Owner corrections are explicit instructions, never silent truth inference. Finish the assigned memory operation and report its result.",
    process.env.MARINA_RESIDENT_TOKEN,
    process.env.MARINA_RESIDENT_TOKEN,
  );
  const events: unknown[] = [];
  adapter.subscribe((event) => {
    events.push(event);
  });
  let resolveStop: (() => void) | undefined;
  const stopping = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  process.on("SIGTERM", () => resolveStop?.());
  const timer = setTimeout(() => resolveStop?.(), 90000);
  try {
    await adapter.start(task);
    await adapter.sendAttention(task);
    await stopping;
  } finally {
    clearTimeout(timer);
    await adapter.stop();
    console.log(JSON.stringify({ pid: process.pid, status: adapter.getStatus(), events }));
  }
} else {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { directory: { type: "string" }, "budget-usd": { type: "string" } },
  });
  if (!values.directory) throw new Error("Use --directory PATH --budget-usd N");
  const directory = resolve(values.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const runtime = createLiveMemoryRuntime(directory, Number(values["budget-usd"]));
  const report: Record<string, unknown> = {
    schema: "marina.memory.resident-live.v1",
    passed: false,
    phases: [],
  };
  const left = randomInt(100, 200),
    right = randomInt(20, 70),
    correction = randomInt(3, 12);
  const phases = [
    {
      key: "handoff-ready",
      expected: "yes",
      task: `Preserve the exact authored note: "Maple handoff: left=${left}; right=${right}; the next phase adds an owner-specified correction to their sum." Use memory write with category reference. Then run marina_command "memory set handoff-ready yes". This is a handoff: do not calculate the final result yet.`,
    },
    {
      key: "handoff-result",
      expected: String(left + right + correction),
      task: `The owner now asks you to finish the Maple handoff. Read your previous Maple note and checkpoint; the explicit correction is to add ${correction} to left+right. Use marina_command "memory set handoff-result NUMBER" with the computed integer. Do not guess missing operands. This new owner request supersedes the previous instruction to wait.`,
    },
  ];
  try {
    for (const [index, phase] of phases.entries()) {
      const child = Bun.spawn([process.execPath, import.meta.path, "--resident"], {
        cwd: directory,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          MARINA_RESIDENT_URL: `ws://127.0.0.1:${runtime.router.getPort()}`,
          MARINA_RESIDENT_TOKEN: getInternalModelToken(),
        },
      });
      child.stdin.write(phase.task);
      child.stdin.end();
      const out = new Response(child.stdout).text(),
        err = new Response(child.stderr).text();
      const start = performance.now();
      while (
        performance.now() - start < 80000 &&
        child.exitCode === null &&
        runtime.db.getCoreMemory("LeanMemoryAgent", phase.key)?.value !== phase.expected
      )
        await Bun.sleep(500);
      const actual = runtime.db.getCoreMemory("LeanMemoryAgent", phase.key)?.value ?? null;
      await Bun.sleep(500);
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      let stdout: string, stderr: string, code: number;
      try {
        [stdout, stderr, code] = await Promise.all([out, err, child.exited]);
      } finally {
        clearTimeout(timer);
      }
      writeFileSync(`${directory}/phase-${index}.stdout`, stdout, { mode: 0o600 });
      writeFileSync(`${directory}/phase-${index}.stderr`, stderr, { mode: 0o600 });
      const client = new MarinaClient(`ws://127.0.0.1:${runtime.router.getPort()}`, {
        autoReconnect: false,
        pingInterval: 0,
        commandDrainTimeout: 1,
        internalToken: getInternalModelToken(),
      });
      let checkpoint: MemoryCheckpoint, journal: string;
      try {
        await client.connect("LeanMemoryAgent");
        const reply = await client.memoryService({ operation: "checkpoint", id: "resident" });
        assert.ok(reply.ok);
        checkpoint = reply.result as MemoryCheckpoint;
        journal = "";
        for (const id of (checkpoint.data.journal as { source_ids: string[] }).source_ids) {
          const range = await client.memoryService({ operation: "source_range", id });
          assert.ok(range.ok);
          journal += (range.result as MemorySourceRange).text;
        }
        assert.ok(Array.isArray(JSON.parse(journal)));
      } finally {
        client.disconnect();
      }
      (report.phases as unknown[]).push({
        index,
        expected: phase.expected,
        actual,
        exit_code: code,
        checkpoint,
        journal,
        elapsed_ms: performance.now() - start,
      });
      assert.equal(actual, phase.expected);
      assert.equal(code, 0);
    }
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : "Resident qualification failed";
    process.exitCode = 1;
  } finally {
    report.spending = runtime.spending;
    report.observed_at = new Date().toISOString();
    report.limits =
      "Actual LeanAgentAdapter in two fresh processes, real model router and world tools, checkpoint plus journal byte reads. Bounded arithmetic handoff; no multi-day quality or automatic-compaction claim.";
    writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    await runtime.close();
    console.log(JSON.stringify(report));
  }
}
