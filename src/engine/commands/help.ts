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
  // One Memory category — the same six verbs the system prompt's MEMORY
  // contract and the COMMAND_ROSTER teach (note/recall/reflect/memory/pool/
  // skill) plus the health and session-close views. Keep the three surfaces
  // in step (test/memory-contract.test.ts).
  Memory: ["note", "recall", "reflect", "memory", "pool", "skill", "orient", "debrief", "recap"],
  Knowledge: ["feed", "chronicle", "search", "bookmark", "export"],
  Cognition: ["novelty", "ask", "dig"],
  Growth: ["evolve", "benchmark"],
  Lineage: [
    "genome",
    "intellect",
    "mutation",
    "reproduce",
    "marina-descend",
    "association",
    "mesh",
    "economy",
  ],
  "Markets & Forecasting": ["market", "scenario", "bankroll", "position", "probe", "watch"],
  Experiments: ["experiment", "observe", "lab"],
  Coordination: [
    "channel",
    "board",
    "group",
    "task",
    "macro",
    "project",
    "crew",
    "recruit",
    "conduct",
    "share",
    "usecase",
  ],
  Civic: ["witness", "standing"],
  "Canvas & Media": ["canvas", "image", "video"],
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

/** `help <cmd>` shows at most this many lines when the text has no `Usage:` marker. */
export const HELP_PREVIEW_LINES = 25;

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

/**
 * Resolve a user token to a category name: exact case-insensitive match first,
 * then a UNIQUE case-insensitive prefix ("nav" → Navigation; "c" is ambiguous
 * and resolves to nothing). `categories` defaults to the known map plus any
 * categories the given commands declared via their own `category` field.
 */
export function resolveCategory(token: string, categories: string[]): string | undefined {
  const t = token.trim().toLowerCase();
  if (!t) return undefined;
  const exact = categories.find((c) => c.toLowerCase() === t);
  if (exact) return exact;
  const prefixed = categories.filter((c) => c.toLowerCase().startsWith(t));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * The part of a command's help text that `help <cmd>` shows by default: the
 * first `Usage:` block (from the marker line through the next blank line),
 * preceded by the leading summary line when the block does not open the text.
 * Without a marker, the first HELP_PREVIEW_LINES lines. `truncated` tells the
 * caller whether a `help <cmd> full` hint is warranted.
 */
export function usageExcerpt(help: string): { text: string; truncated: boolean } {
  const lines = help.split("\n");
  const usageAt = lines.findIndex((l) => /\bUsage:/.test(l));
  if (usageAt === -1) {
    if (lines.length <= HELP_PREVIEW_LINES) return { text: help, truncated: false };
    return { text: lines.slice(0, HELP_PREVIEW_LINES).join("\n"), truncated: true };
  }
  let end = usageAt + 1;
  while (end < lines.length && lines[end]!.trim() !== "") end++;
  const block = lines.slice(usageAt, end);
  // Keep the one-line summary that conventionally precedes the Usage block.
  const summary = usageAt > 0 ? lines[0]!.trim() : "";
  const out = summary && summary !== block[0]?.trim() ? [summary, ...block] : block;
  const text = out.join("\n");
  return { text, truncated: text.trim() !== help.trim() };
}

export function helpCommand(
  getAllCommands: () => CommandDef[],
  getEntityRank: (id: string) => number,
): CommandDef {
  return {
    name: "help",
    aliases: ["?", "commands"],
    help: "Show available commands. Usage: help [<command> [full] | <category> | all]",
    handler: (ctx: RoomContext, input) => {
      const all = getAllCommands();
      const entityRank = getEntityRank(input.entity);
      const visible = all.filter((cmd) => (cmd.minRank ?? 0) <= entityRank);

      if (!input.args) {
        renderStarter(ctx, input, visible);
        return;
      }

      const first = input.tokens[0]?.toLowerCase() ?? "";
      const second = input.tokens[1]?.toLowerCase();

      // "help all" — show every command unfiltered
      if (first === "all") {
        renderCommandList(ctx, input, all);
        return;
      }

      const categories = allCategories(all);
      const cmd = all.find((c) => c.name === first || c.aliases?.includes(first));
      const cat = resolveCategory(first, categories);

      // "help <command> [full]" — a command wins over a same-named category.
      if (cmd) {
        renderCommandDetail(ctx, input, cmd, second === "full", cat);
        return;
      }

      // "help <category>" — one category's commands (all ranks, rank-tagged).
      if (cat) {
        renderCategory(ctx, input, cat, all);
        return;
      }

      ctx.send(
        input.entity,
        `Unknown command or category: ${input.args}\n${dim('Type "help" for categories, "help all" for every command.')}`,
      );
    },
  };
}

/** Known categories (map order) plus any a command declared itself, sorted. */
function allCategories(cmds: CommandDef[]): string[] {
  const known = Object.keys(COMMAND_CATEGORIES);
  const extra = [...new Set(cmds.map(categorizeCommand))]
    .filter((c) => c !== "Other" && !known.includes(c))
    .sort();
  return [...known, ...extra];
}

function groupByCategory(cmds: CommandDef[]): Map<string, CommandDef[]> {
  const grouped = new Map<string, CommandDef[]>();
  for (const cmd of cmds) {
    const cat = categorizeCommand(cmd);
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(cmd);
  }
  return grouped;
}

/** Display order: known categories first, self-declared extras, "Other" last. */
function categoryOrder(grouped: Map<string, CommandDef[]>): string[] {
  const known = Object.keys(COMMAND_CATEGORIES);
  const extra = [...grouped.keys()].filter((c) => c !== "Other" && !known.includes(c)).sort();
  return [...known, ...extra, "Other"];
}

function commandLine(c: CommandDef): string {
  const aliases = c.aliases?.length ? ` ${dim(`(${c.aliases.join(", ")})`)}` : "";
  const rankTag = c.minRank && c.minRank > 0 ? ` ${fmtRank(c.minRank)}` : "";
  // Truncate at a sentence boundary (". " or ".\n" or trailing "."), not at
  // any bare "." — "v1.2"-style strings must not fragment.
  return `  ${bold(c.name)}${aliases}${rankTag} — ${c.help.split(/\.(?:\s|$)/)[0]}`;
}

/** No-arg `help`: a short starter block, then one line per category with counts. */
function renderStarter(ctx: RoomContext, input: { entity: EntityId }, visible: CommandDef[]): void {
  const grouped = groupByCategory(visible);
  const lines: string[] = [
    header("Marina Commands"),
    separator(),
    `${bold("look")}, ${bold("say <text>")}, ${bold("move <direction>")}, ${bold("who")} — look around and talk`,
    `${bold("help <category>")} — the commands in one category below`,
    `${bold("help <command>")} — usage for one command (${dim("help <command> full")} for everything)`,
    `${bold("help all")} — every command you can run (${visible.length}), grouped`,
    `${bold("readiness")} — what is configured and what is missing`,
    `${bold("guide")} — what predecessors learned; ${bold("next")} — one concrete next action`,
    "",
    category("Categories"),
  ];
  for (const cat of categoryOrder(grouped)) {
    const catCmds = grouped.get(cat);
    if (!catCmds || catCmds.length === 0) continue;
    const names = catCmds.map((c) => c.name).join(", ");
    lines.push(`  ${bold(cat)} ${dim(`(${catCmds.length})`)} — ${names}`);
  }
  ctx.send(input.entity, lines.join("\n"));
}

/** `help <category>`: the commands in one category, rank-tagged. */
function renderCategory(
  ctx: RoomContext,
  input: { entity: EntityId },
  cat: string,
  all: CommandDef[],
): void {
  const cmds = all.filter((c) => categorizeCommand(c) === cat);
  const lines: string[] = [header(cat), separator()];
  for (const c of cmds) lines.push(commandLine(c));
  lines.push("", dim('Type "help <command>" for usage, "help" for all categories.'));
  ctx.send(input.entity, lines.join("\n"));
}

/** `help <command> [full]`: usage excerpt by default, the whole text on `full`. */
function renderCommandDetail(
  ctx: RoomContext,
  input: { entity: EntityId },
  cmd: CommandDef,
  full: boolean,
  sameNamedCategory: string | undefined,
): void {
  const aliases = cmd.aliases?.length ? ` ${dim(`(aliases: ${cmd.aliases.join(", ")})`)}` : "";
  const lines: string[] = [
    `${header(cmd.name)}${aliases}`,
    dim(`Category: ${categorizeCommand(cmd)}`),
  ];
  if (full) {
    lines.push(cmd.help);
  } else {
    const { text, truncated } = usageExcerpt(cmd.help);
    lines.push(text);
    if (truncated) lines.push(dim(`Type "help ${cmd.name} full" for the complete text.`));
  }
  // The token also named a category (e.g. `memory`): the command wins, but say so.
  if (sameNamedCategory) {
    lines.push(
      dim(
        `"${sameNamedCategory}" is also a category — "help ${sameNamedCategory.toLowerCase()}" lists its commands.`,
      ),
    );
  }
  ctx.send(input.entity, lines.join("\n"));
}

/** `help all`: the full grouped dump. */
function renderCommandList(
  ctx: RoomContext,
  input: { entity: EntityId },
  cmds: CommandDef[],
): void {
  const grouped = groupByCategory(cmds);
  const lines: string[] = [header("Available Commands"), separator()];
  for (const cat of categoryOrder(grouped)) {
    const catCmds = grouped.get(cat);
    if (!catCmds || catCmds.length === 0) continue;
    lines.push(`\n${category(cat)}`);
    for (const c of catCmds) lines.push(commandLine(c));
  }

  lines.push("", dim('Type "help <command>" for details, "help <category>" for one group.'));
  lines.push(dim('Use "next" for one concrete action, "brief social" for live peers.'));
  lines.push(
    dim('Use "pool guide recall behavior surfaces" when deciding role vs trait vs skill.'),
  );
  ctx.send(input.entity, lines.join("\n"));
}
