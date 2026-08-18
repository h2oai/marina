// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { NoteRow } from "../../persistence/database";

const DEFAULT_MAX_NOTE_LENGTH = 700;

const KNOWN_SUBCOMMANDS: Record<string, Set<string>> = {
  agent: new Set(["config", "list", "logs", "spawn", "status", "stop"]),
  benchmark: new Set([
    "leaderboard",
    "list",
    "orchestrations",
    "reference",
    "run",
    "runs",
    "sweep",
  ]),
  board: new Set(["archive", "create", "list", "pin", "post", "read", "reply", "search", "vote"]),
  build: new Set([
    "audit",
    "code",
    "command",
    "destroy",
    "diff",
    "link",
    "modify",
    "reload",
    "revert",
    "room",
    "template",
    "unlink",
    "validate",
  ]),
  channel: new Set(["create", "history", "join", "leave", "list", "listall", "send"]),
  chronicle: new Set(["about", "correct", "digest", "kinds", "pending", "record", "show", "since"]),
  code: new Set(["apply", "diff", "run", "session", "status"]),
  conduct: new Set(["learned", "resolve", "run"]),
  feed: new Set(["kinds", "list"]),
  memory: new Set(["delete", "get", "history", "list", "set"]),
  note: new Set([
    "correct",
    "delete",
    "evolve",
    "graph",
    "link",
    "list",
    "room",
    "search",
    "trace",
    "types",
    "unlink",
  ]),
  pool: new Set(["add", "audit", "create", "list", "recall", "status"]),
  project: new Set([
    "create",
    "decompose",
    "info",
    "join",
    "list",
    "memory",
    "orchestrate",
    "propose",
    "status",
    "tasks",
  ]),
  quest: new Set(["abandon", "complete", "list", "start", "status"]),
  role: new Set(["create", "delete", "edit", "history", "lint", "list", "reload", "view"]),
  skill: new Set(["audit", "compose", "import", "list", "search", "share", "store", "verify"]),
  task: new Set([
    "assign",
    "approve",
    "bundle",
    "cancel",
    "children",
    "claim",
    "create",
    "goal",
    "info",
    "list",
    "progress",
    "reject",
    "standing",
    "submit",
  ]),
  trait: new Set(["create", "delete", "history", "lint", "list", "view"]),
  usecase: new Set(["info", "list"]),
  watch: new Set(["list", "probe", "retire"]),
  web: new Set(["fetch", "read", "search"]),
};

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
    knownCommands?: Iterable<string>;
    maxNoteLength?: number;
    /** When set, notes untouched for longer than this are flagged `stale`. */
    maxAgeMs?: number;
    /** Reference time for stale detection; defaults to Date.now(). */
    now?: number;
  },
): KnowledgeHygieneReport {
  const maxNoteLength = opts?.maxNoteLength ?? DEFAULT_MAX_NOTE_LENGTH;
  const knownCommands = new Set([
    ...Object.keys(KNOWN_SUBCOMMANDS),
    ...(opts?.knownCommands ?? []),
  ]);
  const duplicateGroups = findDuplicateGroups(notes);
  const overlong = notes
    .filter((note) => note.content.length > maxNoteLength)
    .map((note) => ({
      kind: "overlong" as const,
      noteIds: [note.id],
      detail: `${note.content.length} chars; target <= ${maxNoteLength}`,
    }));
  const staleCommands = notes.flatMap((note) =>
    findStaleCommandRefs(note.content, knownCommands).map((detail) => ({
      kind: "stale-command" as const,
      noteIds: [note.id],
      detail,
    })),
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

function findStaleCommandRefs(content: string, knownCommands: Set<string>): string[] {
  const findings = new Set<string>();
  for (const ref of extractCommandRefs(content)) {
    const tokens = ref.trim().split(/\s+/);
    const command = tokens[0]?.toLowerCase();
    if (!command || command.startsWith("<")) continue;
    if (!knownCommands.has(command)) {
      findings.add(`unknown command "${command}" in "${preview(ref)}"`);
      continue;
    }
    const staleSubcommand = findStaleSubcommand(command, tokens);
    if (staleSubcommand) findings.add(staleSubcommand);
  }
  return [...findings];
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

function findStaleSubcommand(command: string, tokens: string[]): string | undefined {
  const known = KNOWN_SUBCOMMANDS[command];
  if (!known || tokens.length < 2) return undefined;

  if (command === "note") return undefined;

  if (command === "pool") {
    const second = tokens[1]?.toLowerCase();
    const third = tokens[2]?.toLowerCase();
    if (!second || second.startsWith("<")) return undefined;
    if (known.has(second)) return undefined;
    if (third && !third.startsWith("<") && !known.has(third)) {
      return `unknown pool action "${third}" in "${preview(tokens.join(" "))}"`;
    }
    if (!third && ["join", "read"].includes(second)) {
      return `unknown pool action "${second}" in "${preview(tokens.join(" "))}"`;
    }
    return undefined;
  }

  if (command === "project") {
    const second = tokens[1]?.toLowerCase();
    const third = tokens[2]?.toLowerCase();
    if (!second || second.startsWith("<")) return undefined;
    if (known.has(second)) return undefined;
    if (third && !third.startsWith("<") && !known.has(third)) {
      return `unknown project action "${third}" in "${preview(tokens.join(" "))}"`;
    }
    return undefined;
  }

  const sub = tokens[1]?.toLowerCase();
  if (!sub || sub.startsWith("<") || known.has(sub)) return undefined;
  return `unknown ${command} action "${sub}" in "${preview(tokens.join(" "))}"`;
}

function preview(value: string, limit = 80): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}...` : cleaned;
}
