import { bold, category, dim, rank as fmtRank, header, separator } from "../../net/ansi";
import type { CommandDef, EntityId, RoomContext } from "../../types";

const COMMAND_CATEGORIES: Record<string, string[]> = {
  Navigation: ["look", "move", "map"],
  Communication: ["say", "shout", "tell", "emote"],
  Objects: ["get", "drop", "give", "inventory", "examine"],
  Information: ["who", "score", "help", "time", "uptime", "next", "brief"],
  "Identity & Access": ["ignore", "rank", "quest", "link"],
  Knowledge: ["note", "search", "bookmark", "export"],
  Cognition: ["memory", "recall", "reflect", "novelty", "orient"],
  Growth: ["evolve", "skill", "benchmark"],
  Coordination: ["channel", "board", "group", "task", "macro", "project", "pool"],
  "Canvas & Media": ["canvas", "usecase"],
  Experiments: ["experiment", "observe"],
  Building: ["build", "connect"],
  Admin: ["admin"],
};

function categorize(cmd: CommandDef): string {
  for (const [cat, names] of Object.entries(COMMAND_CATEGORIES)) {
    if (names.includes(cmd.name)) return cat;
  }
  return "Other";
}

export function helpCommand(
  getAllCommands: () => CommandDef[],
  getEntityRank: (id: string) => number,
): CommandDef {
  return {
    name: "help",
    aliases: ["?", "commands"],
    help: "Show available commands. Usage: help [command | all]",
    handler: (ctx: RoomContext, input) => {
      const all = getAllCommands();

      if (input.args) {
        const target = input.args.toLowerCase();

        // "help all" — show every command unfiltered
        if (target === "all" || input.tokens[0]?.toLowerCase() === "all") {
          renderCommandList(ctx, input, all, false);
          return;
        }

        // "help <command>" — show detail for any command regardless of rank
        const cmd = all.find((c) => c.name === target || c.aliases?.includes(target));
        if (cmd) {
          const aliases = cmd.aliases?.length
            ? ` ${dim(`(aliases: ${cmd.aliases.join(", ")})`)}`
            : "";
          const cat = categorize(cmd);
          ctx.send(
            input.entity,
            `${header(cmd.name)}${aliases}\n${dim(`Category: ${cat}`)}\n${cmd.help}`,
          );
        } else {
          ctx.send(input.entity, `Unknown command: ${input.args}`);
        }
        return;
      }

      // No args — show rank-filtered list
      const entityRank = getEntityRank(input.entity);
      const filtered = all.filter((cmd) => (cmd.minRank ?? 0) <= entityRank);
      renderCommandList(ctx, input, filtered, true);
    },
  };
}

function renderCommandList(
  ctx: RoomContext,
  input: { entity: EntityId },
  cmds: CommandDef[],
  showAllHint: boolean,
): void {
  const grouped = new Map<string, CommandDef[]>();
  for (const cmd of cmds) {
    const cat = categorize(cmd);
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(cmd);
  }

  const lines: string[] = [header("Available Commands"), separator()];

  const order = [...Object.keys(COMMAND_CATEGORIES), "Other"];
  for (const cat of order) {
    const catCmds = grouped.get(cat);
    if (!catCmds || catCmds.length === 0) continue;
    lines.push(`\n${category(cat)}`);
    for (const c of catCmds) {
      const aliases = c.aliases?.length ? ` ${dim(`(${c.aliases.join(", ")})`)}` : "";
      const rankTag = c.minRank && c.minRank > 0 ? ` ${fmtRank(c.minRank)}` : "";
      lines.push(`  ${bold(c.name)}${aliases}${rankTag} \u2014 ${c.help.split(".")[0]}`);
    }
  }

  lines.push("", dim('Type "help <command>" for details.'));
  if (showAllHint) {
    lines.push(dim('Type "help all" for all commands including advanced.'));
  }
  ctx.send(input.entity, lines.join("\n"));
}
