// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { CommandCatalogEntry } from "../net/discovery-types";
import { compileCommandForms } from "../sdk/command-forms";
import type { CommandDef, CommandHandler } from "../types";
import type { CommandRouter } from "./command-router";

const descriptions = new WeakMap<CommandDef, CommandCatalogEntry>();

/** Serializable discovery only. Execution always checks the live router and gates. */
export function describeCommand(def: CommandDef): CommandCatalogEntry {
  const cached = descriptions.get(def);
  if (cached) return cached;
  const result: CommandCatalogEntry = {
    name: def.name,
    aliases: def.aliases ?? [],
    help: def.help,
    description: def.help.split(/\.(?:\s|$)|\n|Usage:/)[0]!.trim(),
    category: def.category ?? "Other",
    minRank: def.minRank ?? 0,
    gate: def.gate,
    structured: !!def.usage?.length,
    forms: compileCommandForms(def.usage ?? []),
    scope: "world",
  };
  descriptions.set(def, result);
  return result;
}

export function commandManifest(
  router: CommandRouter,
  options: { roomCommands?: Record<string, CommandHandler>; rank?: number; modal?: string } = {},
): CommandCatalogEntry[] {
  const entries = router.allBuiltins().map((def) => {
    const entry = {
      ...describeCommand(def),
      aliases: (def.aliases ?? []).filter((alias) => !options.roomCommands?.[alias]),
    };
    const reasons: string[] = [];
    if (def.gate) reasons.push(`Requires ${def.gate}; evaluated when executed`);
    if (options.rank !== undefined && options.rank < (def.minRank ?? 0))
      reasons.push(`Rank ${def.minRank} or the current autonomy policy is required`);
    if (options.modal)
      reasons.push(`${options.modal} mode can redirect this input; exit it for world commands`);
    if (options.roomCommands?.[def.name]) reasons.push("The current room overrides this command");
    return {
      ...entry,
      owner: router.ownerOf(def.name),
      revision: router.revision,
      availability: {
        status: reasons.length ? ("conditional" as const) : ("available" as const),
        reasons,
      },
    };
  });
  for (const name of Object.keys(options.roomCommands ?? {})) {
    // A room handler has no schema contract. Never reuse a shadowed builtin's form.
    const entry: CommandCatalogEntry = {
      name,
      aliases: [],
      category: "This room",
      help: "Command provided by this room. Ask here for usage.",
      minRank: router.getDef(name)?.minRank ?? 0,
      gate: router.getDef(name)?.gate,
      owner: "room",
      scope: "room",
      revision: router.revision,
      structured: false,
      forms: [],
      availability: {
        status: "conditional",
        reasons: ["Room-specific behavior; execution checks still apply"],
      },
    };
    const index = entries.findIndex((c) => c.name === name);
    if (index >= 0) entries.splice(index, 1);
    entries.push(entry as (typeof entries)[number]);
  }
  return entries;
}
