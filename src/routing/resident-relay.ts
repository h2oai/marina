// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
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
 */

export const RELAY_SOCKET_ENV = "MARINA_RELAY_SOCKET";
const MAX_REQUEST_BYTES = 64 * 1024;

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
      let command: unknown;
      try {
        command = (JSON.parse(buffer.slice(0, newline)) as { command?: unknown }).command;
      } catch {
        command = undefined;
      }
      if (typeof command !== "string" || !command.trim()) {
        reply({ ok: false, output: 'Relay request must be {"command": "<world command>"}' });
        return;
      }
      run(command.trim()).then(reply, (error) =>
        reply({ ok: false, output: getErrorMessage(error) }),
      );
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
  return {
    path,
    close: () => {
      if (closed) return;
      closed = true;
      server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Send one world command over a relay socket (the CLI side). */
export function relayCommand(path: string, command: string, timeoutMs = 120_000) {
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
      reject(new Error(`Marina relay unavailable (${getErrorMessage(error)})`));
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
