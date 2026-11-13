// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A child Marina boots from a given source tree on its own port and database,
// answers with its own pid, and stops.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeLoopbackPort, startChildMarina } from "../src/world/child-marina";

test("starts a child Marina from a source tree and stops it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-child-"));
  try {
    const port = await freeLoopbackPort();
    const child = await startChildMarina(
      {
        name: "child-test",
        sourceRoot: process.cwd(),
        dir,
        port,
        env: { MARINA_WORLD: "empty", MCP_PORT: "0", LOG_PORT: "0", MARINA_ENDPOINTS: "none" },
      },
      60_000,
    );
    const status = (await (await fetch(`${child.url}/api/setup-status`)).json()) as {
      pid?: number;
    };
    expect(status.pid).toBe(child.pid);
    await child.stop();
    expect(await child.exited).toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);

test("a child that cannot start says why and leaves nothing running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-child-bad-"));
  try {
    await expect(
      startChildMarina(
        { name: "child-bad", sourceRoot: dir, dir, port: await freeLoopbackPort() },
        3_000,
      ),
    ).rejects.toThrow(/did not become ready/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
