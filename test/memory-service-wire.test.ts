// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { qualifyMemoryService } from "../scripts/qualify-memory-service";
import { MarinaMemoryClient } from "../src/sdk/memory-client";

it("lets an external Python agent resume using only HTTP after the server is killed", async () => {
  const proof = await qualifyMemoryService();
  expect(proof.passed).toBe(true);
  expect(proof.resumed.artifact_integrity).toBe(true);
  expect(proof.resumed.revision_conflict).toBe(true);
  expect(proof.resumed.source_forgetting).toBe(true);
  expect(proof.revocation).toBe(true);
}, 30_000);

/** Contradiction resolution over the wire: a real HTTP server, the TypeScript
 * client seeding the conflict, the dependency-free Python client deciding it. */
it("resolves a contradiction over real HTTP from the Python client with an idempotent key", async () => {
  const root = resolve(import.meta.dir, "..");
  const directory = mkdtempSync(join(tmpdir(), "marina-resolve-wire-"));
  const dbPath = join(directory, "memory.db");
  let server: ReturnType<typeof Bun.spawn> | undefined;
  const run = async (argv: string[], env: Record<string, string> = {}) => {
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
    if (status !== 0) throw new Error(`Subprocess failed (${status}): ${error.slice(-2000)}`);
    return JSON.parse(output.trim().split("\n").at(-1)!);
  };
  try {
    const credentialsPath = join(directory, "owner.json");
    await run([
      process.execPath,
      "run",
      "scripts/memory.ts",
      "init",
      "--db",
      dbPath,
      "--name",
      "owner",
      "--credentials",
      credentialsPath,
    ]);
    const owner = JSON.parse(readFileSync(credentialsPath, "utf8")) as {
      token: string;
      spaceId: string;
    };
    server = Bun.spawn(
      [process.execPath, "run", "scripts/memory.ts", "serve", "--db", dbPath, "--port", "0"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
    let buffer = "";
    let url = "";
    const deadline = Date.now() + 60_000;
    while (!url && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Memory server exited before readiness");
      buffer += new TextDecoder().decode(value);
      for (const line of buffer.split("\n"))
        if (line.startsWith("{") && JSON.parse(line).ready) url = JSON.parse(line).url;
    }
    reader.releaseLock();
    expect(url).toBeTruthy();
    const client = new MarinaMemoryClient(url, owner.token);
    const claim = (value: string) => ({
      subject: "office",
      predicate: "location",
      object: { kind: "literal" as const, value },
    });
    const berlin = await client.remember(owner.spaceId, {
      content: "The office is in Berlin",
      claim: claim("berlin"),
      valid_time: { from: 0, until: null },
    });
    await Bun.sleep(5);
    const paris = await client.remember(owner.spaceId, {
      content: "The office is in Paris",
      claim: claim("paris"),
      valid_time: { from: 100, until: null },
    });
    expect((await client.review(owner.spaceId, { kind: "competing" })).items).toHaveLength(2);
    const python = [
      "python3",
      "-c",
      [
        "import json, os, sys",
        "from marina_memory import MarinaMemory",
        "m = MarinaMemory(os.environ['URL'], os.environ['TOKEN'], os.environ['SPACE'])",
        "first = m.resolve(sys.argv[1], 'last_writer_wins', [sys.argv[2]], 'wire proof', key='wire-resolve')",
        "again = m.resolve(sys.argv[1], 'last_writer_wins', [sys.argv[2]], 'wire proof', key='wire-resolve')",
        "print(json.dumps({'first': first, 'same': first == again, 'pending': m.review(kind='pending')['items']}))",
      ].join("\n"),
      paris.id,
      berlin.id,
    ];
    const decided = await run(python, {
      PYTHONPATH: join(root, "src/sdk"),
      PYTHONDONTWRITEBYTECODE: "1",
      URL: url,
      TOKEN: owner.token,
      SPACE: owner.spaceId,
    });
    expect(decided.same).toBe(true);
    expect(decided.first).toMatchObject({
      policy: "last_writer_wins",
      winner: paris.id,
      superseded: [{ id: berlin.id, version: 2, valid_time: { from: 0, until: 100 } }],
    });
    expect(decided.pending).toEqual([]);
    expect((await client.review(owner.spaceId, { kind: "competing" })).items).toEqual([]);
    expect((await client.get(owner.spaceId, berlin.id)).valid_time).toEqual({
      from: 0,
      until: 100,
    });
    expect((await client.get(owner.spaceId, berlin.id, 1)).valid_time).toEqual({
      from: 0,
      until: null,
    });
  } finally {
    if (server) {
      server.kill("SIGKILL");
      await server.exited;
    }
    rmSync(directory, { recursive: true });
  }
}, 60_000);
