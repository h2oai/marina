import type { CommandDef, RoomContext } from "../../types";
import { formatDurationFull } from "./format-duration";

export function timeCommand(): CommandDef {
  return {
    name: "time",
    aliases: ["date"],
    help: "Show the current server time.",
    handler: (ctx: RoomContext, input) => {
      const now = new Date();
      const formatted = now.toUTCString();
      ctx.send(input.entity, `\x1b[1;36mServer Time\x1b[0m\n  ${formatted}`);
    },
  };
}

export function uptimeCommand(getUptime: () => number): CommandDef {
  return {
    name: "uptime",
    aliases: [],
    help: "Show how long the server has been running.",
    handler: (ctx: RoomContext, input) => {
      const ms = getUptime();
      const formatted = formatDurationFull(ms);
      ctx.send(input.entity, `\x1b[1;36mServer Uptime\x1b[0m\n  ${formatted}`);
    },
  };
}
