// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import {
  formatProcessTree,
  interruptedFile,
  parsePs,
  processTree,
  runTestProcess,
  testFileHeader,
} from "../scripts/test-backend";

test("suite watchdog preserves failure status and terminates a stuck runner as failure", async () => {
  expect(await runTestProcess([process.execPath, "-e", "process.exit(7)"], 5000)).toBe(7);
  expect(await runTestProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], 150)).toBe(
    124,
  );
});

test.each(["DB log failed", "Daily spend not recorded", "Judge observation not recorded"])(
  "suite watchdog rejects closed-database lifecycle warning: %s",
  async (message) => {
    // Capture the nested runner's intentional diagnostic so the outer suite never
    // mistakes this negative fixture for a real lifecycle leak in its own process.
    const module = new URL("../scripts/test-backend.ts", import.meta.url).pathname;
    const warning = `[event] ${message} {"error":"Cannot use a closed database"}`;
    const code = `import { runTestProcess } from ${JSON.stringify(module)};
    process.exit(await runTestProcess([process.execPath, "-e", ${JSON.stringify(`console.warn(${JSON.stringify(warning)})`)}], 5000));`;
    const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(status).toBe(1);
    expect(stderr).toContain("1 closed-database lifecycle warnings");
  },
);

const RUNNER = new URL("../scripts/test-backend.ts", import.meta.url).pathname;

/** Run `runTestProcess` on `script` in a nested process; capture its status and stderr. */
async function supervise(script: string, options: Record<string, number>) {
  const code = `import { runTestProcess } from ${JSON.stringify(RUNNER)};
  process.exit(await runTestProcess([process.execPath, "-e", ${JSON.stringify(script)}], ${JSON.stringify(options)}));`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { status, stderr };
}

test("reporter lines: file headers (also GitHub-grouped) and the files Bun reports still running", () => {
  expect(testFileHeader("test/a.test.ts:")).toBe("test/a.test.ts");
  expect(testFileHeader("##[group]test/b.test.ts:")).toBe("test/b.test.ts");
  expect(testFileHeader("(pass) test/a.test.ts: x")).toBeUndefined();
  expect(interruptedFile("  test/code-host-git-hardening.test.ts (793s)")).toBe(
    "test/code-host-git-hardening.test.ts",
  );
  expect(interruptedFile("shard 0/3: exit 124 after 900.2s")).toBeUndefined();
});

test("process listing: the run's own tree, with an unreaped child marked", () => {
  const rows = parsePs(
    [
      "  10     1 Ss    0.0 01:00 bun test --parallel",
      "  11    10 Rl   98.5 00:50 bun test --test-worker --isolate",
      "  12    11 Z     0.0 00:49 [git] <defunct>",
      "  13    10 Sl    0.1 00:50 bun test --test-worker --isolate",
      "  99     1 S     0.0 09:00 unrelated",
    ].join("\n"),
  );
  expect(rows).toHaveLength(5);
  const tree = processTree(rows, 10);
  expect(tree.map(({ row, depth }) => [row.pid, depth])).toEqual([
    [10, 0],
    [11, 1],
    [12, 2],
    [13, 1],
  ]);
  const lines = formatProcessTree(tree);
  expect(lines[1]).toContain("[busy]");
  expect(lines[2]).toContain("12 Z");
  expect(lines[2]).toContain("exited, not reaped by its parent");
  expect(lines.join("\n")).not.toContain("unrelated");
});

test("a silent run is stopped as a stall well before the deadline, naming the live processes", async () => {
  const { status, stderr } = await supervise(
    "console.log('started'); setInterval(() => {}, 1000)",
    {
      deadlineMs: 30_000,
      inactivityMs: 300,
      unreapedMs: 0,
      checkEveryMs: 100,
    },
  );
  expect(status).toBe(124);
  expect(stderr).toMatch(/no output for \d+s \(limit 300ms\); the run is stalled/);
  if (process.platform !== "win32") {
    expect(stderr).toContain("Live processes under the test run");
    expect(stderr).toContain("setInterval");
  }
  expect(stderr).toContain("Test runner stopped the run");
});

test.skipIf(process.platform === "win32")(
  "a process blocked with an exited, unreaped child is stopped as stuck",
  async () => {
    // The event loop is blocked, so the exited child is never reaped: the shape
    // of a synchronous spawn that never returns.
    const script = `require("node:child_process").spawn("true");
    const end = Date.now() + 20000; while (Date.now() < end) {}`;
    const { status, stderr } = await supervise(script, {
      deadlineMs: 30_000,
      inactivityMs: 0,
      unreapedMs: 300,
      checkEveryMs: 100,
    });
    expect(status).toBe(124);
    expect(stderr).toMatch(/has not reaped its exited child \d+ for \d+s \(limit 300ms\)/);
    expect(stderr).toContain("exited, not reaped by its parent");
    expect(stderr).toContain("blocked in a synchronous call");
  },
  20_000,
);
