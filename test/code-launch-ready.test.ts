// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The folder launcher probes a free port, then boots its server on it. Between
// the probe and the bind (seconds on a loaded machine) another process can take
// the port; the launcher must then never treat that other server as its own.

import { afterEach, expect, test } from "bun:test";
import { waitForReady } from "../scripts/code";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true);
});

function setupStatus(pid: number) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new URL(req.url).pathname === "/api/setup-status"
        ? Response.json({ instanceName: "project", pid })
        : new Response("not found", { status: 404 }),
  });
  servers.push(server);
  return server.port!;
}

test("ready only when the answer comes from the launched child", async () => {
  const port = setupStatus(4242);
  const child = Promise.withResolvers<number>();
  expect(await waitForReady(port, { pid: 4242, exited: child.promise }, 5_000)).toBe(true);
});

test("a foreign server on the port is not ready; the child's exit ends the wait", async () => {
  const port = setupStatus(4242);
  const child = Promise.withResolvers<number>();
  // Our child lost the bind and exits; the other instance keeps answering.
  setTimeout(() => child.resolve(1), 300);
  const started = performance.now();
  expect(await waitForReady(port, { pid: 999_999, exited: child.promise }, 20_000)).toBe(false);
  expect(performance.now() - started).toBeLessThan(10_000);
});
