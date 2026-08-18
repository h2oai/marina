// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { EngineEvent, EntityId } from "../types";

export interface LogEntry {
  timestamp: number;
  category: string;
  text: string;
}

interface LogWSData {
  connId: string;
}

interface LogServerOptions {
  port: number;
  resolveEntity: (id: EntityId) => string | undefined;
}

const MAX_BUFFER = 500;
const VIEWER_INTERVAL_MS = 5000;

export class LogServer {
  private server: Server<LogWSData> | null = null;
  private clients = new Set<ServerWebSocket<LogWSData>>();
  private buffer: string[] = []; // pre-serialized LogEntry JSON strings
  private port: number;
  private resolveEntity: (id: EntityId) => string | undefined;
  private viewerInterval: ReturnType<typeof setInterval> | null = null;

  constructor(opts: LogServerOptions) {
    this.port = opts.port;
    this.resolveEntity = opts.resolveEntity;
  }

  start(): void {
    const htmlPath = resolve(import.meta.dir, "log.html");

    this.server = Bun.serve<LogWSData>({
      port: this.port,
      fetch: (req, server) => {
        const url = new URL(req.url);

        if (url.pathname === "/ws") {
          const upgraded = server.upgrade(req, {
            data: { connId: crypto.randomUUID() },
          });
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(Bun.file(htmlPath), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open: (ws) => {
          this.clients.add(ws);
          // Send buffered entries
          const init = JSON.stringify({
            type: "init",
            entries: this.buffer.map((s) => JSON.parse(s)),
          });
          ws.send(init);
        },
        close: (ws) => {
          this.clients.delete(ws);
        },
        message: () => {
          // Clients don't send meaningful messages
        },
      },
    });

    // Broadcast viewer count periodically
    this.viewerInterval = setInterval(() => {
      if (this.clients.size === 0) return;
      const msg = JSON.stringify({
        type: "viewers",
        count: this.clients.size,
      });
      for (const ws of this.clients) {
        try {
          ws.send(msg);
        } catch (err) {
          console.warn("[log-server] viewer broadcast failed:", (err as Error).message);
          this.clients.delete(ws);
        }
      }
    }, VIEWER_INTERVAL_MS);
  }

  stop(): void {
    if (this.viewerInterval) {
      clearInterval(this.viewerInterval);
      this.viewerInterval = null;
    }
    this.server?.stop();
    this.server = null;
  }

  handleEvent(event: EngineEvent): void {
    const entry = this.formatEvent(event);
    if (!entry) return;

    const serialized = JSON.stringify(entry);

    // Ring buffer
    this.buffer.push(serialized);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.shift();
    }

    // Broadcast to all clients
    if (this.clients.size === 0) return;
    const msg = JSON.stringify({ type: "entry", entry });
    for (const ws of this.clients) {
      try {
        ws.send(msg);
      } catch (err) {
        console.warn("[log-server] entry broadcast failed:", (err as Error).message);
        this.clients.delete(ws);
      }
    }
  }

  private entityName(id: EntityId): string {
    return this.resolveEntity(id) ?? id;
  }

  private formatEvent(event: EngineEvent): LogEntry | null {
    switch (event.type) {
      case "tick":
        return null;

      case "connect":
        return {
          timestamp: event.timestamp,
          category: "connection",
          text: `Connection opened (${event.protocol})`,
        };

      case "disconnect":
        return {
          timestamp: event.timestamp,
          category: "connection",
          text: "Connection closed",
        };

      case "entity_enter":
        return {
          timestamp: event.timestamp,
          category: "movement",
          text: `${this.entityName(event.entity)} entered ${event.room}`,
        };

      case "entity_leave":
        return {
          timestamp: event.timestamp,
          category: "movement",
          text: `${this.entityName(event.entity)} left ${event.room}`,
        };

      case "task_claimed":
        return {
          timestamp: event.timestamp,
          category: "task",
          text: `${this.entityName(event.entity)} claimed task #${event.taskId}`,
        };

      case "task_submitted":
        return {
          timestamp: event.timestamp,
          category: "task",
          text: `${this.entityName(event.entity)} submitted task #${event.taskId}`,
        };

      case "task_approved":
        return {
          timestamp: event.timestamp,
          category: "task",
          text: `Task #${event.taskId} approved`,
        };

      case "task_rejected":
        return {
          timestamp: event.timestamp,
          category: "task",
          text: `Task #${event.taskId} rejected`,
        };

      case "task_released":
        return {
          timestamp: event.timestamp,
          category: "task",
          text: `Task #${event.taskId} released (${event.reason})`,
        };

      case "canvas_publish":
        return {
          timestamp: event.timestamp,
          category: "canvas",
          text: `${this.entityName(event.entity)} published to canvas`,
        };

      case "command":
        return this.formatCommand(event);

      default:
        return null;
    }
  }

  private formatCommand(event: {
    entity: EntityId;
    input: string;
    timestamp: number;
  }): LogEntry | null {
    const raw = event.input.trim();
    const spaceIdx = raw.indexOf(" ");
    const verb = (spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1);
    const name = this.entityName(event.entity);

    switch (verb) {
      case "say":
        return {
          timestamp: event.timestamp,
          category: "chat",
          text: `[say] ${name}: ${rest}`,
        };
      case "shout":
        return {
          timestamp: event.timestamp,
          category: "chat",
          text: `[shout] ${name}: ${rest}`,
        };
      case "emote":
        return {
          timestamp: event.timestamp,
          category: "chat",
          text: `* ${name} ${rest}`,
        };
      default:
        return null;
    }
  }
}
