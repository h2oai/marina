// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { runTestProcess } from "../scripts/test-backend";

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
