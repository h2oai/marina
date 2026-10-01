// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MacroManager } from "../../coordination/macro-manager";
import { bold, dim, header, separator } from "../../net/ansi";
import type { CommandDef, RoomContext } from "../../types";
import type { CommandRouter } from "../command-router";
import { roomMacroOwner } from "../macro-expansion";
import { rankFloorRefusal } from "../rank-floor";

const USAGE =
  "Usage: macro list | macro create <name> <command with $* / $1…> [room:<id|here>] | macro delete <name> [room:<id|here>]";

/** Rank floor for authoring a macro other entities in a room will resolve. */
export const ROOM_MACRO_MIN_RANK = 4;

const ROOM_MODIFIER_LEADING = /^room:([^\s;]+)(?:\s+|$)/;
const ROOM_MODIFIER_TRAILING = /(?:^|\s+)room:([^\s;]+)$/;

/**
 * Split `<name> <rest>` off the raw args after the subcommand, keeping the
 * rest byte-exact (the tokenizer would collapse whitespace inside JSON), and
 * pull an optional `room:<id|here>` modifier off either end of the rest.
 */
function parseMacroArgs(args: string): { name?: string; body: string; room?: string } {
  const match = /^\S+(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(args.trim());
  const name = match?.[1];
  let body = (match?.[2] ?? "").trim();
  let room: string | undefined;
  const leading = ROOM_MODIFIER_LEADING.exec(body);
  if (leading) {
    room = leading[1];
    body = body.slice(leading[0].length).trim();
  } else {
    const trailing = ROOM_MODIFIER_TRAILING.exec(body);
    if (trailing) {
      room = trailing[1];
      body = body.slice(0, trailing.index).trim();
    }
  }
  return { ...(name ? { name } : {}), body, ...(room ? { room } : {}) };
}

export function macroCommand(
  macros: MacroManager,
  router: Pick<CommandRouter, "getDef">,
  /** True when some loaded room provides a command of this name. */
  isRoomCommand: (name: string) => boolean = () => false,
  /** True when a room with this id is loaded (for `room:<id>`). */
  roomExists: (roomId: string) => boolean = () => false,
): CommandDef {
  return {
    category: "Coordination",
    usage: [
      "macro create <name> <command with $* / $1…> [room:<room>]",
      "macro delete <name> [room:<room>]",
      "macro list",
    ],
    name: "macro",
    aliases: [],
    help:
      "Manage macros: named verbs that expand to one or more `;`-separated commands. " +
      "Arguments after the macro name bind to $* / $@ (all, verbatim), $1..$9 (words) and $$ (a literal $); " +
      "with no placeholder, trailing arguments are appended to the last command. " +
      `room:<id|here> scopes a macro to everyone in that room (rank ${ROOM_MACRO_MIN_RANK}). ${USAGE}`,
    handler: (ctx: RoomContext, input) => {
      const self = ctx.getEntity(input.entity);
      if (!self) return;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase() ?? "list";
      const parsed = parseMacroArgs(input.args);
      /** The owner key for a `room:` target, or a refusal sentence. */
      const roomOwner = (room: string): { owner: string } | { refusal: string } => {
        const roomId = room.toLowerCase() === "here" ? (self.room as string) : room;
        if (roomId !== self.room && !roomExists(roomId)) {
          return { refusal: `Unknown room "${room}".` };
        }
        const floor = rankFloorRefusal(
          self,
          ROOM_MACRO_MIN_RANK,
          `Room macros need rank ${ROOM_MACRO_MIN_RANK} or higher.`,
        );
        return floor ? { refusal: floor } : { owner: roomMacroOwner(roomId) };
      };

      switch (sub) {
        case "list": {
          const own = macros.list(input.entity);
          const here = macros.list(roomMacroOwner(self.room));
          if (own.length === 0 && here.length === 0) {
            ctx.send(input.entity, "You have no macros.");
            return;
          }
          const lines = [header("Your Macros"), separator()];
          lines.push(...own.map((m) => `  ${bold(m.name)} — ${dim(m.command)}`));
          if (here.length > 0) {
            lines.push(header("Room Macros"), separator());
            lines.push(...here.map((m) => `  ${bold(m.name)} — ${dim(m.command)}`));
          }
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "create": {
          const name = parsed.name;
          if (!name || !parsed.body) {
            ctx.send(input.entity, `Usage: macro create <name> <command with $* / $1…>`);
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
          let owner: string = input.entity;
          if (parsed.room) {
            const target = roomOwner(parsed.room);
            if ("refusal" in target) {
              ctx.send(input.entity, target.refusal);
              return;
            }
            owner = target.owner;
          }
          const existing = macros.getByName(name, owner);
          if (existing) {
            ctx.send(input.entity, `Macro "${name}" already exists.`);
            return;
          }
          const command = parsed.body;
          if (!command.split(";").some((part) => part.trim())) {
            ctx.send(
              input.entity,
              "Cannot create an empty macro. Usage: macro create <name> <command>",
            );
            return;
          }
          macros.create(name, owner, command);
          ctx.send(
            input.entity,
            parsed.room ? `Created room macro "${name}".` : `Created macro "${name}".`,
          );
          return;
        }

        case "delete": {
          const name = parsed.name;
          if (!name) {
            ctx.send(input.entity, "Usage: macro delete <name> [room:<id|here>]");
            return;
          }
          let owner: string = input.entity;
          if (parsed.room) {
            const target = roomOwner(parsed.room);
            if ("refusal" in target) {
              ctx.send(input.entity, target.refusal);
              return;
            }
            owner = target.owner;
          }
          const macro = macros.getByName(name, owner);
          if (!macro) {
            ctx.send(input.entity, `Macro "${name}" not found.`);
            return;
          }
          macros.delete(macro.id, owner);
          ctx.send(input.entity, `Deleted macro "${name}".`);
          return;
        }

        default: {
          ctx.send(input.entity, USAGE);
          return;
        }
      }
    },
  };
}
