// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Client, Events, GatewayIntentBits, type Message } from "discord.js";
import type { Connection, Perception } from "../types";
import type { Adapter, AdapterContext } from "./adapter";
import { formatPerception } from "./formatter";

export class DiscordAdapter implements Adapter {
  readonly name = "discord";
  readonly protocol = "discord";
  private client: Client;
  private ctx: AdapterContext;
  private allowedChannels: Set<string>;
  private userConnections = new Map<string, string>(); // discordUserId -> connId
  private connIdCounter = 0;

  constructor(ctx: AdapterContext, token: string, channelIds?: string[]) {
    this.ctx = ctx;
    this.allowedChannels = new Set(channelIds ?? []);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.loadPersistedMappings();
    this.setupHandlers(token);
  }

  /** Restore user→connection mappings from DB so users don't have to re-identify after restart. */
  private loadPersistedMappings(): void {
    const db = this.ctx.db;
    if (!db) return;
    const mappings = db.getAdapterUserMappings("discord");
    for (const m of mappings) {
      // Re-create a connection for each persisted mapping and auto-login
      const connId = `discord_${++this.connIdCounter}`;
      const engine = this.ctx.engine;

      const conn: Connection = {
        id: connId,
        protocol: "websocket" as const,
        entity: null,
        connectedAt: Date.now(),
        send() {
          // No active Discord channel reference after restart — messages will be
          // delivered once the user sends a new message and we get a fresh channel ref.
        },
        close: () => {
          this.userConnections.delete(m.platform_user_id);
        },
      };

      engine.addConnection(conn);
      const result = engine.login(connId, m.entity_name);
      if ("error" in result) {
        engine.removeConnection(connId);
        db.deleteAdapterUserMapping("discord", m.platform_user_id);
        continue;
      }
      this.userConnections.set(m.platform_user_id, connId);
    }
  }

  private setupHandlers(_token: string): void {
    const engine = this.ctx.engine;
    const rateLimiter = this.ctx.rateLimiter;
    const userConns = this.userConnections;
    const allowedChannels = this.allowedChannels;

    this.client.once(Events.ClientReady, (c) => {
      console.log(`[discord] Adapter ready as ${c.user.tag}`);
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      try {
        // Ignore bot messages
        if (message.author.bot) return;

        // Check channel whitelist (empty = all channels)
        if (allowedChannels.size > 0 && !allowedChannels.has(message.channelId)) return;

        const discordUserId = message.author.id;
        const text = message.content.trim();
        if (!text) return;

        const existingConnId = userConns.get(discordUserId);

        if (!existingConnId) {
          // Not connected — treat first message as login name
          const connId = `discord_${++this.connIdCounter}`;

          const conn: Connection = {
            id: connId,
            protocol: "websocket" as const,
            entity: null,
            connectedAt: Date.now(),
            send(perception: Perception) {
              const formatted = formatPerception(perception, "markdown");
              if ("send" in message.channel) {
                (message.channel as { send: (s: string) => Promise<unknown> })
                  .send(formatted)
                  .catch(() => {});
              }
            },
            close() {
              userConns.delete(discordUserId);
            },
          };

          engine.addConnection(conn);
          userConns.set(discordUserId, connId);

          const result = engine.login(connId, text);
          if ("error" in result) {
            await message.reply(result.error).catch(() => {});
            engine.removeConnection(connId);
            userConns.delete(discordUserId);
            return;
          }

          this.persistMapping(discordUserId, text);
          await message.reply(`Logged in as ${text}. Type commands to play!`).catch(() => {});
          return;
        }

        // Already connected — process command
        const entityId = engine.getConnectionEntity(existingConnId);
        if (!entityId) {
          userConns.delete(discordUserId);
          this.removeMapping(discordUserId);
          await message.reply("Session expired. Send your name to log in again.").catch(() => {});
          return;
        }

        // Rate limit
        if (rateLimiter && !rateLimiter.consume(entityId)) {
          await message.reply("Rate limited. Please slow down.").catch(() => {});
          return;
        }

        engine.processCommand(entityId, text);
      } catch (err) {
        console.error("[discord] Message handler error:", err);
      }
    });
  }

  private persistMapping(discordUserId: string, entityName: string): void {
    this.ctx.db?.saveAdapterUserMapping("discord", discordUserId, entityName);
  }

  private removeMapping(discordUserId: string): void {
    this.ctx.db?.deleteAdapterUserMapping("discord", discordUserId);
  }

  async start(): Promise<void> {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      console.warn("[discord] DISCORD_TOKEN not set, skipping.");
      return;
    }
    await this.client.login(token);
    console.log("[discord] Adapter started.");
  }

  async stop(): Promise<void> {
    for (const [, connId] of this.userConnections) {
      this.ctx.engine.removeConnection(connId);
    }
    this.userConnections.clear();
    this.client.destroy();
  }
}
