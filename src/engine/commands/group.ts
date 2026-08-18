// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { GroupManager } from "../../coordination/group-manager";
import { bold, dim, entity as fmtEntity, header, rank, separator } from "../../net/ansi";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";

export function groupCommand(
  groups: GroupManager,
  findEntity: (name: string) => Entity | undefined,
  logEvent?: (event: EngineEvent) => void,
): CommandDef {
  return {
    name: "group",
    aliases: ["team"],
    help: "Manage groups (auto-creates channel + board).\nUsage: group list|info|create|join|leave|invite|kick|promote|demote|disband\n\nExamples:\n  group create explorers Exploration Team\n  group join explorers\n  group invite Alice explorers\n  group info explorers",
    handler: (ctx: RoomContext, input) => {
      const self = ctx.getEntity(input.entity);
      if (!self) return;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase() ?? "list";

      // Membership change → coordination_change(update) so the dashboard's
      // groups list (memberCount) refreshes live, matching channel/pool/board.
      const emitGroupUpdate = (groupName: string) =>
        logEvent?.({
          type: "coordination_change",
          resource: "group",
          action: "update",
          entity: input.entity,
          name: groupName,
          timestamp: Date.now(),
        });

      switch (sub) {
        case "list": {
          const all = groups.list();
          if (all.length === 0) {
            ctx.send(input.entity, "No groups exist yet.");
            return;
          }
          const lines = [
            header("Groups"),
            separator(),
            ...all.map((g) => {
              const members = groups.getMembers(g.id);
              return `  ${bold(g.name)} (${members.length} members) — ${g.description || dim("No description")}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "info": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: group info <name>");
            return;
          }
          const group = groups.getByName(name);
          if (!group) {
            ctx.send(input.entity, `Group "${name}" not found.`);
            return;
          }
          const members = groups.getMembers(group.id);
          const lines = [
            header(group.name),
            group.description || dim("No description"),
            separator(),
            `Leader: ${fmtEntity(group.leaderId)}`,
            `Members (${members.length}):`,
            ...members.map((m) => `  ${fmtEntity(m.entityId)} ${rank(m.rank)}`),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "create": {
          const id = tokens[1];
          if (!id) {
            ctx.send(input.entity, "Usage: group create <id> <name>");
            return;
          }
          const groupName = tokens.slice(2).join(" ") || id;
          const existing = groups.get(id);
          if (existing) {
            ctx.send(input.entity, `Group with id "${id}" already exists.`);
            return;
          }
          groups.create({
            id,
            name: groupName,
            leaderId: input.entity,
          });
          logEvent?.({
            type: "coordination_change",
            resource: "group",
            action: "create",
            entity: input.entity,
            name: groupName,
            timestamp: Date.now(),
          });
          ctx.send(input.entity, `Created group "${groupName}" (${id}). You are the leader.`);
          return;
        }

        case "join": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: group join <name>");
            return;
          }
          const group = groups.getByName(name) ?? groups.get(name);
          if (!group) {
            ctx.send(input.entity, `Group "${name}" not found.`);
            return;
          }
          if (groups.isMember(group.id, input.entity)) {
            ctx.send(input.entity, `You are already in "${group.name}".`);
            return;
          }
          groups.addMember(group.id, input.entity);
          emitGroupUpdate(group.name);
          ctx.send(input.entity, `Joined group "${group.name}".`);
          return;
        }

        case "leave": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: group leave <name>");
            return;
          }
          const group = groups.getByName(name) ?? groups.get(name);
          if (!group) {
            ctx.send(input.entity, `Group "${name}" not found.`);
            return;
          }
          if (!groups.isMember(group.id, input.entity)) {
            ctx.send(input.entity, `You are not in "${group.name}".`);
            return;
          }
          if (group.leaderId === input.entity) {
            ctx.send(input.entity, "Leaders cannot leave. Use 'group disband' instead.");
            return;
          }
          groups.removeMember(group.id, input.entity);
          emitGroupUpdate(group.name);
          ctx.send(input.entity, `Left group "${group.name}".`);
          return;
        }

        case "invite": {
          const targetName = tokens[1];
          const groupName = tokens[2];
          if (!targetName || !groupName) {
            ctx.send(input.entity, "Usage: group invite <entity> <group>");
            return;
          }
          const group = groups.getByName(groupName) ?? groups.get(groupName);
          if (!group) {
            ctx.send(input.entity, `Group "${groupName}" not found.`);
            return;
          }
          if (!groups.canInvite(group.id, input.entity)) {
            ctx.send(input.entity, "You don't have permission to invite to this group.");
            return;
          }
          const target = findEntity(targetName);
          if (!target) {
            ctx.send(input.entity, `Entity "${targetName}" not found.`);
            return;
          }
          if (groups.isMember(group.id, target.id)) {
            ctx.send(input.entity, `${target.name} is already in "${group.name}".`);
            return;
          }
          groups.addMember(group.id, target.id);
          emitGroupUpdate(group.name);
          ctx.send(input.entity, `Invited ${target.name} to "${group.name}".`);
          ctx.send(target.id, `You have been invited to group "${group.name}".`);
          return;
        }

        case "kick": {
          const targetName = tokens[1];
          const groupName = tokens[2];
          if (!targetName || !groupName) {
            ctx.send(input.entity, "Usage: group kick <entity> <group>");
            return;
          }
          const group = groups.getByName(groupName) ?? groups.get(groupName);
          if (!group) {
            ctx.send(input.entity, `Group "${groupName}" not found.`);
            return;
          }
          if (!groups.canKick(group.id, input.entity)) {
            ctx.send(input.entity, "You don't have permission to kick from this group.");
            return;
          }
          const target = findEntity(targetName);
          if (!target) {
            ctx.send(input.entity, `Entity "${targetName}" not found.`);
            return;
          }
          if (target.id === group.leaderId) {
            ctx.send(input.entity, "Cannot kick the group leader.");
            return;
          }
          groups.removeMember(group.id, target.id);
          emitGroupUpdate(group.name);
          ctx.send(input.entity, `Kicked ${target.name} from "${group.name}".`);
          ctx.send(target.id, `You have been kicked from group "${group.name}".`);
          return;
        }

        case "promote": {
          const targetName = tokens[1];
          const groupName = tokens[2];
          if (!targetName || !groupName) {
            ctx.send(input.entity, "Usage: group promote <entity> <group>");
            return;
          }
          const group = groups.getByName(groupName) ?? groups.get(groupName);
          if (!group) {
            ctx.send(input.entity, `Group "${groupName}" not found.`);
            return;
          }
          if (group.leaderId !== input.entity) {
            ctx.send(input.entity, "Only the leader can promote members.");
            return;
          }
          const target = findEntity(targetName);
          if (!target) {
            ctx.send(input.entity, `Entity "${targetName}" not found.`);
            return;
          }
          if (groups.promote(group.id, target.id)) {
            emitGroupUpdate(group.name);
            ctx.send(input.entity, `Promoted ${target.name} in "${group.name}".`);
          } else {
            ctx.send(input.entity, `Cannot promote ${target.name} further.`);
          }
          return;
        }

        case "demote": {
          const targetName = tokens[1];
          const groupName = tokens[2];
          if (!targetName || !groupName) {
            ctx.send(input.entity, "Usage: group demote <entity> <group>");
            return;
          }
          const group = groups.getByName(groupName) ?? groups.get(groupName);
          if (!group) {
            ctx.send(input.entity, `Group "${groupName}" not found.`);
            return;
          }
          if (group.leaderId !== input.entity) {
            ctx.send(input.entity, "Only the leader can demote members.");
            return;
          }
          const target = findEntity(targetName);
          if (!target) {
            ctx.send(input.entity, `Entity "${targetName}" not found.`);
            return;
          }
          if (groups.demote(group.id, target.id)) {
            emitGroupUpdate(group.name);
            ctx.send(input.entity, `Demoted ${target.name} in "${group.name}".`);
          } else {
            ctx.send(input.entity, `Cannot demote ${target.name} further.`);
          }
          return;
        }

        case "disband": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: group disband <name>");
            return;
          }
          const group = groups.getByName(name) ?? groups.get(name);
          if (!group) {
            ctx.send(input.entity, `Group "${name}" not found.`);
            return;
          }
          if (group.leaderId !== input.entity) {
            ctx.send(input.entity, "Only the leader can disband the group.");
            return;
          }
          groups.delete(group.id);
          logEvent?.({
            type: "coordination_change",
            resource: "group",
            action: "delete",
            entity: input.entity,
            name: group.name,
            timestamp: Date.now(),
          });
          ctx.send(input.entity, `Disbanded group "${group.name}".`);
          return;
        }

        default:
          ctx.send(
            input.entity,
            "Usage: group list|info|create|join|leave|invite|kick|promote|demote|disband [args]",
          );
      }
    },
  };
}
