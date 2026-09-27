// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { CommandForm } from "./command-forms";

export interface CommandCatalogEntry {
  forms?: CommandForm[];
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
/** Byte bounded, live roster. Selection is command ids, never separately maintained prose. */
export function renderCapabilityRoster(entries: CommandCatalogEntry[], maxBytes = 1900): string {
  const preferred = [
    "look",
    "say",
    "tell",
    "note",
    "recall",
    "context",
    "memory",
    "reflect",
    "pool",
    "skill",
    "desire",
    "standing",
    "witness",
    "evolve",
    "next",
    "task",
    "crew",
    "agent",
    "code",
    "help",
  ];
  const sorted = [...entries].sort((a, b) => {
    const score = (name: string) =>
      preferred.includes(name) ? preferred.indexOf(name) : preferred.length;
    return score(a.name) - score(b.name) || a.name.localeCompare(b.name);
  });
  let result = "Commands (help <name> for current syntax; help catalog for the full manifest):";
  const encoder = new TextEncoder();
  for (const entry of sorted) {
    const line = `\n${entry.name}: ${entry.description ?? entry.help.split("\n")[0]}`;
    if (encoder.encode(result + line).length > maxBytes) continue;
    result += line;
  }
  return result;
}
