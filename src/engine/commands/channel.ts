// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManager } from "../../coordination/channel-manager";
import { channelSelf, header, separator } from "../../net/ansi";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";

export function channelCommand(
  channels: ChannelManager,
  getEntity: (id: string) => Entity | undefined,
  logEvent?: (event: EngineEvent) => void,
): CommandDef {
  return {
    name: "channel",
    aliases: ["ch"],
    help: "Real-time messaging channels with persistent history.\nUsage: channel list|listall|join|leave|send|history|create\n\nExamples:\n  channel join research\n  channel send research Found something in the archive\n  channel history research 20\n  channel create alerts",
    handler: (ctx: RoomContext, input) => {
      const entity = getEntity(input.entity);
      if (!entity) return;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase() ?? "list";

      switch (sub) {
        case "list": {
          const myChannels = channels.getEntityChannels(input.entity);
          if (myChannels.length === 0) {
            ctx.send(
              input.entity,
              "You are not in any channels. Use 'channel join <name>' to join one.",
            );
            return;
          }
          const lines = [
            header("Your Channels"),
            separator(),
            ...myChannels.map((ch) => `  [${ch.type}] ${ch.name}`),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "listall": {
          const all = channels.getAllChannels();
          if (all.length === 0) {
            ctx.send(input.entity, "No channels exist yet.");
            return;
          }
          const lines = [
            header("All Channels"),
            separator(),
            ...all.map((ch) => {
              const members = channels.getMembers(ch.id);
              return `  [${ch.type}] ${ch.name} (${members.length} members)`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "join": {
          // ACL note (FEDERATION-TRUST hardening): channels are PUBLIC-BY-DESIGN.
          // The `channels` schema (id, type, name, owner_id, persistence,
          // retention_hours, created_at) has NO visibility / scope / private
          // column, so there is nothing to enforce on join — any logged-in
          // entity may join any channel by name. The per-member can_read /
          // can_write flags in `channel_members` are post-join capabilities,
          // not a join gate. A real visibility model would require: (1) a
          // `visibility` column on `channels` (e.g. public/unlisted/private),
          // (2) an owner-managed invite/grant ACL table, and (3) a join check
          // here that rejects non-invited entities for private channels. That is
          // deliberately NOT implemented as a half-model — see the report.
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: channel join <name>");
            return;
          }
          const ch = channels.getChannelByName(name);
          if (!ch) {
            ctx.send(input.entity, `Channel "${name}" not found.`);
            return;
          }
          if (channels.isMember(ch.id, input.entity)) {
            ctx.send(input.entity, `You are already in channel "${name}".`);
            return;
          }
          channels.addMember(ch.id, input.entity);
          ctx.send(input.entity, `Joined channel "${name}".`);
          return;
        }

        case "leave": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: channel leave <name>");
            return;
          }
          const ch = channels.getChannelByName(name);
          if (!ch) {
            ctx.send(input.entity, `Channel "${name}" not found.`);
            return;
          }
          if (!channels.isMember(ch.id, input.entity)) {
            ctx.send(input.entity, `You are not in channel "${name}".`);
            return;
          }
          channels.removeMember(ch.id, input.entity);
          ctx.send(input.entity, `Left channel "${name}".`);
          return;
        }

        case "send": {
          const name = tokens[1];
          // Common agent mistake (measured in the 2026-09 sweep): omitting the
          // channel name so the JSON payload lands in the name slot. Catch it
          // with a specific correction instead of a generic usage line.
          if (name?.startsWith("{")) {
            ctx.send(
              input.entity,
              "You omitted the channel name — the message cannot come first. Usage: channel send <name> <message>",
            );
            return;
          }
          if (!name || tokens.length < 3) {
            ctx.send(input.entity, "Usage: channel send <name> <message>");
            return;
          }
          const ch = channels.getChannelByName(name);
          if (!ch) {
            ctx.send(input.entity, `Channel "${name}" not found.`);
            return;
          }
          if (!channels.isMember(ch.id, input.entity)) {
            ctx.send(input.entity, `You are not in channel "${name}". Join it first.`);
            return;
          }
          const message = tokens.slice(2).join(" ");
          channels.send(ch.id, input.entity, entity.name, message);
          logEvent?.({
            type: "channel_message",
            entity: input.entity,
            messageId: 0,
            channelName: name,
            content: message,
            timestamp: Date.now(),
          });
          ctx.send(input.entity, channelSelf(name, message), name);
          return;
        }

        case "history": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: channel history <name> [count]");
            return;
          }
          const ch = channels.getChannelByName(name);
          if (!ch) {
            ctx.send(input.entity, `Channel "${name}" not found.`);
            return;
          }
          if (!channels.isMember(ch.id, input.entity)) {
            ctx.send(input.entity, `You are not in channel "${name}".`);
            return;
          }
          const limit = Number.parseInt(tokens[2] ?? "10", 10) || 10;
          const history = channels.getHistory(ch.id, limit);
          if (history.length === 0) {
            ctx.send(input.entity, `No messages in channel "${name}".`);
            return;
          }
          const lines = [
            header(`History: ${name}`),
            separator(),
            ...history.map((m) => `  ${m.senderName}: ${m.content}`),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "create": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: channel create <name>");
            return;
          }
          const existing = channels.getChannelByName(name);
          if (existing) {
            ctx.send(input.entity, `Channel "${name}" already exists.`);
            return;
          }
          const ch = channels.createChannel({
            type: "custom",
            name,
            ownerId: input.entity,
          });
          channels.addMember(ch.id, input.entity);
          logEvent?.({
            type: "coordination_change",
            resource: "channel",
            action: "create",
            entity: input.entity,
            name,
            timestamp: Date.now(),
          });
          ctx.send(input.entity, `Created and joined channel "${name}".`);
          return;
        }

        default:
          ctx.send(
            input.entity,
            "Usage: channel list|listall|join|leave|send|history|create <name> [args]",
          );
      }
    },
  };
}
