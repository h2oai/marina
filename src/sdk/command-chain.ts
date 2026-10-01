// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `;` chains only inside `batch` (and stored macros). Everywhere else the
// router hands the WHOLE line to the first command, so `memory delete rest;
// project hab join` deletes a key named `rest;` and never joins. This helper
// does not change that: it only spots, conservatively, segments after a `;`
// that read as commands the caller probably expected to run, so an agent
// surface can say so in one line.

import type { CommandCatalogEntry } from "./capabilities";
import { type CommandForm, matchCommandForm } from "./command-forms";

type Part = CommandForm["parts"][number];

/** Word index -> most literal words matched on a path that ends there. */
type Ends = Map<number, number>;

function keep(into: Ends, at: number, literals: number): void {
  if ((into.get(at) ?? -1) < literals) into.set(at, literals);
}

/** Every word index at which `parts` can finish when matched from `start`. */
function ends(parts: Part[], form: CommandForm, words: string[], start: Ends): Ends {
  let positions = start;
  for (let i = 0; i < parts.length && positions.size; i++) {
    const part = parts[i]!;
    const next: Ends = new Map();
    if (part.group) {
      for (const [at, n] of positions) keep(next, at, n); // optional: skipped
      for (const [at, n] of ends(part.children ?? [], form, words, positions)) keep(next, at, n);
    } else if (part.literal !== undefined) {
      if (part.literal === "\n" || !part.literal.trim()) continue;
      const literal = part.literal.toLowerCase();
      const joined = /[:=]$/.test(literal) && parts[i + 1]?.field;
      for (const [at, n] of positions) {
        const word = words[at]?.toLowerCase();
        if (word === undefined) continue;
        if (joined ? word.startsWith(literal) && word.length > literal.length : word === literal)
          keep(next, at + 1, n + 1);
      }
      if (joined) i++; // `key:<value>` is one word
    } else {
      const field = form.fields.find((f) => f.id === part.field);
      for (const [at, n] of positions) {
        if (at >= words.length) continue;
        if (field?.multiline || field?.kind === "json") {
          for (let end = at + 1; end <= words.length; end++) keep(next, end, n);
        } else if (!field?.choices || field.choices.includes(words[at]!)) keep(next, at + 1, n);
      }
    }
    positions = next;
  }
  return positions;
}

/**
 * How many literal words (the verb included) a complete parse of `input`
 * as one of `forms` pins down; -1 when no declared form accepts all of it.
 */
function formLiterals(forms: CommandForm[], input: string): number {
  const words = input.trim().split(/\s+/).filter(Boolean);
  let best = -1;
  for (const form of forms) {
    const parsed = ends(form.parts, form, words, new Map([[0, 0]])).get(words.length);
    if (parsed !== undefined && parsed > best) best = parsed;
  }
  return best;
}

function catalogIndex(catalog: readonly CommandCatalogEntry[]): Map<string, CommandCatalogEntry> {
  const index = new Map<string, CommandCatalogEntry>();
  for (const entry of catalog) {
    for (const name of [entry.name, ...entry.aliases]) {
      const key = name.toLowerCase();
      if (!index.has(key)) index.set(key, entry);
    }
  }
  return index;
}

/** Put the canonical name first so forms (written with it) match an alias. */
function canonical(entry: CommandCatalogEntry, segment: string): string {
  return segment.replace(/^\S+/, entry.name);
}

const commandForms = (entry: CommandCatalogEntry) =>
  (entry.forms ?? []).filter((form) => form.encoding !== "named");

/**
 * The `;`-separated segments of a non-`batch` input that look like commands
 * which did NOT run (the router gave the whole line to the first command).
 *
 * Conservative: the first word must be a catalog command (an unknown head
 * may be a macro, which does split). When the first segment is a complete
 * declared form on its own and that grammar cannot swallow the rest
 * (`look; task list`), a later segment counts when its first word is a
 * catalog verb with a recognised subcommand. Otherwise the first command
 * may take the `;` as free text (`say`, `note`, `memory set <k> <text>`, or
 * a command with no declared form for it), so a segment must parse as a
 * complete declared form that is a bare verb or pins a second literal word.
 * Anything ambiguous is not reported.
 */
export function detectUnsplitChain(raw: string, catalog: readonly CommandCatalogEntry[]): string[] {
  const input = raw.trim().replace(/^\//, "");
  if (!input.includes(";")) return [];
  const [head, ...rest] = input.split(";");
  const index = catalogIndex(catalog);
  const headEntry = index.get(head!.trim().split(/\s+/)[0]!.toLowerCase());
  if (!headEntry || headEntry.name === "batch") return [];
  const headForms = commandForms(headEntry);
  // Lenient only with positive evidence: the first segment is a complete
  // command on its own and its grammar cannot absorb the rest as free text.
  const freeText =
    formLiterals(headForms, canonical(headEntry, head!)) < 0 ||
    formLiterals(headForms, canonical(headEntry, input)) >= 0;
  const unrun: string[] = [];
  for (const piece of rest) {
    const segment = piece.trim().replace(/\s+/g, " ");
    if (!segment) continue;
    const entry = index.get(segment.split(" ")[0]!.toLowerCase());
    if (!entry) continue;
    const forms = commandForms(entry);
    const command = canonical(entry, segment);
    const literals = forms.length ? formLiterals(forms, command) : -1;
    if (freeText) {
      // Inside free text only an unmistakable command counts: a bare verb
      // (`look`) or one whose parse pins a second literal word (`task list`,
      // `project hab join`); `help me` / `recall goals` read as prose.
      if (literals >= 2 || (literals === 1 && !segment.includes(" "))) unrun.push(segment);
    } else if (literals >= 0 || !forms.length || matchCommandForm(forms, command)) {
      // Otherwise a known verb with a recognised subcommand is enough.
      unrun.push(segment);
    }
  }
  return unrun;
}

/** The one terse line an agent surface appends, or "" when nothing was left unrun. */
export function unsplitChainNote(raw: string, catalog: readonly CommandCatalogEntry[]): string {
  const unrun = detectUnsplitChain(raw, catalog);
  if (!unrun.length) return "";
  const names = unrun.map((segment) => `\`${segment}\``).join(", ");
  return `note: ';' is not a separator here — ${names} did not run; use \`batch <a>; <b>\` to run several`;
}
