// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { Bot } from "grammy";
import type { Connection, Perception } from "../types";
import type { Adapter, AdapterContext } from "./adapter";
import { formatPerception } from "./formatter";

export class TelegramAdapter implements Adapter {
  readonly name = "telegram";
  readonly protocol = "telegram";
  private bot: Bot;
  private ctx: AdapterContext;
  private chatConnections = new Map<number, string>(); // chatId -> connId
  private connIdCounter = 0;

  constructor(ctx: AdapterContext, token: string) {
    this.ctx = ctx;
    this.bot = new Bot(token);
    this.loadPersistedMappings();
    this.setupHandlers();
  }

  /** Restore chat→connection mappings from DB so users don't have to re-identify after restart. */
  private loadPersistedMappings(): void {
    const db = this.ctx.db;
    if (!db) return;
    const mappings = db.getAdapterUserMappings("telegram");
    for (const m of mappings) {
      const chatId = Number(m.platform_user_id);
      if (Number.isNaN(chatId)) continue;

      const connId = `telegram_${++this.connIdCounter}`;
      const engine = this.ctx.engine;

      const conn: Connection = {
        id: connId,
        protocol: "websocket" as const,
        entity: null,
        connectedAt: Date.now(),
        send() {
          // No active Telegram context after restart — messages will be
          // delivered once the user sends a new message and we get a fresh ctx.
        },
        close: () => {
          this.chatConnections.delete(chatId);
        },
      };

      engine.addConnection(conn);
      const result = engine.login(connId, m.entity_name);
      if ("error" in result) {
        engine.removeConnection(connId);
        db.deleteAdapterUserMapping("telegram", m.platform_user_id);
        continue;
      }
      this.chatConnections.set(chatId, connId);
    }
  }

  private setupHandlers(): void {
    const engine = this.ctx.engine;
    const rateLimiter = this.ctx.rateLimiter;
    const chatConns = this.chatConnections;

    this.bot.command("start", async (ctx) => {
      await ctx
        .reply("Welcome to Marina! Send your character name to log in, or /help for commands.")
        .catch(() => {});
    });

    this.bot.on("message:text", async (ctx) => {
      try {
        const chatId = ctx.chat.id;
        const text = ctx.message.text;

        // Skip bot commands other than /start
        if (text.startsWith("/")) return;

        const existingConnId = chatConns.get(chatId);

        if (!existingConnId) {
          // Not connected — treat as login
          const connId = `telegram_${++this.connIdCounter}`;

          const conn: Connection = {
            id: connId,
            protocol: "websocket" as const, // generic protocol for type compat
            entity: null,
            connectedAt: Date.now(),
            send(perception: Perception) {
              const formatted = formatPerception(perception, "markdown");
              ctx.reply(formatted).catch(() => {});
            },
            close() {
              chatConns.delete(chatId);
            },
          };

          engine.addConnection(conn);
          chatConns.set(chatId, connId);

          // Try to login
          const result = engine.login(connId, text.trim());
          if ("error" in result) {
            await ctx.reply(result.error).catch(() => {});
            engine.removeConnection(connId);
            chatConns.delete(chatId);
            return;
          }

          this.persistMapping(chatId, text.trim());
          await ctx.reply(`Logged in as ${text.trim()}. Type commands to play!`).catch(() => {});
          return;
        }

        // Already connected — process command
        const entityId = engine.getConnectionEntity(existingConnId);
        if (!entityId) {
          // Connection exists but no entity (shouldn't happen, but handle gracefully)
          chatConns.delete(chatId);
          this.removeMapping(chatId);
          await ctx.reply("Session expired. Send your name to log in again.").catch(() => {});
          return;
        }

        // Rate limit
        if (rateLimiter && !rateLimiter.consume(entityId)) {
          await ctx.reply("Rate limited. Please slow down.").catch(() => {});
          return;
        }

        engine.processCommand(entityId, text);
      } catch (err) {
        console.error("[telegram] Message handler error:", err);
      }
    });
  }

  private persistMapping(chatId: number, entityName: string): void {
    this.ctx.db?.saveAdapterUserMapping("telegram", String(chatId), entityName);
  }

  private removeMapping(chatId: number): void {
    this.ctx.db?.deleteAdapterUserMapping("telegram", String(chatId));
  }

  async start(): Promise<void> {
    await this.bot.start({
      onStart: () => console.log("Telegram adapter started."),
    });
  }

  async stop(): Promise<void> {
    // Disconnect all chat connections
    for (const [, connId] of this.chatConnections) {
      this.ctx.engine.removeConnection(connId);
    }
    this.chatConnections.clear();
    this.bot.stop();
  }
}
