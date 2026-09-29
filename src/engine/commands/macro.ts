// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MacroManager } from "../../coordination/macro-manager";
import { bold, dim, header, separator } from "../../net/ansi";
import type { CommandDef, RoomContext } from "../../types";
import type { CommandRouter } from "../command-router";

export function macroCommand(
  macros: MacroManager,
  router: Pick<CommandRouter, "getDef">,
  /** True when some loaded room provides a command of this name. */
  isRoomCommand: (name: string) => boolean = () => false,
): CommandDef {
  return {
    category: "Coordination",
    usage: ["macro create <name> <command>", "macro delete <name>", "macro list"],
    name: "macro",
    aliases: [],
    help: "Manage macros. Usage: macro list | macro create <name> <command> | macro delete <name>",
    handler: (ctx: RoomContext, input) => {
      const self = ctx.getEntity(input.entity);
      if (!self) return;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase() ?? "list";

      switch (sub) {
        case "list": {
          const list = macros.list(input.entity);
          if (list.length === 0) {
            ctx.send(input.entity, "You have no macros.");
            return;
          }
          const lines = [
            header("Your Macros"),
            separator(),
            ...list.map((m) => `  ${bold(m.name)} \u2014 ${dim(m.command)}`),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "create": {
          const name = tokens[1];
          if (!name || tokens.length < 3) {
            ctx.send(input.entity, "Usage: macro create <name> <command>");
            return;
          }
          // Collision check — built-ins, aliases and room commands take priority
          // (the router resolves them first, so such a macro could never run).
          const verb = name.toLowerCase();
          const existingCmd = router.getDef(verb);
          if (existingCmd) {
            ctx.send(
              input.entity,
              `Cannot create macro "${name}" — conflicts with built-in command "${existingCmd.name}".`,
            );
            return;
          }
          if (isRoomCommand(verb)) {
            ctx.send(
              input.entity,
              `Cannot create macro "${name}" — conflicts with a room command of the same name.`,
            );
            return;
          }
          const existing = macros.getByName(name, input.entity);
          if (existing) {
            ctx.send(input.entity, `Macro "${name}" already exists.`);
            return;
          }
          const command = tokens.slice(2).join(" ");
          if (!command.split(";").some((part) => part.trim())) {
            ctx.send(
              input.entity,
              "Cannot create an empty macro. Usage: macro create <name> <command>",
            );
            return;
          }
          macros.create(name, input.entity, command);
          ctx.send(input.entity, `Created macro "${name}".`);
          return;
        }

        case "delete": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: macro delete <name>");
            return;
          }
          const macro = macros.getByName(name, input.entity);
          if (!macro) {
            ctx.send(input.entity, `Macro "${name}" not found.`);
            return;
          }
          macros.delete(macro.id, input.entity);
          ctx.send(input.entity, `Deleted macro "${name}".`);
          return;
        }

        default: {
          ctx.send(
            input.entity,
            "Usage: macro list | macro create <name> <command> | macro delete <name>",
          );
          return;
        }
      }
    },
  };
}
