// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Black-box service proof. Provisioning and process control are operator work;
 * the Python agent and TypeScript client only use public HTTP and scoped keys. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MarinaMemoryClient, MemoryClientError } from "../src/sdk/memory-client";

const root = resolve(import.meta.dir, "..");
type Credential = { token: string; principalId: string; spaceId: string; credentialId: string };

async function run(argv: string[], env?: Record<string, string | undefined>) {
  const child = Bun.spawn(argv, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0)
    throw new Error(`Qualification subprocess failed (${status}): ${error.slice(-3000)}`);
  return JSON.parse(output.trim().split("\n").at(-1)!);
}

export async function qualifyMemoryService(
  options: { embeddings?: "none" | "local"; modelCache?: string } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "marina-memory-proof-"));
  const db = join(directory, "memory.db");
  let server: ReturnType<typeof Bun.spawn> | undefined;
  const timings: number[] = [];
  async function start() {
    const argv = [
      process.execPath,
      "run",
      "scripts/memory.ts",
      "serve",
      "--db",
      db,
      "--port",
      "0",
      "--embeddings",
      options.embeddings ?? "none",
    ];
    if (options.modelCache) argv.push("--model-cache", options.modelCache);
    server = Bun.spawn(argv, { cwd: root, stdout: "pipe", stderr: "pipe" });
    const proc = server;
    const error = new Response(proc.stderr as ReadableStream).text();
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const deadline = Date.now() + 90_000;
    let buffer = "";
    const timer = setTimeout(() => proc.kill(), 90_000);
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done)
          throw new Error(`Memory server exited before readiness: ${(await error).slice(-3000)}`);
        buffer += new TextDecoder().decode(value);
        let split = buffer.indexOf("\n");
        while (split >= 0) {
          const line = buffer.slice(0, split);
          buffer = buffer.slice(split + 1);
          if (line.startsWith("{")) {
            const ready = JSON.parse(line);
            if (ready.ready) return ready as { url: string; capabilities: Record<string, unknown> };
          }
          split = buffer.indexOf("\n");
        }
      }
      throw new Error("Memory server readiness timed out");
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }
  async function stop(signal: "SIGTERM" | "SIGKILL") {
    if (!server) return;
    server.kill(signal);
    await server.exited;
    server = undefined;
  }
  async function denied(action: () => Promise<unknown>, status: number) {
    try {
      await action();
      throw new Error(`Expected denial ${status}`);
    } catch (error) {
      if (!(error instanceof MemoryClientError) || error.status !== status) throw error;
    }
  }
  try {
    const credentials: Credential[] = [];
    for (const name of ["owner", "other"]) {
      const path = join(directory, `${name}.json`);
      await run([
        process.execPath,
        "run",
        "scripts/memory.ts",
        "init",
        "--db",
        db,
        "--name",
        name,
        "--credentials",
        path,
      ]);
      credentials.push(JSON.parse(readFileSync(path, "utf8")));
    }
    const [owner, other] = credentials as [Credential, Credential];
    let ready = await start();
    const before = new MarinaMemoryClient(ready.url, owner.token);
    const empty = await before.search(owner.spaceId, { query: "vegan diet", mode: "lexical" });
    if (empty.results.length) throw new Error("Fresh proof space was not empty");
    const agentEnv = () => ({
      PYTHONPATH: join(root, "src/sdk"),
      PYTHONDONTWRITEBYTECODE: "1",
      MARINA_MEMORY_URL: ready.url,
      MARINA_MEMORY_TOKEN: owner.token,
      MARINA_MEMORY_SPACE: owner.spaceId,
      MARINA_MEMORY_SEMANTIC: options.embeddings === "local" ? "1" : "0",
    });
    const agent = ["python3", "examples/memory-service/agent.py"];
    const learn = await run([...agent, "learn"], agentEnv());
    await stop("SIGKILL"); // No graceful shutdown or in-process DB handle assists recovery.
    const restartAt = performance.now();
    ready = await start();
    timings.push(performance.now() - restartAt);
    const resumed = await run([...agent, "resume"], agentEnv());
    const client = new MarinaMemoryClient(ready.url, owner.token);
    const stranger = new MarinaMemoryClient(ready.url, other.token);
    await denied(() => stranger.search(owner.spaceId, { query: "office" }), 404);
    await client.grant(owner.spaceId, other.principalId, "reader");
    const shared = await stranger.search(owner.spaceId, { query: "office", mode: "lexical" });
    if (shared.results[0]?.content !== "My office is in Paris.")
      throw new Error("Explicit sharing did not return the current revision");
    await denied(() => stranger.remember(owner.spaceId, { content: "unauthorized change" }), 404);
    await client.grant(owner.spaceId, other.principalId, null);
    await denied(() => stranger.search(owner.spaceId, { query: "office" }), 404);
    const space = await client.space(owner.spaceId);
    const receipt = await client.forget(
      owner.spaceId,
      { all: true, expected_generation: space.generation },
      "forget-space",
    );
    const replay = await client.forget(
      owner.spaceId,
      { all: true, expected_generation: space.generation },
      "forget-space",
    );
    if (JSON.stringify(receipt) !== JSON.stringify(replay))
      throw new Error("Forget receipt changed on retry");
    await denied(() => client.search(owner.spaceId, { query: "office" }), 410);
    await stop("SIGTERM");
    return {
      schema: "marina.memory.qualification.v1",
      observed_at: new Date().toISOString(),
      passed: true,
      agent:
        "Separate Python processes with a deterministic policy; HTTP only, no SQLite/server imports",
      restart:
        "SIGKILL after acknowledged source/checkpoint writes, followed by fresh server and agent processes",
      capabilities: ready.capabilities,
      no_memory_results: empty.results.length,
      learn,
      resumed,
      grant_read: true,
      grant_write_denied: true,
      revocation: true,
      space_forget: true,
      restart_ms: timings.map((x) => Math.round(x)),
      limits:
        "Synthetic protocol and small retrieval corpus; not a general LLM task-quality, scale, multi-day or competitor benchmark",
    };
  } finally {
    await stop("SIGKILL");
    rmSync(directory, { recursive: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      embeddings: { type: "string", default: "none" },
      "model-cache": { type: "string" },
      output: { type: "string" },
    },
  });
  if (values.embeddings !== "none" && values.embeddings !== "local")
    throw new Error("--embeddings must be none or local");
  const result = await qualifyMemoryService({
    embeddings: values.embeddings,
    modelCache: values["model-cache"],
  });
  const encoded = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) {
    const path = resolve(values.output);
    if (dirname(path) === path) throw new Error("Invalid output path");
    writeFileSync(path, encoded);
  }
  console.log(encoded);
}
