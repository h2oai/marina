// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * marina serve <dir> [--fresh] [--json] — the folder's Marina, without a
 * terminal: the same server `marina <dir>` starts (same home, same saved
 * sessions), for programs. Every SDK's `Marina.local(folder)` runs it.
 *
 * Once the server is ready it prints where it is: with `--json`, ONE line on
 * stdout (`marina.local.v1`: url, http, name, pid, folder) and nothing else on
 * stdout; without, a short note on stderr. It stops on SIGTERM, SIGINT, or
 * (with `--json`) when stdin closes: the program that started it went away. It waits for
 * the server to release the folder's database before it exits.
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForDatabaseLease } from "../src/persistence/database-lease";
import { IS_COMPILED } from "../src/runtime-paths";
import { applyCliEnvironment, userMarinaDir } from "./cli-env";
import {
  FOLDER_OWNER,
  type FolderServer,
  freePort,
  projectSlug,
  pushTailLines,
  removeEphemeralDatabase,
  runningFolderServer,
  serverInfoPath,
  spawnFolderServer,
  stopServerProcess,
  waitForReady,
} from "./code";
import { inferCodeDefaultModel } from "./code-model";

export const LOCAL_PROTOCOL = "marina.local.v1";

export interface ServeOptions {
  fresh?: boolean;
  json?: boolean;
}

export interface LocalAnnouncement {
  protocol: typeof LOCAL_PROTOCOL;
  url: string;
  http: string;
  name: string;
  pid: number;
  folder: string;
}

/** Serve a folder until told to stop. Resolves with the exit code. */
export async function serveFolder(target: string, opts: ServeOptions = {}): Promise<number> {
  const dir = resolve(target);
  let isDirectory = false;
  try {
    isDirectory = statSync(dir).isDirectory();
  } catch {
    // allow-empty-catch: reported just below
  }
  if (!isDirectory) {
    console.error(`Not a folder: ${dir}`);
    return 1;
  }
  const projectDirectory = join(userMarinaDir(), "projects", projectSlug(dir));
  applyCliEnvironment({ instanceDir: projectDirectory });
  const fresh = opts.fresh === true;
  const port = await freePort();
  let dbPath: string;
  if (fresh) {
    dbPath = join(tmpdir(), `marina-serve-${port}-${Date.now()}.db`);
  } else {
    const open = await runningFolderServer(projectDirectory);
    if (open) {
      console.error(
        `Marina is already open in this folder (pid ${open.pid}). Close it, or pass --fresh for a separate disposable session.`,
      );
      return 1;
    }
    mkdirSync(projectDirectory, { recursive: true });
    dbPath = join(projectDirectory, "marina.db");
    try {
      await waitForDatabaseLease(dbPath);
    } catch {
      console.error(
        `Another Marina server still holds this folder's database (${dbPath}.instance-lock). Stop it and retry, or pass --fresh.`,
      );
      return 1;
    }
  }
  const serverHome = fresh ? `${dbPath}.home` : projectDirectory;
  if (IS_COMPILED) mkdirSync(serverHome, { recursive: true });
  const server = spawnFolderServer({
    dir,
    port,
    dbPath,
    serverHome,
    defaultModel: inferCodeDefaultModel(process.env),
  });
  const tail: string[] = [];
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    let carry = "";
    for await (const chunk of server.stderr) {
      carry += decoder.decode(chunk, { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      pushTailLines(tail, lines);
    }
    if (carry) pushTailLines(tail, [carry]);
  })().catch(() => {
    // allow-empty-catch: the stream closed with the child; the tail keeps what arrived
  });

  let stopping: Promise<number> | undefined;
  const stop = (code: number) => {
    stopping ??= (async () => {
      if ((await stopServerProcess(server)) === "killed")
        console.error("The server did not stop in time; killed it.");
      if (fresh) removeEphemeralDatabase(dbPath);
      else rmSync(serverInfoPath(projectDirectory), { force: true });
      return code;
    })();
    return stopping;
  };
  const stopped = new Promise<number>((done) => {
    const onSignal = () => void stop(0).then(done);
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    // For a program (`--json`): when it goes away, its pipe to our stdin
    // closes, and we stop with it. A person's `marina serve` ignores stdin.
    if (opts.json) {
      process.stdin.on("end", onSignal);
      process.stdin.on("close", onSignal);
      process.stdin.resume();
    }
    // The server died on its own: report it, and exit with it.
    void server.exited.then(() => {
      if (!stopping) {
        console.error("The Marina server stopped.");
        void stop(1).then(done);
      }
    });
  });

  if (!(await waitForReady(port, server, 90_000))) {
    await Promise.race([stderrDone, new Promise((r) => setTimeout(r, 1_000))]);
    console.error("The Marina server did not come up in time.");
    for (const line of tail) console.error(`  ${line}`);
    return stop(1);
  }
  if (!fresh) {
    writeFileSync(
      serverInfoPath(projectDirectory),
      JSON.stringify({ pid: server.pid, port, startedAt: Date.now() } satisfies FolderServer),
      { mode: 0o600 },
    );
  }
  const announcement: LocalAnnouncement = {
    protocol: LOCAL_PROTOCOL,
    url: `ws://127.0.0.1:${port}`,
    http: `http://127.0.0.1:${port}`,
    name: FOLDER_OWNER,
    pid: server.pid,
    folder: dir,
  };
  if (opts.json) process.stdout.write(`${JSON.stringify(announcement)}\n`);
  else
    console.error(
      `Marina is serving ${dir} at ${announcement.url} (log in as ${FOLDER_OWNER}). Ctrl-C stops it.`,
    );
  return stopped;
}
