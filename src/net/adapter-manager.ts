/**
 * AdapterManager — runtime manager for external platform adapters.
 *
 * Supports hot-reload: adapters can be started, stopped, and reloaded
 * without restarting the engine. The manager dynamically imports adapter
 * modules to avoid hard dependencies on optional packages (discord.js, grammy).
 */

import type { MarinaDB } from "../persistence/database";
import type { Adapter, AdapterContext } from "./adapter";

export interface AdapterInfo {
  name: string;
  protocol: string;
  running: boolean;
}

export class AdapterManager {
  private adapters = new Map<string, Adapter>();
  private ctx: AdapterContext;

  constructor(ctx: AdapterContext, _db?: MarinaDB) {
    this.ctx = ctx;
  }

  /** Register an already-started adapter (used during initial boot). */
  register(adapter: Adapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** Check if a platform adapter is currently running. */
  isRunning(platform: string): boolean {
    return this.adapters.has(platform);
  }

  /** Start an adapter by platform name. Reads token from process.env. */
  async start(platform: string): Promise<void> {
    if (this.adapters.has(platform)) {
      throw new Error(`Adapter "${platform}" is already running.`);
    }

    const adapter = await this.createAdapter(platform);
    await adapter.start();
    this.adapters.set(platform, adapter);
  }

  /** Stop a running adapter by platform name. */
  async stop(platform: string): Promise<void> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new Error(`Adapter "${platform}" is not running.`);
    }

    await adapter.stop();
    this.adapters.delete(platform);
  }

  /** Stop then restart an adapter (picks up new tokens/config). */
  async reload(platform: string): Promise<void> {
    if (this.adapters.has(platform)) {
      await this.stop(platform);
    }
    await this.start(platform);
  }

  /** List all tracked adapters with running state. */
  list(): AdapterInfo[] {
    return [...this.adapters.values()].map((a) => ({
      name: a.name,
      protocol: a.protocol,
      running: true,
    }));
  }

  /** Stop all running adapters (for graceful shutdown). */
  async stopAll(): Promise<void> {
    const names = [...this.adapters.keys()];
    for (const name of names) {
      try {
        await this.stop(name);
      } catch (err) {
        console.warn(`[adapters] Failed to stop "${name}":`, err);
      }
    }
  }

  // ─── Adapter Factory ──────────────────────────────────────────────────

  private async createAdapter(platform: string): Promise<Adapter> {
    switch (platform) {
      case "telegram": {
        const token = process.env.TELEGRAM_TOKEN;
        if (!token) throw new Error("TELEGRAM_TOKEN is not set.");
        const { TelegramAdapter } = await import("./telegram-adapter");
        return new TelegramAdapter(this.ctx, token);
      }
      case "discord": {
        const token = process.env.DISCORD_TOKEN;
        if (!token) throw new Error("DISCORD_TOKEN is not set.");
        const channelIds = process.env.DISCORD_CHANNEL_IDS?.split(",").filter(Boolean);
        const { DiscordAdapter } = await import("./discord-adapter");
        return new DiscordAdapter(this.ctx, token, channelIds);
      }
      default:
        throw new Error(`Unknown adapter platform: "${platform}"`);
    }
  }
}
