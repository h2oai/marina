// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Elapsed-time resident continuity trial. Explicit directory, resumable report,
 * fresh WebSocket-only resident each cycle, real journal and compaction paths. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { Engine } from "../src/engine/engine";
import { getErrorMessage } from "../src/engine/errors";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { rotateMemoryBackups } from "../src/persistence/db-memory-backups";
import { MarinaClient } from "../src/sdk/client";
import { roomId } from "../src/types";

// Qualification endpoints stay local regardless of deployment defaults.
process.env.WS_HOST = "127.0.0.1";

if (Bun.argv[2] === "--resident") {
  const client = new MarinaClient(Bun.argv[3]!, {
    autoReconnect: false,
    pingInterval: 0,
    commandDrainTimeout: 1,
  });
  const memory = new PlatformMemoryBackend(client);
  const text = (cycle: number) =>
    JSON.stringify([
      { role: "assistant", content: `Resident cycle ${cycle}: original α🙂 evidence` },
    ]);
  const read = async (ids: string[]) => {
    let result = "";
    for (const id of ids) {
      const reply = await client.memoryService({ operation: "source_range", id });
      assert.ok(reply.ok);
      result += (reply.result as { text: string }).text;
    }
    return result;
  };
  try {
    await client.connect("SustainedMemoryResident");
    const prior = await memory.getCheckpoint();
    const previous = Number(prior?.sustained_cycle ?? 0);
    if (previous) {
      assert.equal(await read(prior!.sustained_last_sources as string[]), text(previous));
      assert.equal(await read(prior!.sustained_first_sources as string[]), text(1));
    }
    const cycle = previous + 1;
    const message = JSON.parse(text(cycle))[0];
    await memory.journalMessage(message);
    const journal = (await memory.getCheckpoint())!.journal as { source_ids: string[] };
    assert.equal(await read(journal.source_ids), text(cycle));
    if (cycle % 10 === 0) {
      await memory.archiveContext([message], `Cycle ${cycle} compacted`);
      const archive = (await memory.getCheckpoint())!.archive as { source_ids: string[] };
      assert.equal(await read(archive.source_ids), text(cycle));
    }
    await memory.saveCheckpoint({
      sustained_cycle: cycle,
      sustained_last_sources: journal.source_ids,
      sustained_first_sources: prior?.sustained_first_sources ?? journal.source_ids,
    });
    console.log(
      JSON.stringify({
        cycle,
        first_source_read: true,
        journal_read: true,
        compaction: cycle % 10 === 0,
      }),
    );
  } finally {
    client.disconnect();
  }
} else {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      directory: { type: "string" },
      "duration-ms": { type: "string", default: "172800000" },
      "interval-ms": { type: "string", default: "60000" },
    },
  });
  if (!values.directory)
    throw new Error(
      "--directory is required; report and databases remain there for inspection/resume",
    );
  const duration = Number(values["duration-ms"]),
    interval = Number(values["interval-ms"]);
  if (
    !Number.isSafeInteger(duration) ||
    duration < 1000 ||
    duration > 7 * 86400000 ||
    !Number.isInteger(interval) ||
    interval < 100 ||
    interval > 60000
  )
    throw new Error("Use duration 1 second..7 days and interval 100..60000 ms");
  const directory = resolve(values.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "run.lock"),
    fd = openSync(lock, "wx", 0o600);
  const output = join(directory, "status.json"),
    start = performance.now();
  const previous = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : null;
  const hash = createHash("sha256")
    .update(readFileSync(import.meta.path))
    .digest("hex");
  const sourceRoot = resolve(import.meta.dir, "../src");
  const implementationHash = () => {
    const digest = createHash("sha256");
    for (const file of readdirSync(sourceRoot, { recursive: true })
      .filter((file): file is string => typeof file === "string" && file.endsWith(".ts"))
      .sort()) {
      digest
        .update(file)
        .update("\0")
        .update(readFileSync(join(sourceRoot, file)))
        .update("\0");
    }
    return digest.digest("hex");
  };
  const implementation = implementationHash();

  if (
    previous &&
    (previous.harness_sha256 !== hash ||
      previous.implementation_sha256 !== implementation ||
      previous.target_ms !== duration)
  ) {
    closeSync(fd);
    unlinkSync(lock);
    throw new Error("Resume requires the same harness and target duration; use a new directory");
  }
  const report = {
    schema: "marina.memory.sustained.v1",
    started_at: previous?.started_at ?? new Date().toISOString(),
    harness_sha256: hash,
    implementation_sha256: implementation,
    target_ms: duration,
    active_elapsed_ms: previous?.active_elapsed_ms ?? 0,
    cycles: previous?.cycles ?? 0,
    compactions: previous?.compactions ?? 0,
    restarts: previous?.restarts ?? 0,
    state: "running",
    last_heartbeat: new Date().toISOString(),
    error: null as string | null,
    limits:
      "Deterministic resident using the real WebSocket journal/compaction/checkpoint service. Clean server restarts each cycle. Measures elapsed continuity, not LLM task quality or power-loss tolerance.",
  };
  writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: report.started_at }));
  const baseElapsed = report.active_elapsed_ms;
  const publish = () => {
    report.active_elapsed_ms = baseElapsed + performance.now() - start;
    report.last_heartbeat = new Date().toISOString();
    writeFileSync(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${output}.tmp`, output);
  };
  let stopped = false;
  process.on("SIGTERM", () => {
    stopped = true;
  });
  process.on("SIGINT", () => {
    stopped = true;
  });
  try {
    publish();
    while (!stopped && report.active_elapsed_ms < duration) {
      if (implementationHash() !== implementation)
        throw new Error("Implementation changed during sustained qualification");
      const db = new MarinaDB(join(directory, "world.db"), { durability: "full" });
      const engine = new Engine({ db, startRoom: roomId("trial/start"), tickInterval: 60000 });
      engine.registerRoom(roomId("trial/start"), {
        short: "Private continuity trial",
        long: "Disposable resident memory qualification.",
        exits: {},
      });
      const server = new WebSocketServer(engine, 0);
      server.setDb(db);
      try {
        server.start();
        engine.start();
        const child = Bun.spawn(
          [process.execPath, import.meta.path, "--resident", `ws://127.0.0.1:${server.getPort()}`],
          { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } },
        );
        const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
        let stdout: string, stderr: string, code: number;
        try {
          [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (code) throw new Error(`Resident failed (${code}): ${stderr.slice(-2000)}`);
        const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
        assert.ok(
          result.cycle > report.cycles,
          "Resident checkpoint regressed behind the acknowledged trial state",
        );
        report.cycles = result.cycle;
        if (result.compaction) report.compactions++;
      } finally {
        server.stop();
        await Bun.sleep(30);
        engine.stop();
        db.close();
        report.restarts++;
      }
      if (report.cycles % 60 === 0)
        await rotateMemoryBackups(join(directory, "world.db"), join(directory, "backups"), 3);
      publish();
      if (report.active_elapsed_ms < duration && !stopped)
        await Bun.sleep(Math.min(interval, duration - report.active_elapsed_ms));
    }
    report.state = stopped ? "paused" : "complete";
    publish();
    console.log(JSON.stringify(report));
  } catch (error) {
    report.state = "failed";
    report.error = getErrorMessage(error);
    publish();
    throw error;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
