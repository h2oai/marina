// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CommandCatalogEntry } from "../../../src/net/discovery-types";

/** Ordered subsequence matching, with exact and contiguous matches ranked first. */
export function fuzzyScore(query: string, value: string): number {
  const needle = query.trim().toLowerCase();
  const haystack = value.toLowerCase();
  if (!needle) return 1;
  if (haystack === needle) return 1000;
  const at = haystack.indexOf(needle);
  if (at >= 0) return 500 - Math.min(at, 200);
  let cursor = 0;
  let gaps = 0;
  for (const char of needle) {
    const next = haystack.indexOf(char, cursor);
    if (next < 0) return 0;
    gaps += next - cursor;
    cursor = next + 1;
  }
  // Long help pages otherwise match almost any subsequence (even an entity name).
  return gaps > Math.max(8, needle.length * 2) ? 0 : 100 / (1 + gaps);
}

export function matchCommands(commands: CommandCatalogEntry[], query: string, category = "") {
  return commands
    .filter((cmd) => !category || cmd.category === category)
    .map((cmd) => ({
      cmd,
      score: Math.max(
        fuzzyScore(query, cmd.name),
        ...cmd.aliases.map((alias) => fuzzyScore(query, alias)),
        fuzzyScore(query, cmd.help) * 0.5,
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name))
    .map(({ cmd }) => cmd);
}

/** Insert for review. Never dispatch a command merely because a result was selected. */
export function draftCommand(command: string) {
  window.dispatchEvent(new CustomEvent("marina:draft-command", { detail: { command } }));
}

export function isEditing(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    !!target.closest(
      "input, textarea, select, [contenteditable='true'], [role='dialog'], dialog[open]",
    )
  );
}
