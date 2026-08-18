// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, category, dim, rank as fmtRank, header, separator } from "../../net/ansi";
import type { CommandDef, EntityId, RoomContext } from "../../types";

// Name→category map for `help` grouping. A command's own `category` field
// (CommandDef.category) wins over this map; this is the fallback for the
// built-ins that don't set one. EVERY registered command must resolve to a
// real category here or via its field — the help-coverage test
// (test/help-coverage.test.ts) fails on any command that lands in "Other",
// so adding a new primitive forces a categorization decision.
//
// Object insertion order is the display order in the rendered list.
export const COMMAND_CATEGORIES: Record<string, string[]> = {
  Navigation: ["look", "move", "ls", "goto", "map"],
  Communication: ["say", "shout", "tell", "re", "emote"],
  Objects: ["get", "drop", "give", "inventory"],
  Information: ["who", "score", "help", "brief", "next", "web", "guide"],
  "Identity & Access": ["ignore", "rank", "quest", "link", "role", "trait", "system-prompt"],
  Knowledge: ["note", "feed", "chronicle", "search", "bookmark", "export"],
  Cognition: ["memory", "recall", "reflect", "novelty", "orient", "ask", "recap", "debrief", "dig"],
  Growth: ["evolve", "skill", "benchmark"],
  "Markets & Forecasting": ["market", "scenario", "bankroll", "position", "probe", "watch"],
  Experiments: ["experiment", "observe"],
  Coordination: [
    "channel",
    "board",
    "group",
    "task",
    "macro",
    "project",
    "pool",
    "crew",
    "recruit",
    "standing",
    "conduct",
    "share",
  ],
  "Canvas & Media": ["canvas", "usecase", "image", "video"],
  Agents: ["agent", "run"],
  Building: ["build", "connect"],
  Federation: ["gateway"],
  "Admin & Security": ["admin", "key", "adapter"],
  System: [
    "readiness",
    "demo",
    "ops",
    "calc",
    "time",
    "uptime",
    "source",
    "quit",
    "batch",
    "shell",
  ],
};

/**
 * Resolve a command's display category. Prefers the command's own `category`
 * field, then the name→category map, then "Other" (which the coverage test
 * forbids for any registered command).
 */
export function categorizeCommand(cmd: CommandDef): string {
  if (cmd.category) return cmd.category;
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
          const cat = categorizeCommand(cmd);
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
    const cat = categorizeCommand(cmd);
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(cmd);
  }

  const lines: string[] = [header("Available Commands"), separator()];

  // Known categories first (in map order), then any extra categories a command
  // declared via its `category` field, then the "Other" catch-all last. Driving
  // the tail off `grouped` keeps self-categorized commands from being dropped.
  const known = Object.keys(COMMAND_CATEGORIES);
  const extra = [...grouped.keys()].filter((c) => c !== "Other" && !known.includes(c)).sort();
  const order = [...known, ...extra, "Other"];
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
  lines.push(dim('Use "next" for one concrete action, "brief social" for live peers.'));
  lines.push(
    dim('Use "pool guide recall behavior surfaces" when deciding role vs trait vs skill.'),
  );
  if (showAllHint) {
    lines.push(dim('Type "help all" for all commands including advanced.'));
  }
  ctx.send(input.entity, lines.join("\n"));
}
