// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Socket } from "bun";
import type { RateLimiter } from "../auth/rate-limiter";
import type { Engine } from "../engine/engine";
import type { Connection, EntityId, Perception } from "../types";
import { A } from "./ansi";
import { formatPerception } from "./formatter";

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strip telnet control chars
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

let telnetIdCounter = 0;

/** Simple line-buffered telnet server using Bun.listen (raw TCP) */
export class TelnetServer {
  // biome-ignore lint: Bun overloads Bun.listen return type
  private server: any = null;
  private sockets = new Map<string, Socket<TelnetData>>();

  constructor(
    private engine: Engine,
    private port: number,
    private rateLimiter?: RateLimiter,
  ) {}

  start(): void {
    const engine = this.engine;
    const sockets = this.sockets;
    const rateLimiter = this.rateLimiter;

    this.server = Bun.listen<TelnetData>({
      hostname: "0.0.0.0",
      port: this.port,

      socket: {
        open(socket) {
          const connId = `telnet_${++telnetIdCounter}`;
          socket.data = { connId, buffer: "", entity: null, name: null };
          sockets.set(connId, socket);

          const conn: Connection = {
            id: connId,
            protocol: "telnet",
            entity: null,
            connectedAt: Date.now(),
            ip: socket.remoteAddress,
            send(perception: Perception) {
              const text = formatPerception(perception, "ansi");
              if (text) {
                socket.write(`${text}\r\n`);
              }
            },
            close() {
              socket.end();
            },
          };

          engine.addConnection(conn);

          socket.write(`${A.bold}${A.cyan}╔══════════════════════════════════╗${A.reset}\r\n`);
          socket.write(`${A.bold}${A.cyan}║           M A R I N A            ║${A.reset}\r\n`);
          socket.write(`${A.bold}${A.cyan}╚══════════════════════════════════╝${A.reset}\r\n`);
          socket.write("\r\nEnter your name (or token:<TOKEN> to reconnect): ");
        },

        data(socket, data) {
          const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
          socket.data.buffer += raw;

          // Process complete lines
          let newlineIdx: number;
          while ((newlineIdx = socket.data.buffer.indexOf("\n")) !== -1) {
            const line = socket.data.buffer
              .slice(0, newlineIdx)
              .replace(/\r/g, "") // strip all CR characters, not just trailing
              .replace(CONTROL_CHARS, "") // strip null bytes and control characters
              .trim();
            socket.data.buffer = socket.data.buffer.slice(newlineIdx + 1);

            if (!line) continue;

            if (!socket.data.name) {
              // Check for token-based reconnection
              if (line.startsWith("token:")) {
                const token = line.slice(6).trim();
                const result = engine.reconnect(socket.data.connId, token);
                if ("error" in result) {
                  socket.write(`\r\n${result.error}\r\nEnter your name: `);
                } else {
                  socket.data.name = result.name;
                  socket.data.entity = result.entityId;
                  socket.write(`\r\nReconnected as ${result.name}.\r\n\r\n`);
                  engine.sendLook(result.entityId);
                  engine.sendBrief(result.entityId);
                }
                continue;
              }

              // Login phase
              socket.data.name = line;
              const result = engine.login(socket.data.connId, line);
              if ("error" in result) {
                socket.data.name = null;
                socket.write(`\r\n${result.error}\r\nEnter your name: `);
                continue;
              }
              socket.data.entity = result.entityId;
              if (result.token) {
                socket.write(`\r\nWelcome, ${line}. Your session token: ${result.token}\r\n\r\n`);
              } else {
                socket.write(`\r\nWelcome, ${line}.\r\n\r\n`);
              }
              engine.sendLook(result.entityId);
              engine.sendBrief(result.entityId);
              continue;
            }

            // Command phase
            if (socket.data.entity) {
              if (line === "quit" || line === "exit") {
                socket.write("Goodbye.\r\n");
                socket.end();
                return;
              }

              // Rate limit check
              if (rateLimiter && !rateLimiter.consume(socket.data.entity)) {
                socket.write("Rate limited. Please slow down.\r\n");
                continue;
              }

              engine.processCommand(socket.data.entity, line);
            }
          }

          // Show prompt after processing
          if (socket.data.name) {
            socket.write(`\r\n${formatPrompt(engine, socket.data.entity)}`);
          }
        },

        close(socket) {
          const connId = socket.data.connId;
          sockets.delete(connId);
          engine.removeConnection(connId);
        },

        error(socket, error) {
          console.error(`Telnet error [${socket.data.connId}]:`, error);
        },
      },
    });

    console.log(`Telnet server listening on port ${this.port}`);
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }
}

function formatPrompt(engine: Engine, entityId: EntityId | null): string {
  const entity = entityId ? engine.entities.get(entityId) : undefined;
  if (entity?.properties.active_modal !== "code") return "> ";
  const prompt = codePromptForProfile(entity.properties.code_profile);
  return `${A.green}${prompt}>${A.reset} `;
}

function codePromptForProfile(profile: unknown): string {
  if (profile === "pi" || profile === "claude" || profile === "codex") return profile;
  return "code";
}

interface TelnetData {
  connId: string;
  buffer: string;
  entity: EntityId | null;
  name: string | null;
}
