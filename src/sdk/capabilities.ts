// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { CommandForm } from "./command-forms";

export interface CommandCatalogEntry {
  forms?: CommandForm[];
  /** Stable named MCP payloads, separate from executable command-line forms. */
  namedTools?: CommandForm[];
  description?: string;
  owner?: string;
  revision?: number;
  scope?: "world" | "room";
  structured?: boolean;
  availability?: { status: "available" | "conditional" | "unavailable"; reasons: string[] };
  name: string;
  aliases: string[];
  category: string;
  help: string;
  minRank: number;
  gate?: string;
}

export interface CapabilityManifest {
  schema: "marina.capabilities.v1";
  revision: number;
  key?: string;
  commands: CommandCatalogEntry[];
  request_id?: string;
}

/** Core work commands, most relevant first: find work, act, communicate, remember. */
export const ROSTER_PRIORITY: readonly string[] = [
  "work",
  "next",
  "task",
  "project",
  "look",
  "brief",
  "tell",
  "channel",
  "board",
  "say",
  "note",
  "recall",
  "memory",
  "pool",
  "skill",
  "reflect",
  "orient",
  "web",
  "canvas",
  "code",
  "crew",
  "challenge",
  "help",
];

/** Categories in relevance order for any room left after ROSTER_PRIORITY. */
const CATEGORY_RELEVANCE = [
  "Coordination",
  "Memory",
  "Knowledge",
  "Information",
  "Cognition",
  "Communication",
  "Civic",
  "Agents",
  "Canvas & Media",
  "Navigation",
  "Growth",
  "Objects",
  "Building",
  "Identity & Access",
  "System",
  "Experiments",
  "Markets & Forecasting",
  "Lineage",
  "Federation",
];

/** Operator surfaces never listed in a roster (still reachable through `help`). */
const OPERATOR_CATEGORIES = new Set(["Admin & Security"]);
const OPERATOR_COMMANDS = new Set(["quit"]);

export interface RosterOptions {
  /** List commands above the caller's rank (a local ungated instance has no rank floors). */
  includeRankLimited?: boolean;
  /** Clamp each summary to this many characters, at a word boundary. */
  maxLineChars?: number;
  /** List only the core work commands (and this room's) — nothing past them. */
  coreOnly?: boolean;
  /** Command names to leave out because the surrounding prompt already teaches them. */
  omit?: ReadonlySet<string>;
  /**
   * Lead with the `This room:` line (default true). A cached system prompt
   * passes false: room commands change with the room, so they belong in the
   * per-turn context (`renderRoomCommands`), not in a static prefix.
   */
  includeRoom?: boolean;
}

/** Bytes the `This room:` line may take. */
const ROOM_LINE_MAX_BYTES = 240;

/**
 * The caller's room commands as one `This room: a, b` line (names only — a
 * room handler carries no summary), byte-bounded; "" when the room has none.
 */
export function renderRoomCommands(
  entries: readonly CommandCatalogEntry[],
  options: RosterOptions = {},
  maxBytes = ROOM_LINE_MAX_BYTES,
): string {
  const encoder = new TextEncoder();
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.scope !== "room" || !rosterEligible(entry, options)) continue;
    if (encoder.encode(`This room: ${[...names, entry.name].join(", ")}`).length > maxBytes) break;
    names.push(entry.name);
  }
  return names.length ? `This room: ${names.join(", ")}` : "";
}

/** First line of a summary, clamped at a word boundary. */
export function clampSummary(text: string, max: number): string {
  const flat = (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, "")}…`;
}

/** Whether a roster may list this command for the caller. */
function rosterEligible(entry: CommandCatalogEntry, options: RosterOptions): boolean {
  if (entry.availability?.status === "unavailable") return false;
  if (OPERATOR_CATEGORIES.has(entry.category) || OPERATOR_COMMANDS.has(entry.name)) return false;
  // Gated commands are operator or earned surfaces; `help <command>` still documents them.
  if (entry.gate) return false;
  if (
    !options.includeRankLimited &&
    entry.availability?.reasons.some((reason) => reason.startsWith("Rank "))
  )
    return false;
  return true;
}

/**
 * Byte-bounded, live roster: relevance-ranked (core work commands, then this
 * room's commands, then categories by relevance), filtered to what the caller
 * can run, never listing operator-only surfaces. Selection is command ids,
 * never separately maintained prose.
 */
export function renderCapabilityRoster(
  entries: CommandCatalogEntry[],
  maxBytes = 1900,
  options: RosterOptions = {},
): string {
  const maxLine = options.maxLineChars ?? 72;
  const rank = (entry: CommandCatalogEntry) => {
    const preferred = ROSTER_PRIORITY.indexOf(entry.name);
    if (preferred >= 0) return preferred;
    const category = CATEGORY_RELEVANCE.indexOf(entry.category);
    return ROSTER_PRIORITY.length + (category >= 0 ? category : CATEGORY_RELEVANCE.length / 2);
  };
  const eligible = entries.filter((entry) => rosterEligible(entry, options));
  const sorted = eligible
    .filter(
      (entry) =>
        entry.scope !== "room" &&
        !options.omit?.has(entry.name) &&
        (!options.coreOnly || ROSTER_PRIORITY.includes(entry.name)),
    )
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  let result = "Commands (`help <name>` for syntax; `help catalog [name]` lists forms):";
  const encoder = new TextEncoder();
  // This room's own commands lead, names only (a room handler carries no summary).
  if (options.includeRoom !== false) {
    const roomNames: string[] = [];
    for (const entry of eligible.filter((e) => e.scope === "room")) {
      const next = `\nThis room: ${[...roomNames, entry.name].join(", ")}`;
      if (encoder.encode(result + next).length > Math.min(maxBytes, result.length + 240)) break;
      roomNames.push(entry.name);
    }
    if (roomNames.length) result += `\nThis room: ${roomNames.join(", ")}`;
  }
  for (const entry of sorted) {
    const line = `\n${entry.name}: ${clampSummary(entry.description ?? entry.help, maxLine)}`;
    if (encoder.encode(result + line).length <= maxBytes) result += line;
    // A core command that does not fit is skipped; past the core set the
    // roster stops at the first misfit rather than padding with whatever is short.
    else if (!ROSTER_PRIORITY.includes(entry.name)) break;
  }
  return result;
}
