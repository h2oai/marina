// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { entity as fmtEntity } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext, RoomId } from "../../types";
import { splitOn } from "../parse-input";

export function getCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  findObjectInRoom: (name: string, room: RoomId) => Entity | undefined;
}): CommandDef {
  return {
    name: "get",
    aliases: ["take", "pick"],
    help: "Pick up an item. Usage: get <item>",
    handler: (ctx: RoomContext, input) => {
      if (!input.args) {
        ctx.send(input.entity, "Get what?");
        return;
      }

      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const target = input.args.trim().toLowerCase();
      const obj = deps.findObjectInRoom(target, entity.room);

      if (!obj) {
        ctx.send(input.entity, "You don't see that here.");
        return;
      }

      if (obj.kind !== "object") {
        ctx.send(input.entity, "You can't pick that up.");
        return;
      }

      // Move object from room to inventory
      entity.inventory.push(obj.id);
      obj.room = "inventory" as RoomId;
      obj.properties._owner = entity.id;

      ctx.send(input.entity, `You pick up ${fmtEntity(obj.name)}.`);
      ctx.broadcastExcept(
        input.entity,
        `${entity.name} picks up ${fmtEntity(obj.name)}.`,
        "action",
      );
    },
  };
}

export function dropCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  getEntityById: (id: EntityId) => Entity | undefined;
}): CommandDef {
  return {
    name: "drop",
    aliases: [],
    help: "Drop an item from your inventory. Usage: drop <item>",
    handler: (ctx: RoomContext, input) => {
      if (!input.args) {
        ctx.send(input.entity, "Drop what?");
        return;
      }

      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const target = input.args.trim().toLowerCase();

      // Find item in inventory
      let found: Entity | undefined;
      let foundIdx = -1;
      for (let i = 0; i < entity.inventory.length; i++) {
        const item = deps.getEntityById(entity.inventory[i]!);
        if (item?.name.toLowerCase().startsWith(target)) {
          found = item;
          foundIdx = i;
          break;
        }
      }

      if (!found || foundIdx < 0) {
        ctx.send(input.entity, "You don't have that.");
        return;
      }

      // Move object from inventory to room
      entity.inventory.splice(foundIdx, 1);
      found.room = entity.room;
      found.properties._owner = undefined;

      ctx.send(input.entity, `You drop ${fmtEntity(found.name)}.`);
      ctx.broadcastExcept(input.entity, `${entity.name} drops ${fmtEntity(found.name)}.`, "action");
    },
  };
}

export function giveCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  getEntityById: (id: EntityId) => Entity | undefined;
  findEntityInRoom: (name: string, room: RoomId) => Entity | undefined;
}): CommandDef {
  return {
    name: "give",
    aliases: [],
    help: "Give an item to someone. Usage: give <item> to <entity>",
    handler: (ctx: RoomContext, input) => {
      if (!input.args) {
        ctx.send(input.entity, "Give what to whom?");
        return;
      }

      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      // Parse: give <item> to <entity>
      const parts = splitOn(input.args, " to ");
      if (!parts) {
        ctx.send(input.entity, "Usage: give <item> to <entity>");
        return;
      }

      const itemName = parts[0].toLowerCase();
      const targetName = parts[1];

      // Find item in inventory
      let found: Entity | undefined;
      let foundIdx = -1;
      for (let i = 0; i < entity.inventory.length; i++) {
        const item = deps.getEntityById(entity.inventory[i]!);
        if (item?.name.toLowerCase().startsWith(itemName)) {
          found = item;
          foundIdx = i;
          break;
        }
      }

      if (!found || foundIdx < 0) {
        ctx.send(input.entity, "You don't have that.");
        return;
      }

      // Find target entity in room
      const target = deps.findEntityInRoom(targetName, entity.room);
      if (!target || target.id === input.entity) {
        ctx.send(input.entity, "You don't see them here.");
        return;
      }

      // Transfer item
      entity.inventory.splice(foundIdx, 1);
      target.inventory.push(found.id);
      found.properties._owner = target.id;

      ctx.send(input.entity, `You give ${fmtEntity(found.name)} to ${target.name}.`);
      ctx.send(target.id, `${entity.name} gives you ${fmtEntity(found.name)}.`, "action");
      ctx.broadcastExcept(
        input.entity,
        `${entity.name} gives ${fmtEntity(found.name)} to ${target.name}.`,
        "action",
      );
    },
  };
}
