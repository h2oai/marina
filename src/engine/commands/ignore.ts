// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { dim, entity as fmtEntity, success } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";

export function ignoreCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  findEntityGlobal: (name: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "ignore",
    aliases: ["block"],
    help: "Ignore an entity. Usage: ignore <name> | ignore list | ignore remove <name>",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const sub = input.tokens[0]?.toLowerCase();

      if (!sub) {
        ctx.send(input.entity, "Usage: ignore <name> | ignore list | ignore remove <name>");
        return;
      }

      const ignoreList = getIgnoreList(entity);

      if (sub === "list") {
        if (ignoreList.length === 0) {
          ctx.send(input.entity, dim("You are not ignoring anyone."));
        } else {
          const names = ignoreList.map((n) => fmtEntity(n)).join(", ");
          ctx.send(input.entity, `Ignoring: ${names}`);
        }
        return;
      }

      if (sub === "remove" || sub === "unignore") {
        const name = input.tokens[1];
        if (!name) {
          ctx.send(input.entity, "Usage: ignore remove <name>");
          return;
        }
        const lower = name.toLowerCase();
        const idx = ignoreList.findIndex((n) => n.toLowerCase() === lower);
        if (idx === -1) {
          ctx.send(input.entity, `You are not ignoring "${name}".`);
          return;
        }
        ignoreList.splice(idx, 1);
        entity.properties.ignore_list = ignoreList;
        ctx.send(input.entity, `No longer ignoring ${fmtEntity(name)}.`);
        return;
      }

      // Treat the subcommand as a name to ignore
      const targetName = input.tokens[0]!;
      const target = deps.findEntityGlobal(targetName) ?? ctx.findEntity(targetName);

      if (!target) {
        ctx.send(input.entity, `No one named "${targetName}" found.`);
        return;
      }

      if (target.id === input.entity) {
        ctx.send(input.entity, "You cannot ignore yourself.");
        return;
      }

      const lower = target.name.toLowerCase();
      if (ignoreList.some((n) => n.toLowerCase() === lower)) {
        ctx.send(input.entity, `You are already ignoring ${target.name}.`);
        return;
      }

      ignoreList.push(target.name);
      entity.properties.ignore_list = ignoreList;
      ctx.send(input.entity, success(`Now ignoring ${fmtEntity(target.name)}.`));
    },
  };
}

/** Get the ignore list from entity properties */
export function getIgnoreList(entity: Entity): string[] {
  const list = entity.properties.ignore_list;
  if (Array.isArray(list)) return list as string[];
  return [];
}

/** Check if an entity is ignoring a given name */
export function isIgnoring(entity: Entity, name: string): boolean {
  const list = getIgnoreList(entity);
  const lower = name.toLowerCase();
  return list.some((n) => n.toLowerCase() === lower);
}
