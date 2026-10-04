// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { TERMINAL_CONTROLS, terminalControls } from "./code-controls";
import { WORKFLOW_COMPLETIONS } from "./code-workflow";

const ARGUMENTS = [
  ...["auto", "focus", "split"].map((layout) => `/layout ${layout}`),
  ...WORKFLOW_COMPLETIONS,
  ...["coding", "world", "approvals", "panel", "older", "newer", "latest"].map(
    (view) => `/view ${view}`,
  ),
  ...["list", "export", "save", "use"].map((verb) => `/harness ${verb}`),
];

/** Completion edits a draft only. No filesystem scan, world action or guessed artifact IDs. */
export function terminalCompletionFor(connected = false): AutocompleteProvider {
  return {
    triggerCharacters: ["/"],
    async getSuggestions(lines, row, column) {
      if (row !== 0 || lines.length !== 1 || column !== lines[0]?.length) return null;
      const prefix = lines[0]!;
      if (!prefix.startsWith("/")) return null;
      const entries = prefix.includes(" ")
        ? ARGUMENTS.map((value) => ({
            value,
            label: value,
            description: TERMINAL_CONTROLS.find((entry) => value.startsWith(`${entry.name} `))
              ?.help,
          }))
        : terminalControls(connected).map((entry) => ({
            value: entry.name,
            label: entry.usage,
            description: entry.help,
          }));
      const items = entries.filter(
        (entry) => entry.value.startsWith(prefix) && entry.value !== prefix,
      );
      return items.length ? { items, prefix } : null;
    },
    applyCompletion(lines, row, column, item, prefix) {
      const replacement = `${item.value} `;
      const next = [...lines];
      next[row] =
        `${next[row]!.slice(0, column - prefix.length)}${replacement}${next[row]!.slice(column)}`;
      return {
        lines: next,
        cursorLine: row,
        cursorCol: column - prefix.length + replacement.length,
      };
    },
  };
}

export const terminalCompletion = terminalCompletionFor();

export function inputGuidance(text: string, world: boolean, connected = false): string {
  const verb = text.trimStart().split(/\s/, 1)[0];
  const control = terminalControls(connected).find((entry) => entry.name === verb);
  if (control) return `${control.usage} — ${control.help}`;
  return world
    ? "World command · try look, who, tell <name> <message> or help"
    : "Describe a task, or use /task <request> for candidate-verified work. Type / for controls.";
}
