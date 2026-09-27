#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { getErrorMessage } from "../src/engine/errors";

const image = process.argv[2];
if (!image) throw new Error("Usage: qualify:image LOCAL_IMAGE");
const runtime = process.env.CONTAINER_RUNTIME ?? "docker";
const name = `marina-qualification-${crypto.randomUUID()}`;
async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn([runtime, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw new Error(`${runtime} ${args[0]} failed: ${err}`);
  return out.trim();
}
let started = false;
try {
  await run([
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1::3300",
    "-e",
    "MARINA_ALLOW_INSECURE_PUBLIC=true",
    "-e",
    "MARINA_WORLD=empty",
    "-e",
    "MARINA_ROOM_AGENTS=false",
    "-e",
    "AGENT_AUTORESPAWN=false",
    "-e",
    "MCP_PORT=0",
    "-e",
    "LOG_PORT=0",
    image,
  ]);
  started = true;
  const binding = await run(["port", name, "3300/tcp"]);
  const base = `http://${binding.split("\n")[0]}`;
  const deadline = Date.now() + 60000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      healthy = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      /* Container is still starting; the bounded deadline reports failure. */
    }
    if (healthy) break;
    await Bun.sleep(100);
  }
  if (!healthy) throw new Error(`Image did not become healthy: ${await run(["logs", name])}`);
  const dashboard = await fetch(`${base}/dashboard`);
  if (!dashboard.ok || !(await dashboard.text()).includes("<html"))
    throw new Error("Packaged dashboard is missing");
  // Exercise the image's actual catalog/parser and verified recovery scripts.
  await run([
    "exec",
    name,
    "bun",
    "-e",
    `import {readFileSync} from "node:fs"; import {environmentCatalog} from "./src/config/environment"; if(environmentCatalog(readFileSync(".env.example","utf8")).length < 50) throw new Error("Packaged settings catalog is missing");`,
  ]);
  await run([
    "exec",
    name,
    "bun",
    "scripts/backup.ts",
    "backup",
    "/app/data/marina.db",
    "/app/data/qualification-backups",
  ]);
  const backup = await run([
    "exec",
    name,
    "bun",
    "-e",
    `import {readdirSync} from "node:fs";console.log(readdirSync("/app/data/qualification-backups").find(n=>n.endsWith(".db")));`,
  ]);
  await run([
    "exec",
    name,
    "bun",
    "scripts/backup.ts",
    "restore",
    `/app/data/qualification-backups/${backup}`,
    "/app/data/recovered.db",
  ]);
  await run(["stop", "--time", "40", name]);
  const exitCode = await run(["inspect", "--format", "{{.State.ExitCode}}", name]);
  if (exitCode !== "0")
    throw new Error(`Image shutdown exited ${exitCode}: ${await run(["logs", name])}`);
  console.log(`Qualified image ${await run(["image", "inspect", "--format", "{{.Id}}", image])}`);

  console.log(
    "Image qualified: health, dashboard, settings catalog, verified backup and restore, graceful stop.",
  );
} catch (error) {
  console.error(getErrorMessage(error));
  process.exitCode = 1;
} finally {
  if (started) await run(["rm", "--force", "--volumes", name]);
}
