// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Socket } from "bun";
import type { RateLimiter } from "../auth/rate-limiter";
import { WS_MAX_CONNECTIONS_PER_IP } from "../engine/constants";
import type { Engine } from "../engine/engine";
import { Logger } from "../engine/logger";
import { onboardParticipant } from "../engine/onboarding";
import type { Connection, EntityId, Perception } from "../types";
import { A } from "./ansi";
import { formatPerception } from "./formatter";
import { clientIp } from "./http-utils";
import { resolveWsBindHostname } from "./websocket-server";

/** Module logger: telnet surface lifecycle and socket-level failures. */
const logger = new Logger();

/** Longest line (and pending partial line) a telnet client may send; over it the socket is dropped. */
export const TELNET_MAX_LINE_CHARS = 16 * 1024;
/** Concurrent telnet sockets, all clients combined. */
export const TELNET_MAX_TOTAL_CONNECTIONS = 1000;
/** Concurrent telnet sockets per client address — the same knob as WebSocket (WS_MAX_CONNECTIONS_PER_IP). */
export const TELNET_MAX_CONNECTIONS_PER_IP = WS_MAX_CONNECTIONS_PER_IP;
/** Raw TCP has no proxy headers; `clientIp` then resolves to the socket peer. */
const NO_PROXY_HEADERS = new Request("http://telnet.invalid/");

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strip telnet control chars
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

let telnetIdCounter = 0;

/** Simple line-buffered telnet server using Bun.listen (raw TCP) */
export class TelnetServer {
  private draining = false;
  beginDrain(): void {
    this.draining = true;
  }
  // biome-ignore lint: Bun overloads Bun.listen return type
  private server: any = null;
  private sockets = new Map<string, Socket<TelnetData>>();
  private totalConnections = 0;
  private ipConnections = new Map<string, number>();

  /** Count a new socket against the caps; returns the refusal text when over. */
  admit(ip: string): string | undefined {
    if (this.totalConnections >= TELNET_MAX_TOTAL_CONNECTIONS)
      return "Server is at its telnet connection limit. Try again later.";
    const fromIp = this.ipConnections.get(ip) ?? 0;
    if (fromIp >= TELNET_MAX_CONNECTIONS_PER_IP)
      return "Too many telnet connections from your address.";
    this.totalConnections++;
    this.ipConnections.set(ip, fromIp + 1);
    return undefined;
  }

  release(ip: string | undefined): void {
    if (ip === undefined) return;
    this.totalConnections = Math.max(0, this.totalConnections - 1);
    const left = (this.ipConnections.get(ip) ?? 1) - 1;
    if (left <= 0) this.ipConnections.delete(ip);
    else this.ipConnections.set(ip, left);
  }

  /** Test seam: live counted sockets. */
  get connectionCount(): number {
    return this.totalConnections;
  }

  constructor(
    private engine: Engine,
    private port: number,
    private rateLimiter?: RateLimiter,
  ) {}

  start(): void {
    const self = this;
    const engine = this.engine;
    const sockets = this.sockets;
    const rateLimiter = this.rateLimiter;

    this.server = Bun.listen<TelnetData>({
      // Telnet honors the same bind resolution as every other listener:
      // loopback unless WS_HOST/MARINA_PUBLIC explicitly opts into exposure.
      hostname: resolveWsBindHostname(),
      port: this.port,

      socket: {
        open(socket) {
          const connId = `telnet_${++telnetIdCounter}`;
          // Raw TCP carries no proxy headers: the socket peer is the client.
          const ip = clientIp(NO_PROXY_HEADERS, socket.remoteAddress);
          socket.data = { connId, buffer: "", entity: null, name: null, ip };
          if (self.draining) {
            socket.end();
            return;
          }
          const refusal = self.admit(ip);
          if (refusal) {
            socket.write(`${refusal}\r\n`);
            socket.data.ip = undefined; // never counted, so never released
            socket.end();
            return;
          }
          sockets.set(connId, socket);

          const conn: Connection = {
            id: connId,
            protocol: "telnet",
            entity: null,
            connectedAt: Date.now(),
            ip: socket.remoteAddress,
            // Real TCP peer address from the socket (telnet is never behind a header-proxy here),
            // carried into the unspoofable exec/loopback trust anchor.
            peerIp: socket.remoteAddress,
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
          if (self.draining) {
            socket.write("Instance is draining.\r\n");
            return;
          }
          const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
          // Only the NEW chunk is scanned for a newline, and complete lines are
          // split once — no rescan of the pending partial line per packet.
          const lines = splitTelnetChunk(socket.data, raw);
          if (!lines) {
            socket.write(`\r\nLine too long (limit ${TELNET_MAX_LINE_CHARS} characters).\r\n`);
            socket.end();
            return;
          }

          for (const rawLine of lines) {
            const line = rawLine
              .replace(/\r/g, "") // strip all CR characters, not just trailing
              .replace(CONTROL_CHARS, "") // strip null bytes and control characters
              .trim();

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
                  void onboardParticipant(engine, result.entityId, "telnet", true);
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
              void onboardParticipant(engine, result.entityId, "telnet", false);
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

              // Admission + per-entity FIFO: pasted lines run one after another.
              void engine.dispatchCommand(socket.data.entity, line);
            }
          }

          // Show prompt after processing
          if (socket.data.name) {
            socket.write(`\r\n${formatPrompt(engine, socket.data.entity)}`);
          }
        },

        close(socket) {
          const connId = socket.data.connId;
          self.release(socket.data.ip);
          socket.data.ip = undefined;
          if (!sockets.delete(connId)) return;
          engine.removeConnection(connId);
        },

        error(socket, error) {
          logger.error("telnet", "Telnet socket error", {
            connId: socket.data.connId,
            error,
          });
        },
      },
    });

    logger.info("telnet", `Telnet server listening on port ${this.port}`, { port: this.port });
  }

  stop(): void {
    this.draining = true;
    for (const socket of this.sockets.values()) socket.end();
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
  /** Counted client address; cleared once released so a close never double-counts. */
  ip?: string;
}

/**
 * Append one received chunk and return the complete lines it finished, or
 * `null` when the pending partial line exceeds TELNET_MAX_LINE_CHARS (the
 * caller drops the connection). Linear in the chunk: the pending buffer is
 * never rescanned, and complete lines are split out once.
 */
export function splitTelnetChunk(state: { buffer: string }, chunk: string): string[] | null {
  const firstNewline = chunk.indexOf("\n");
  if (firstNewline === -1) {
    if (state.buffer.length + chunk.length > TELNET_MAX_LINE_CHARS) return null;
    state.buffer += chunk;
    return [];
  }
  const lines = (state.buffer + chunk).split("\n");
  const rest = lines.pop() ?? "";
  if (rest.length > TELNET_MAX_LINE_CHARS) return null;
  for (const line of lines) if (line.length > TELNET_MAX_LINE_CHARS) return null;
  state.buffer = rest;
  return lines;
}
