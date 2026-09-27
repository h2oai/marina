#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "..");
const build = Bun.spawn([process.execPath, "run", "build"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (await build.exited) throw new Error("Server bundle build failed");
const directory = mkdtempSync(join(tmpdir(), "marina-bundle-qualification-"));
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
const port = probe.port!;
await probe.stop(true);
const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
const child = Bun.spawn([process.execPath, "--env-file=/dev/null", join(root, "dist/main.js")], {
  cwd: directory,
  env: {
    PATH: process.env.PATH,
    WS_HOST: "127.0.0.1",
    WS_PORT: String(port),
    MCP_PORT: "0",
    LOG_PORT: "0",
    MARINA_WORLD: "empty",
    MARINA_ROOM_AGENTS: "false",
    AGENT_AUTORESPAWN: "false",
    MARINA_DESKTOP_API_TOKEN: token,
    DB_PATH: join(directory, "world.db"),
    ASSETS_DIR: join(directory, "assets"),
  },
  stdout: "pipe",
  stderr: "pipe",
});
const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
const watchdog = setTimeout(() => child.kill("SIGKILL"), 35000);
try {
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error((await output).join("\n"));
    try {
      healthy = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok;
    } catch {
      // Startup is asynchronous; the bounded deadline reports persistent failure.
    }
    if (healthy) break;
    await Bun.sleep(25);
  }
  if (!healthy) throw new Error("Bundled server failed to become healthy");
  for (const path of ["/chat", "/dashboard"]) {
    const response = await fetch(`${base}${path}`);
    const html = await response.text();
    if (!response.ok || !html.includes("<script") || html.includes("Dashboard not built yet"))
      throw new Error(`Bundled server is missing ${path}`);
  }
  const catalog = await fetch(`${base}/api/env`, { headers: { "X-Marina-Desktop-Token": token } });
  if (!catalog.ok || ((await catalog.json()) as unknown[]).length < 50)
    throw new Error("Bundled server is missing its settings catalog");
  const sdk = pathToFileURL(join(root, "src/sdk/dist/index.js")).href;
  const consumer = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "-e",
      `
    import { MarinaAgent } from ${JSON.stringify(sdk)};
    const agent = new MarinaAgent(${JSON.stringify(`ws://127.0.0.1:${port}/ws`)}, { autoReconnect: false, pingInterval: 0 });
    try {
      await agent.connect("BundleNodeAgent");
      const perceptions = await agent.command("look");
      if (!perceptions.some(p => p.kind === "room" || p.data?.text?.includes("The Void"))) throw new Error("No room response");
    } finally { agent.disconnect(); }
  `,
    ],
    { cwd: directory, stdout: "inherit", stderr: "inherit" },
  );
  if (await consumer.exited) throw new Error("Node SDK could not use the bundled server");
  child.kill("SIGTERM");
  if (await child.exited)
    throw new Error(`Bundled server did not stop cleanly: ${(await output).join("\n")}`);
  console.log(
    "Bundled server qualified: external instance directory, builtin world, web assets, settings catalog, Node SDK command and graceful shutdown.",
  );
} finally {
  clearTimeout(watchdog);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
  await output;
  rmSync(directory, { recursive: true, force: true });
}
