// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, status as fmtStatus, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { getErrorMessage } from "../errors";
import type { GatewayRuntime } from "../gateway-runtime";
import { getRank } from "../permissions";
import { requiresPersistence } from "./command-messages";

export function gatewayCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  gatewayRuntime?: GatewayRuntime;
  worldName: string;
}): CommandDef {
  return {
    name: "gateway",
    aliases: ["gw"],
    minRank: 5,
    gate: "gateway.connect",
    help: "Bridge to peer Marina instances. Gated capability: earn it via `witness request gateway.connect` or an operator grant (see `standing`). Usage: gateway add <name> <ws-url> | gateway remove <name> | gateway list | gateway status <name> | gateway bridge <name> <channel> | gateway unbridge <name> <channel> | gateway send <name> <entity> <message>",
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const rank = getRank(entity);

      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("gateways"));
        return;
      }
      const db = deps.db;
      const runtime = deps.gatewayRuntime;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub) {
        ctx.send(input.entity, "Usage: gateway add|remove|list|status|bridge|unbridge|send");
        return;
      }

      switch (sub) {
        case "add": {
          const name = tokens[1];
          const url = tokens[2];
          if (!name || !url) {
            ctx.send(input.entity, "Usage: gateway add <name> <ws-url>");
            return;
          }

          if (name.length < 2 || name.length > 40) {
            ctx.send(input.entity, "Gateway name must be 2-40 characters.");
            return;
          }

          if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            ctx.send(input.entity, "Gateway name must be alphanumeric (plus _ and -).");
            return;
          }

          // Validate URL format (ws:// or wss:// with valid host)
          if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
            ctx.send(input.entity, "URL must start with ws:// or wss://");
            return;
          }

          try {
            const parsed = new URL(url.replace(/^ws/, "http"));
            if (
              !parsed.hostname ||
              parsed.hostname === "localhost" ||
              parsed.hostname === "127.0.0.1"
            ) {
              // Allow localhost — common for development
            }
          } catch {
            ctx.send(input.entity, `Invalid WebSocket URL: ${url}`);
            return;
          }

          const existing = db.getGatewayByName(name);
          if (existing) {
            ctx.send(
              input.entity,
              `Gateway "${name}" already exists. Use 'gateway remove ${name}' first.`,
            );
            return;
          }

          const gwId = `gw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          db.createGateway({ id: gwId, name, url, createdBy: entity.name });

          if (runtime) {
            try {
              await runtime.addGateway(name, url);
              ctx.send(input.entity, `Gateway "${name}" connected to ${url}.`);
            } catch (err) {
              ctx.send(
                input.entity,
                `Gateway "${name}" saved but failed to connect: ${getErrorMessage(err)}`,
              );
            }
          } else {
            ctx.send(input.entity, `Gateway "${name}" saved. Will connect on next restart.`);
          }
          return;
        }

        case "remove": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: gateway remove <name>");
            return;
          }

          const gw = db.getGatewayByName(name);
          if (!gw) {
            ctx.send(input.entity, `Gateway "${name}" not found.`);
            return;
          }

          if (gw.created_by !== entity.name && rank < 9) {
            ctx.send(input.entity, "You can only remove gateways you created, or be sovereign.");
            return;
          }

          if (runtime) {
            await runtime.removeGateway(name);
          }
          db.deleteGateway(gw.id);
          ctx.send(input.entity, `Gateway "${name}" removed.`);
          return;
        }

        case "list": {
          const gateways = db.listGateways();
          if (gateways.length === 0) {
            ctx.send(
              input.entity,
              "No gateways registered. Use 'gateway add <name> <ws-url>' to bridge to a peer.",
            );
            return;
          }

          const lines = [header("Gateways"), separator()];
          for (const gw of gateways) {
            const gwStatus = runtime?.getStatus(gw.name);
            const state = gwStatus?.status ?? gw.status;
            const badge =
              state === "connected" ? fmtStatus("connected", "active") : fmtStatus(state, "warn");
            const bridges = gwStatus?.bridgedChannels.length ?? 0;
            lines.push(
              `  ${bold(gw.name)} \u2014 ${dim(gw.url)} ${badge} ${dim(`${bridges} bridged`)}`,
            );
          }
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "status": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: gateway status <name>");
            return;
          }

          const gw = db.getGatewayByName(name);
          if (!gw) {
            ctx.send(input.entity, `Gateway "${name}" not found.`);
            return;
          }

          const gwInfo = runtime?.getStatus(name);
          const state = gwInfo?.status ?? gw.status;
          const badge =
            state === "connected" ? fmtStatus("connected", "active") : fmtStatus(state, "warn");
          const lines = [
            header(`Gateway: ${bold(name)}`),
            separator(),
            `  URL: ${dim(gw.url)}`,
            `  Status: ${badge}`,
            `  Created by: ${gw.created_by}`,
          ];
          if (gwInfo?.connectedAt) {
            const uptime = Math.floor((Date.now() - gwInfo.connectedAt) / 1000);
            lines.push(`  Connected for: ${uptime}s`);
          }
          if (gwInfo?.error) {
            lines.push(`  Error: ${gwInfo.error}`);
          }
          lines.push(`  Messages relayed: ${gwInfo?.messagesRelayed ?? 0}`);
          const channels = gwInfo?.bridgedChannels ?? [];
          lines.push(`  Bridged channels: ${channels.length === 0 ? "none" : channels.join(", ")}`);
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "bridge": {
          const name = tokens[1];
          const channel = tokens[2];
          if (!name || !channel) {
            ctx.send(input.entity, "Usage: gateway bridge <name> <channel>");
            return;
          }

          if (channel.length > 40 || !/^[a-zA-Z0-9_-]+$/.test(channel)) {
            ctx.send(
              input.entity,
              "Channel name must be alphanumeric (plus _ and -), max 40 chars.",
            );
            return;
          }

          const gw = db.getGatewayByName(name);
          if (!gw) {
            ctx.send(input.entity, `Gateway "${name}" not found.`);
            return;
          }

          db.addGatewayBridge(gw.id, channel);

          if (runtime) {
            try {
              await runtime.bridgeChannel(name, channel);
              ctx.send(input.entity, `Channel "${channel}" bridged on gateway "${name}".`);
            } catch (err) {
              ctx.send(
                input.entity,
                `Bridge saved but failed to join remote channel: ${getErrorMessage(err)}`,
              );
            }
          } else {
            ctx.send(input.entity, "Bridge saved. Will activate on next restart.");
          }
          return;
        }

        case "unbridge": {
          const name = tokens[1];
          const channel = tokens[2];
          if (!name || !channel) {
            ctx.send(input.entity, "Usage: gateway unbridge <name> <channel>");
            return;
          }

          const gw = db.getGatewayByName(name);
          if (!gw) {
            ctx.send(input.entity, `Gateway "${name}" not found.`);
            return;
          }

          db.removeGatewayBridge(gw.id, channel);

          if (runtime) {
            try {
              await runtime.unbridgeChannel(name, channel);
            } catch {
              // Expected: may not be connected
            }
          }
          ctx.send(input.entity, `Channel "${channel}" unbridged from gateway "${name}".`);
          return;
        }

        case "send": {
          const name = tokens[1];
          const target = tokens[2];
          const message = tokens.slice(3).join(" ");
          if (!name || !target || !message) {
            ctx.send(input.entity, "Usage: gateway send <name> <entity> <message>");
            return;
          }

          if (!runtime) {
            ctx.send(input.entity, "Gateway runtime not available.");
            return;
          }

          try {
            await runtime.sendTell(name, target, message, entity.name);
            ctx.send(input.entity, `Message sent to ${target} via gateway "${name}".`);
          } catch (err) {
            ctx.send(input.entity, `Send failed: ${getErrorMessage(err)}`);
          }
          return;
        }

        default:
          ctx.send(
            input.entity,
            "Unknown gateway action. Use: add, remove, list, status, bridge, unbridge, send",
          );
      }
    },
  };
}
