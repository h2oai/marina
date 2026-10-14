// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { NoteRow } from "../../persistence/database";
import type { CommandUsage } from "../../sdk/command-forms";
import { getRecipe } from "./usecase";

const DEFAULT_MAX_NOTE_LENGTH = 700;

/**
 * The part of a command definition the auditor reads: its name, aliases and
 * declared usage forms. Pass the live router's builtins (`allBuiltins()`), so
 * what counts as a real subcommand is what the command itself declares —
 * never a hand-kept list that drifts.
 */
export interface CommandVocabularyEntry {
  name: string;
  aliases?: readonly string[];
  usage?: readonly CommandUsage[];
}

/** What an audit judges command references against: the live builtins plus
 *  names with no declared forms (the loaded rooms' own commands). */
export interface CommandVocabulary {
  commands: readonly CommandVocabularyEntry[];
  knownCommands?: readonly string[];
}

/**
 * Bare verbs a handler still accepts but no longer advertises in its usage
 * forms (kept so old notes and agents keep working). Each entry needs a reason.
 */
const UNADVERTISED_FORMS: Record<string, readonly string[]> = {
  // `memory kv <verb>` is canonical; the bare core-memory verbs stay accepted.
  memory: ["delete", "get", "history", "list", "set"],
};

interface CommandShape {
  /** Literal second tokens some form starts with. */
  seconds: Set<string>;
  /** Some form takes a free positional (`<x>`/`[x]`) in second position. */
  positionalSecond: boolean;
  /** Literal third tokens of forms whose second token is positional. */
  thirds: Set<string>;
  /** A positional-second form takes a positional (or nothing) in third position. */
  positionalThird: boolean;
}

const PLACEHOLDER = /^[<[]/;

function literalAlternatives(token: string): string[] {
  return token
    .replace(/^\(|\)$/g, "")
    .split("|")
    .map((part) => part.toLowerCase())
    .filter((part) => /^[a-z][a-z0-9-]*$/.test(part));
}

function commandShape(entry: CommandVocabularyEntry): CommandShape {
  const shape: CommandShape = {
    seconds: new Set(UNADVERTISED_FORMS[entry.name] ?? []),
    positionalSecond: false,
    thirds: new Set(),
    positionalThird: false,
  };
  for (const usage of entry.usage ?? []) {
    const syntax = typeof usage === "string" ? usage : usage.syntax;
    const tokens = syntax.trim().split(/\s+/);
    const second = tokens[1];
    if (!second) continue;
    if (PLACEHOLDER.test(second)) {
      shape.positionalSecond = true;
      // `[rooms|entities|<room-id>]`: an optional group can still name literals.
      for (const alt of literalAlternatives(second.replace(/^\[|\]$/g, ""))) shape.seconds.add(alt);
      const third = tokens[2];
      if (!third || PLACEHOLDER.test(third) || third === "..") shape.positionalThird = true;
      else for (const alt of literalAlternatives(third)) shape.thirds.add(alt);
    } else {
      for (const alt of literalAlternatives(second)) shape.seconds.add(alt);
    }
  }
  return shape;
}

/** name/alias → shape, built once per vocabulary. */
function buildVocabulary(entries: readonly CommandVocabularyEntry[]): Map<string, CommandShape> {
  const vocabulary = new Map<string, CommandShape>();
  for (const entry of entries) {
    const shape = commandShape(entry);
    for (const name of [entry.name, ...(entry.aliases ?? [])]) vocabulary.set(name, shape);
  }
  return vocabulary;
}

export interface KnowledgeHygieneFinding {
  kind: "duplicate" | "overlong" | "stale-command" | "unsupported-claim" | "stale";
  noteIds: number[];
  detail: string;
}

export interface KnowledgeHygieneReport {
  total: number;
  duplicateGroups: KnowledgeHygieneFinding[];
  overlong: KnowledgeHygieneFinding[];
  staleCommands: KnowledgeHygieneFinding[];
  unsupportedClaims: KnowledgeHygieneFinding[];
  stale: KnowledgeHygieneFinding[];
}

export function auditKnowledgeNotes(
  notes: NoteRow[],
  opts?: {
    /**
     * Live command definitions (`router.allBuiltins()`): names, aliases and
     * the subcommands their usage forms declare. Without these (or
     * `knownCommands`) stale-command detection is skipped — there is nothing
     * to judge a reference against.
     */
    commands?: readonly CommandVocabularyEntry[];
    /** Extra command names with no declared forms (room commands, extensions). */
    knownCommands?: Iterable<string>;
    maxNoteLength?: number;
    /** When set, notes untouched for longer than this are flagged `stale`. */
    maxAgeMs?: number;
    /** Reference time for stale detection; defaults to Date.now(). */
    now?: number;
  },
): KnowledgeHygieneReport {
  const maxNoteLength = opts?.maxNoteLength ?? DEFAULT_MAX_NOTE_LENGTH;
  const vocabulary = buildVocabulary(opts?.commands ?? []);
  const knownCommands = new Set([...vocabulary.keys(), ...(opts?.knownCommands ?? [])]);
  const judgeCommands = knownCommands.size > 0;
  const duplicateGroups = findDuplicateGroups(notes);
  const overlong = notes
    .filter((note) => note.content.length > maxNoteLength)
    .map((note) => ({
      kind: "overlong" as const,
      noteIds: [note.id],
      detail: `${note.content.length} chars; target <= ${maxNoteLength}`,
    }));
  const staleCommands = notes.flatMap((note) =>
    (judgeCommands ? findStaleCommandRefs(note.content, knownCommands, vocabulary) : []).map(
      (detail) => ({
        kind: "stale-command" as const,
        noteIds: [note.id],
        detail,
      }),
    ),
  );
  const unsupportedClaims = notes
    .filter((note) => isUnsupportedClaim(note.content))
    .map((note) => ({
      kind: "unsupported-claim" as const,
      noteIds: [note.id],
      detail: `empirical claim with no citation: "${preview(note.content)}"`,
    }));
  const stale = findStaleNotes(notes, opts?.maxAgeMs, opts?.now);
  return {
    total: notes.length,
    duplicateGroups,
    overlong,
    staleCommands,
    unsupportedClaims,
    stale,
  };
}

export function renderKnowledgeHygieneReport(
  title: string,
  report: KnowledgeHygieneReport,
): string {
  const lines = [
    `${title} hygiene audit`,
    `Notes checked: ${report.total}`,
    `Duplicate groups: ${report.duplicateGroups.length}`,
    `Overlong notes: ${report.overlong.length}`,
    `Stale command refs: ${report.staleCommands.length}`,
    `Unsupported claims: ${report.unsupportedClaims.length}`,
    `Stale notes: ${report.stale.length}`,
  ];

  const findings = [
    ...report.duplicateGroups.slice(0, 5),
    ...report.overlong.slice(0, 5),
    ...report.staleCommands.slice(0, 5),
    ...report.unsupportedClaims.slice(0, 5),
    ...report.stale.slice(0, 5),
  ];
  if (findings.length === 0) {
    lines.push("No hygiene findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      lines.push(`  - ${finding.kind} #${finding.noteIds.join(",#")}: ${finding.detail}`);
    }
  }
  return lines.join("\n");
}

// Strong empirical-assertion markers — a note making one of these reads as a
// factual claim that should be backed by a source. Kept deliberately tight:
// instructional how-to notes ("recall searches the pool") must NOT trip this,
// so common words like "always"/"never"/"best" are excluded.
const CLAIM_MARKERS: RegExp[] = [
  /\b\d{1,3}(?:\.\d+)?\s?%/, // percentages
  /\b(stud(?:y|ies)|research|evidence|data|experiments?)\s+(?:show|shows|showed|suggest|suggests|prove|proves|proven|indicate|indicates|confirm|confirms)\b/i,
  /\b(?:scientifically|clinically|statistically)\s+(?:proven|significant|shown)\b/i,
  /\bguarantee(?:s|d)?\b/i,
  /\b\d+(?:\.\d+)?x\s+(?:faster|slower|better|worse|more|less|higher|lower)\b/i,
];

// Citation/provenance markers — presence of any means the claim is sourced.
const CITATION_MARKERS: RegExp[] = [
  /https?:\/\//i,
  /\[[^\]]+\]/, // [ref], [1], [TabH2O forecast 3]
  /\bsources?\b/i,
  /\bcite[ds]?\b/i,
  /\b(?:doi|arxiv)\b/i,
  /#\d+/, // note-id reference
];

function isUnsupportedClaim(content: string): boolean {
  const hasClaim = CLAIM_MARKERS.some((re) => re.test(content));
  if (!hasClaim) return false;
  const hasCitation = CITATION_MARKERS.some((re) => re.test(content));
  return !hasCitation;
}

function findStaleNotes(
  notes: NoteRow[],
  maxAgeMs: number | undefined,
  now: number | undefined,
): KnowledgeHygieneFinding[] {
  if (!maxAgeMs || maxAgeMs <= 0) return []; // opt-in only
  const ref = now ?? Date.now();
  const findings: KnowledgeHygieneFinding[] = [];
  for (const note of notes) {
    // "Stale" = nobody has touched it in maxAgeMs (last_accessed, else created).
    const lastTouched = note.last_accessed ?? note.created_at;
    const ageMs = ref - lastTouched;
    if (ageMs > maxAgeMs) {
      const ageDays = Math.floor(ageMs / 86_400_000);
      findings.push({
        kind: "stale",
        noteIds: [note.id],
        detail: `untouched ${ageDays}d: "${preview(note.content)}"`,
      });
    }
  }
  return findings;
}

function findDuplicateGroups(notes: NoteRow[]): KnowledgeHygieneFinding[] {
  const byContent = new Map<string, NoteRow[]>();
  for (const note of notes) {
    const key = normalizeContent(note.content);
    if (!key) continue;
    const group = byContent.get(key) ?? [];
    group.push(note);
    byContent.set(key, group);
  }
  return [...byContent.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      kind: "duplicate" as const,
      noteIds: group.map((note) => note.id),
      detail: preview(group[0]?.content ?? ""),
    }));
}

function normalizeContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

function findStaleCommandRefs(
  content: string,
  knownCommands: Set<string>,
  vocabulary: Map<string, CommandShape>,
): string[] {
  const findings = new Set<string>();
  for (const ref of extractCommandRefs(content)) {
    const tokens = ref.trim().split(/\s+/);
    const command = tokens[0]?.toLowerCase();
    if (!command || command.startsWith("<")) continue;
    if (!knownCommands.has(command)) {
      // Only a multi-token ref that *looks* like a command invocation counts
      // as a stale reference. Bare single words in backticks are names and
      // values (a world, a room, a role, a key), and env assignments / room
      // ids / pool names / code identifiers are not commands at all.
      if (tokens.length >= 2 && looksLikeCommandWord(command)) {
        findings.add(`unknown command "${command}" in "${preview(ref)}"`);
      }
      continue;
    }
    const staleSubcommand = findStaleSubcommand(command, tokens, vocabulary);
    if (staleSubcommand) findings.add(staleSubcommand);
  }
  return [...findings];
}

/** Operator shell invocations (`bun run arena submit due`, `git log`) that
 *  guide text legitimately cites; they are run outside the world. */
const SHELL_TOOLS = new Set(["bun", "bunx", "git", "npm", "npx"]);

/** A Marina command name is lowercase letters, digits and hyphens. Anything
 *  carrying `/` (room id), `=` (env assignment), `:` (pool/channel name),
 *  `.` (code identifier) or uppercase (env var) is a literal, not a command. */
function looksLikeCommandWord(word: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(word) && !SHELL_TOOLS.has(word);
}

function extractCommandRefs(content: string): string[] {
  const refs: string[] = [];
  for (const match of content.matchAll(/`([^`]+)`/g)) {
    if (match[1]) refs.push(match[1]);
  }
  const actions = content.match(/\bActions:\s*(.+)$/i)?.[1];
  if (actions) refs.push(...actions.split(";").map((part) => part.trim()));
  return refs.filter(Boolean);
}

const LITERAL = /^[a-z][a-z0-9-]*$/;

/**
 * A reference's subcommand must be one some usage form of the command
 * declares. A command whose forms take a free positional second token
 * (`note <text>`, `pool <name> …`) accepts any second token; when every such
 * form names a literal action third (`pool <name> recall`), that action is
 * checked instead — the last token too, for multi-word names such as
 * `project Debut Tour join`.
 */
function findStaleSubcommand(
  command: string,
  tokens: string[],
  vocabulary: Map<string, CommandShape>,
): string | undefined {
  const shape = vocabulary.get(command);
  if (!shape || tokens.length < 2) return undefined;
  const sub = tokens[1]?.toLowerCase() ?? "";
  if (sub.startsWith("<") || shape.seconds.has(sub)) return undefined;
  // `usecase <recipe> <topic>`: every registered recipe is a valid second token.
  if (command === "usecase" && getRecipe(sub)) return undefined;
  if (!shape.positionalSecond) {
    // An id, quoted text or flag is an argument, not a missing subcommand.
    if (!LITERAL.test(sub)) return undefined;
    return `unknown ${command} action "${sub}" in "${preview(tokens.join(" "))}"`;
  }
  if (shape.positionalThird || shape.thirds.size === 0) return undefined;
  const third = tokens[2]?.toLowerCase();
  const last = tokens[tokens.length - 1]?.toLowerCase();
  if (!third || !LITERAL.test(third) || shape.thirds.has(third)) return undefined;
  if (last && shape.thirds.has(last)) return undefined;
  return `unknown ${command} action "${third}" in "${preview(tokens.join(" "))}"`;
}

function preview(value: string, limit = 80): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}...` : cleaned;
}
