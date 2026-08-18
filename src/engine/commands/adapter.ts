// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, EntityId, RoomContext } from "../../types";
import { getRank } from "../permissions";

export function adapterCommand(deps: {
  db?: MarinaDB;
  getEntity: (id: EntityId) => Entity | undefined;
  logEvent: (event: EngineEvent) => void;
}): CommandDef {
  return {
    name: "adapter",
    aliases: [],
    minRank: 5,
    gate: "adapter.enable",
    help: `Manage platform adapters (Telegram, Discord, Slack, Signal).
Usage:
  adapter list                        — show adapters and status
  adapter enable <platform> [config]  — enable an adapter
  adapter disable <platform>          — disable an adapter
  adapter status <platform>           — show adapter details`,
    handler: (ctx: RoomContext, input) => {
      if (!deps.db) {
        ctx.send(input.entity, "Adapter management requires database support.");
        return;
      }
      const entity = deps.getEntity(input.entity);
      if (!entity || getRank(entity) < 7) {
        ctx.send(input.entity, "Requires steward rank (7).");
        return;
      }

      const db = deps.db;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub || sub === "list") {
        const adapters = db.getAllAdapters();

        // Also detect env-configured adapters
        const envAdapters: string[] = [];
        if (process.env.TELEGRAM_TOKEN) envAdapters.push("telegram");
        if (process.env.DISCORD_TOKEN) envAdapters.push("discord");

        if (adapters.length === 0 && envAdapters.length === 0) {
          ctx.send(input.entity, "No adapters configured.");
          return;
        }

        const lines = [header("Adapters"), separator()];

        if (envAdapters.length > 0) {
          lines.push(bold("From environment:"));
          for (const name of envAdapters) {
            lines.push(`  ${bold(name)} ${dim("(env var)")}`);
          }
        }

        if (adapters.length > 0) {
          if (envAdapters.length > 0) lines.push("");
          lines.push(bold("From database:"));
          for (const a of adapters) {
            const statusColor = a.status === "active" ? bold(a.status) : dim(a.status);
            lines.push(`  ${bold(a.platform)} ${statusColor} ${dim(`set by ${a.set_by}`)}`);
          }
        }

        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      switch (sub) {
        case "enable": {
          const platform = tokens[1]?.toLowerCase();
          const config = tokens.slice(2).join(" ") || "{}";

          if (!platform) {
            ctx.send(input.entity, "Usage: adapter enable <platform> [config json]");
            return;
          }

          db.saveAdapter({
            platform,
            config,
            status: "active",
            setBy: entity.name,
          });

          deps.logEvent({
            type: "adapter_change",
            platform,
            action: "enable",
            actor: input.entity,
            timestamp: Date.now(),
          });

          ctx.send(
            input.entity,
            `Adapter "${platform}" enabled. Note: runtime activation requires server restart for now.`,
          );
          return;
        }

        case "disable": {
          const platform = tokens[1]?.toLowerCase();
          if (!platform) {
            ctx.send(input.entity, "Usage: adapter disable <platform>");
            return;
          }

          const existing = db.getAdapter(platform);
          if (!existing) {
            ctx.send(input.entity, `Adapter "${platform}" not found.`);
            return;
          }

          db.updateAdapterStatus(platform, "disabled");

          deps.logEvent({
            type: "adapter_change",
            platform,
            action: "disable",
            actor: input.entity,
            timestamp: Date.now(),
          });

          ctx.send(input.entity, `Adapter "${platform}" disabled.`);
          return;
        }

        case "status": {
          const platform = tokens[1]?.toLowerCase();
          if (!platform) {
            ctx.send(input.entity, "Usage: adapter status <platform>");
            return;
          }

          const adapter = db.getAdapter(platform);
          if (!adapter) {
            // Check env
            const envActive =
              (platform === "telegram" && !!process.env.TELEGRAM_TOKEN) ||
              (platform === "discord" && !!process.env.DISCORD_TOKEN);

            if (envActive) {
              ctx.send(
                input.entity,
                `${bold(platform)}: configured via environment variable, active.`,
              );
            } else {
              ctx.send(input.entity, `Adapter "${platform}" not configured.`);
            }
            return;
          }

          const lines = [
            header(`Adapter: ${adapter.platform}`),
            separator(),
            `${bold("Status:")} ${adapter.status}`,
            `${bold("Set by:")} ${adapter.set_by}`,
            `${bold("Updated:")} ${new Date(adapter.updated_at).toISOString()}`,
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        default:
          ctx.send(
            input.entity,
            "Usage: adapter list | adapter enable <platform> | adapter disable <platform> | adapter status <platform>",
          );
      }
    },
  };
}
