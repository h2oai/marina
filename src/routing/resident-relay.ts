// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getErrorMessage } from "../engine/errors";

/**
 * The per-resident command relay. A supervised resident's native process holds
 * no world credential: the supervisor opens a Unix socket bound to the
 * resident's own held connection, and the `marina` CLI inside the process
 * (`MARINA_RELAY_SOCKET`) sends world commands over it. Each command runs on
 * that connection through the normal dispatch path (FIFO, rank, gates,
 * challenges, audit) as the resident, so a credential renewal never affects
 * it and revocation closes it.
 *
 * Location: the user's runtime directory (`XDG_RUNTIME_DIR`), else
 * `~/.marina/relay` — never the temp directory, which native agent sandboxes
 * replace with a private one (the socket would vanish from inside them).
 *
 * Access: the socket lives in a fresh 0700 directory and is itself 0600, so
 * only the supervisor's OS user can connect. (Bun exposes no SO_PEERCRED; the
 * filesystem mode is the fence, and the native process runs as that same
 * user.) Wire format: one JSON line `{"command": "..."}` in, one JSON line
 * `{"ok": boolean, "output": string}` out, then the socket closes.
 *
 * Spool: a sandbox may refuse every socket `connect` while still allowing
 * writes to a granted directory (Codex's network-less `workspace-write`
 * sandbox does). So the same directory holds `spool/`: the CLI writes
 * `<id>.req` (the same JSON, written to a temporary name and renamed), the
 * supervisor claims it, runs the command the same way and answers with
 * `<id>.res`. The CLI uses the spool only when the socket is refused. Files
 * are 0600 in the 0700 directory; the Codex adapter grants exactly this
 * directory as a writable root, never network access.
 */

export const RELAY_SOCKET_ENV = "MARINA_RELAY_SOCKET";
const MAX_REQUEST_BYTES = 64 * 1024;
/** How often the supervisor looks for spooled requests, and the CLI for its answer. */
const SPOOL_POLL_MS = 100;
const SPOOL_ID = /^[a-f0-9-]{8,64}$/;

/** The spool directory beside a relay socket. */
export function relaySpoolDirectory(socketPath: string): string {
  return join(dirname(socketPath), "spool");
}

export interface RelayReply {
  ok: boolean;
  output: string;
}

export type RelayRunner = (command: string) => Promise<RelayReply>;

export interface ResidentRelay {
  /** The socket path handed to the child as MARINA_RELAY_SOCKET. */
  readonly path: string;
  close(): void;
}

/** Where relay directories go: short, per-user, visible inside agent sandboxes. */
export function relayBaseDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR;
  const base = join(homedir(), ".marina", "relay");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}

/** Open a relay in a fresh private directory; resolves once it listens. */
export async function openResidentRelay(
  run: RelayRunner,
  base: string = relayBaseDirectory(),
): Promise<ResidentRelay> {
  const directory = mkdtempSync(join(base, "marina-relay-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "relay.sock");
  const spool = relaySpoolDirectory(path);
  mkdirSync(spool, { mode: 0o700 });
  /** One request line → its reply (socket and spool alike). */
  const handle = async (line: string): Promise<RelayReply> => {
    let command: unknown;
    try {
      command = (JSON.parse(line) as { command?: unknown }).command;
    } catch {
      command = undefined;
    }
    if (typeof command !== "string" || !command.trim())
      return { ok: false, output: 'Relay request must be {"command": "<world command>"}' };
    return run(command.trim()).catch((error) => ({
      ok: false,
      output: getErrorMessage(error),
    }));
  };
  const server: Server = createServer((socket) => {
    let buffer = "";
    let handled = false;
    const reply = (value: RelayReply) => {
      if (socket.writable) socket.end(`${JSON.stringify(value)}\n`);
    };
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        handled = true;
        reply({ ok: false, output: "Relay request too large" });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      void handle(buffer.slice(0, newline)).then(reply);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  let closed = false;
  const claimed = new Set<string>();
  const poll = setInterval(() => {
    let names: string[];
    try {
      names = readdirSync(spool);
    } catch {
      return;
    }
    for (const name of names) {
      const id = name.endsWith(".req") ? name.slice(0, -4) : "";
      if (!SPOOL_ID.test(id) || claimed.has(id)) continue;
      claimed.add(id);
      const file = join(spool, name);
      let line = "";
      try {
        line = readFileSync(file, "utf8");
        unlinkSync(file);
      } catch {
        claimed.delete(id);
        continue;
      }
      const answer = (value: RelayReply) => {
        claimed.delete(id);
        if (closed) return;
        const temporary = join(spool, `${id}.res.tmp`);
        try {
          writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
          renameSync(temporary, join(spool, `${id}.res`));
        } catch {
          // allow-empty-catch: the relay closed or the CLI gave up; nothing waits for it
        }
      };
      if (line.length > MAX_REQUEST_BYTES) answer({ ok: false, output: "Relay request too large" });
      else void handle(line).then(answer);
    }
  }, SPOOL_POLL_MS);
  poll.unref?.();
  return {
    path,
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Socket errors a sandbox gives for a relay it will not let the CLI reach. */
const REFUSED = new Set(["EPERM", "EACCES", "ECONNREFUSED"]);

/** Send one world command through the relay's spool directory (a sandbox without sockets). */
export async function spoolCommand(
  spool: string,
  command: string,
  timeoutMs = 120_000,
): Promise<RelayReply> {
  const id = crypto.randomUUID();
  const temporary = join(spool, `${id}.req.tmp`);
  writeFileSync(temporary, JSON.stringify({ command }), { mode: 0o600 });
  renameSync(temporary, join(spool, `${id}.req`));
  const answer = join(spool, `${id}.res`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(answer)) {
      const text = readFileSync(answer, "utf8");
      rmSync(answer, { force: true });
      const reply = JSON.parse(text) as RelayReply;
      return { ok: reply.ok === true, output: String(reply.output ?? "") };
    }
    await new Promise((resolve) => setTimeout(resolve, SPOOL_POLL_MS / 2));
  }
  rmSync(join(spool, `${id}.req`), { force: true });
  throw new Error("Relay command timed out");
}

/**
 * Send one world command: over the socket, else — when a sandbox refuses the
 * socket and the spool is reachable — through the spool.
 */
export async function relayCommand(
  path: string,
  command: string,
  timeoutMs = 120_000,
): Promise<RelayReply> {
  try {
    return await socketCommand(path, command, timeoutMs);
  } catch (error) {
    const code = (error as { code?: string }).code;
    const spool = relaySpoolDirectory(path);
    if (code && REFUSED.has(code) && existsSync(spool))
      return spoolCommand(spool, command, timeoutMs).catch((spoolError) => {
        throw new Error(
          `${getErrorMessage(error).replace(/\)$/, "")}; spool: ${getErrorMessage(spoolError)})`,
        );
      });
    throw error;
  }
}

/** Send one world command over a relay socket (the CLI side). */
function socketCommand(path: string, command: string, timeoutMs: number) {
  return new Promise<RelayReply>((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Relay command timed out"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ command })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(
        Object.assign(new Error(`Marina relay unavailable (${getErrorMessage(error)})`), {
          code: (error as { code?: string }).code,
        }),
      );
    });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        const reply = JSON.parse(buffer.trim()) as RelayReply;
        resolve({ ok: reply.ok === true, output: String(reply.output ?? "") });
      } catch {
        reject(new Error("Marina relay closed without a reply"));
      }
    });
  });
}
