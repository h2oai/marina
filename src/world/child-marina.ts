// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One child Marina process: started from any source tree (this checkout, a
 * child world's, or a worktree of a candidate build), on its own ports and
 * database, never outliving the Marina that started it. World Collective
 * variants and code trials both start children through here.
 */
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { DATA_DIR_PATHS, dataDir } from "../config/data-dir";
import { childSpendEnv } from "../engine/spend-ledger";
import { keySecretIsAutomatic } from "../persistence/key-secret-file";

/** Model caches: read-mostly downloads a child may share with its parent rather than fetch again. */
const SHARED_DATA_DIR_PATHS = new Set([
  "MARINA_MEMORY_EMBEDDING_CACHE",
  "MARINA_CORPUS_EMBEDDING_CACHE",
]);

/**
 * The parent's environment for a child world, minus what belongs to the
 * parent alone:
 *
 * - an automatic key-encryption secret: it belongs to the file next to the
 *   PARENT's database, so the child mints its own beside its database;
 * - the parent's `MARINA_DATA_DIR` and the paths derived from it (auth
 *   database, scratch): the child gets its own data directory, `variantDir`,
 *   so it never writes the parent's `endpoint.json` or opens its auth
 *   database. Model caches stay shared. An explicitly set path still passes;
 * - the embedding lifecycle: no inherited `MARINA_IDLE_SHUTDOWN` (the parent
 *   decides when a child stops) or `MARINA_SINGLE_PORT` (a child keeps the
 *   port layout the collective assigns), and `MARINA_PARENT_PID` names THIS
 *   process, so a child never outlives the Marina that started it.
 */
export function inheritedChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  variantDir?: string,
): NodeJS.ProcessEnv {
  const copy = { ...env };
  if (keySecretIsAutomatic()) delete copy.MARINA_KEY_SECRET;
  delete copy.MARINA_IDLE_SHUTDOWN;
  delete copy.MARINA_SINGLE_PORT;
  copy.MARINA_PARENT_PID = String(process.pid);
  const parentDir = dataDir(env);
  if (parentDir) {
    for (const [key, name] of Object.entries(DATA_DIR_PATHS)) {
      if (SHARED_DATA_DIR_PATHS.has(key)) continue;
      if (copy[key] === join(parentDir, name)) delete copy[key];
    }
    if (variantDir) copy.MARINA_DATA_DIR = resolve(variantDir);
    else delete copy.MARINA_DATA_DIR;
  }
  return copy;
}

/** A setting name that may hold a credential; never handed to an untrusted build. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH)/;

/**
 * The environment for a build whose code is not this server's (a code
 * trial's candidate and base): `PATH`, the locale, and the `MARINA_*`
 * feature settings, with no credential of any kind and no path into this
 * server's data. Model access is given explicitly by the caller.
 */
export function untrustedChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  home: string,
): Record<string, string> {
  const out: Record<string, string> = { HOME: home };
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"]) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  const dataPaths = new Set(["MARINA_DATA_DIR", ...Object.keys(DATA_DIR_PATHS)]);
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !name.startsWith("MARINA_")) continue;
    if (SECRET_NAME.test(name) || dataPaths.has(name)) continue;
    if (/(_PATH|_DIR|_FILE|_LEDGER)$/.test(name)) continue;
    out[name] = value;
  }
  return out;
}

export interface ChildMarinaSpec {
  /** Instance name; also the child's spend scope (`childSpendEnv`). */
  name: string;
  /** Source tree to run (`src/main.ts` under it). */
  sourceRoot: string;
  /** The child's own directory: database, assets and data directory. */
  dir: string;
  /** Database path; defaults to `<dir>/marina.db`. */
  dbPath?: string;
  /** Main port; MCP is `port + 1`, the log port `port + 2`. */
  port: number;
  /** Extra settings, applied last. */
  env?: Record<string, string>;
  /**
   * `trusted` (default): this server's environment (`inheritedChildEnv`) — for
   * code this server already runs. `untrusted`: `untrustedChildEnv` — no
   * credentials, for a build someone else wrote.
   */
  trust?: "trusted" | "untrusted";
}

export interface ChildMarina {
  readonly pid: number;
  readonly port: number;
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  readonly exited: Promise<number>;
  /** True once THIS child answers `/api/setup-status` with its own pid. */
  ready(timeoutMs?: number): Promise<boolean>;
  /** SIGTERM, then SIGKILL after 5 s. */
  stop(): Promise<void>;
  /** `base`, followed by the last lines the child wrote to stderr. */
  why(base: string): string;
}

/** Spawn a child Marina. Await `ready()` before using it. */
export function spawnChildMarina(spec: ChildMarinaSpec): ChildMarina {
  const dir = resolve(spec.dir);
  const child = Bun.spawn([process.execPath, "run", "src/main.ts"], {
    cwd: resolve(spec.sourceRoot),
    env: {
      ...(spec.trust === "untrusted"
        ? untrustedChildEnv(process.env, dir)
        : inheritedChildEnv(process.env, dir)),
      MARINA_PARENT_PID: String(process.pid),
      MARINA_NAME: spec.name,
      // A child spends against its own daily budget ($50 unless the parent
      // sets MARINA_CHILD_DAILY_SPEND_CAP_USD), never more than the parent's
      // own cap; under a shared MARINA_SPEND_LEDGER that budget is a
      // `child:<name>` scope inside the parent's one shared cap.
      ...childSpendEnv(spec.name),
      DB_PATH: spec.dbPath ?? join(dir, "marina.db"),
      ASSETS_DIR: join(dir, "assets"),
      WS_PORT: String(spec.port),
      MCP_PORT: String(spec.port + 1),
      LOG_PORT: String(spec.port + 2),
      // Telnet is plaintext + unauthenticated: descendants never get one
      // (explicit "0" also prevents inheriting the parent's TELNET_PORT,
      // which would collide across children).
      TELNET_PORT: "0",
      AGENT_AUTORESPAWN: "false",
      ...spec.env,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  // Keep the tail of the child's stderr (drained continuously so a chatty
  // child never blocks on a full pipe) — a failed start says WHY.
  let stderrTail = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
      stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(-2_000);
    }
    // allow-empty-catch: the stderr tail is diagnostic only
  })().catch(() => undefined);
  const url = `http://127.0.0.1:${spec.port}`;
  return {
    pid: child.pid,
    port: spec.port,
    url,
    exited: child.exited,
    why(base) {
      const tail = stderrTail.trim().split("\n").slice(-3).join(" | ").slice(-400);
      return tail ? `${base} Last output: ${tail}` : base;
    },
    async ready(timeoutMs = 30_000) {
      // The port was free when chosen, but another process can take it while
      // the child boots; ready means the answer names THIS child's pid.
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) return false;
        try {
          const response = await fetch(`${url}/api/setup-status`, {
            signal: AbortSignal.timeout(500),
          });
          if (response.ok && ((await response.json()) as { pid?: unknown }).pid === child.pid)
            return true;
        } catch {
          // Expected while the child binds its ports and applies migrations.
        }
        await new Promise<void>((done) => setTimeout(done, 250));
      }
      return false;
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill();
      const exited = await Promise.race([
        child.exited.then(() => true),
        new Promise<false>((done) => setTimeout(() => done(false), 5_000)),
      ]);
      if (!exited && child.exitCode === null) {
        child.kill(9);
        await child.exited;
      }
    },
  };
}

/** Spawn a child Marina and wait until it is ready; stops it and throws when it is not. */
export async function startChildMarina(
  spec: ChildMarinaSpec,
  timeoutMs = 30_000,
): Promise<ChildMarina> {
  const child = spawnChildMarina(spec);
  if (await child.ready(timeoutMs)) return child;
  await child.stop();
  throw new Error(
    child.why(
      `Child Marina "${spec.name}" did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`,
    ),
  );
}

/** A loopback port free at the moment of asking (the child's pid check covers a later race). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}
