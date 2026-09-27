// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findDurableTwin } from "../src/memory/legacy-projection";
import { MarinaDB } from "../src/persistence/database";
import { acquireDatabaseLease } from "../src/persistence/database-lease";
import { MarinaClient } from "../src/sdk/client";
import { until } from "./helpers";

test("SIGTERM refuses new admission, finishes a slow command and persists pending memory before closing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-shutdown-"));
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
  const port = probe.port!;
  await probe.stop(true);
  writeFileSync(
    join(dir, "marina-plugin.json"),
    JSON.stringify({ name: "drain-fixture", version: "1.0.0", apiVersion: 1, entry: "index.mjs" }),
  );
  writeFileSync(
    join(dir, "index.mjs"),
    `export default { activate(c) { c.registerCommand({ name:"slow-fixture", minRank:0, help:"Wait for a test barrier", async run(ctx) { await Bun.write("started", "yes"); while (!(await Bun.file("release").exists())) await Bun.sleep(10); ctx.reply("slow command completed"); } }); } };`,
  );
  const child = Bun.spawn([process.execPath, "--env-file=/dev/null", resolve("src/main.ts")], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      WS_HOST: "127.0.0.1",
      WS_PORT: String(port),
      MCP_PORT: "0",
      LOG_PORT: "0",
      MARINA_WORLD: "empty",
      MARINA_PLUGINS: dir,
      MARINA_ROOM_AGENTS: "false",
      AGENT_AUTORESPAWN: "false",
      DB_PATH: join(dir, "world.db"),
      ASSETS_DIR: join(dir, "assets"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const client = new MarinaClient(`ws://127.0.0.1:${port}/ws`, {
    autoReconnect: false,
    pingInterval: 0,
    commandDrainTimeout: 30,
  });
  const messages: string[] = [];
  client.on("perception", (p) => {
    messages.push(JSON.stringify(p.data));
  });
  try {
    await until(
      async () => {
        if (child.exitCode !== null) throw new Error((await output).join("\n"));
        try {
          return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
        } catch {
          return false;
        }
      },
      { timeoutMs: 10000 },
    );
    await client.connect("ShutdownAlice");
    await client.command("note Shutdown persistence evidence");
    const command = client.command("slow-fixture");
    await until(() => existsSync(join(dir, "started")), { timeoutMs: 5000 });
    child.kill("SIGTERM");
    await until(async () => (await fetch(`http://127.0.0.1:${port}/health`)).status === 503, {
      timeoutMs: 5000,
    });
    writeFileSync(join(dir, "release"), "yes");
    await command;
    expect(await child.exited).toBe(0);
    expect(messages.join("\n")).toContain("slow command completed");
    const release = acquireDatabaseLease(join(dir, "world.db"));
    release();
    const db = new MarinaDB(join(dir, "world.db"));
    try {
      const note = db
        .getNotesByEntity("ShutdownAlice", 100)
        .find((n) => n.content === "Shutdown persistence evidence")!;
      expect(note).toBeDefined();
      expect(findDurableTwin(db, note.id)).toBeDefined();
      expect(
        db
          .memoryRepository()
          .raw.query("SELECT 1 FROM sqlite_schema WHERE name='legacy_memory_outbox'")
          .get(),
      ).toBeNull();
    } finally {
      db.close();
    }
    expect((await output).join("\n")).not.toContain("Cannot use a closed database");
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error(`${String(error)}\n${(await output).join("\n")}`);
  } finally {
    client.disconnect();
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 25000);
