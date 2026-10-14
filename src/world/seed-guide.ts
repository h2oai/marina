// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { tryLog } from "../engine/errors";
import { Logger } from "../engine/logger";
import { ensureInstitutionalSpace } from "../memory/institutional";
import type { MarinaDB } from "../persistence/database";
import { type EntityRank, RANK_NAMES } from "../types";
import type { GuideNote } from "./world-definition";

const POOL_NAME = "guide";
const AUTHOR = "Guide";

/**
 * Platform-wide guide notes seeded into EVERY world's guide pool, regardless of
 * what the world declares. These teach the self-improvement ("evolver") loop —
 * benchmarks + skills + reflection — which previously had no in-world home
 * outside the evolve world. Agents reach them via `pool guide recall <topic>`,
 * `ask <topic>`, or the `evolve` command. Keep them terse and recall-friendly
 * (lead with the keywords an agent would search: evolve, improve, skill,
 * benchmark, recall). Every entry has a stable `key`: editing the text
 * supersedes the old note on the next boot (see `seedGuidePool`).
 */
export const PLATFORM_GUIDE_NOTES: GuideNote[] = [
  {
    key: "platform:forecast",
    type: "skill",
    importance: 8,
    content:
      "forecast — answer a question about the future: `forecast <question>` (alias `predict`) " +
      'returns a probability for a yes/no question ("Will …") or a number with a 10–90% ' +
      "interval, plus sources. Research is retrieved, its figures are checked against the cited " +
      "pages, several models answer, and a judge weights each by how well the verified facts " +
      "support it. Add `resolve:YYYY-MM-DD` or `unit:<u>` when the question does not say. Rate " +
      "limited per entity; needs a provider key.",
  },
  {
    key: "platform:arena",
    type: "fact",
    importance: 4,
    content:
      "arena — read-only status of the Social Simulation Arena (an external forecasting " +
      "benchmark): `arena`, `arena rounds`, `arena show <round_id>`. Filing is an operator step " +
      "outside the world.",
  },
  {
    key: "platform:evolve-loop",
    type: "skill",
    importance: 9,
    content:
      "evolve / self-improvement loop: get better, not just busy. `evolve` shows where you stand " +
      "and one next step; `evolve loop` explains the cycle. (1) Measure where you are. (2) " +
      "Change one thing — a sharper note, a better recall query, a stored skill, or a successor " +
      "role: you never edit the role you run on; `role create <role>-v2` and `agent spawn " +
      "<name> role <role>-v2` start an improved iteration. (3) Compare with evidence — " +
      "`evolve trial` runs both roles in a child world, `evolve decide` records the verdict. " +
      "(4) Keep what won: `skill store`. (5) `reflect` to consolidate.",
  },
  {
    key: "platform:skills",
    type: "skill",
    importance: 8,
    content:
      "skills — bank what works: when a sequence of actions reliably gets a result, store it " +
      "with `skill store <name> | <what it does> | <step ; step ; step>`. Find prior skills " +
      "with `skill search <query>`, review yours with `skill list`, combine them with " +
      "`skill compose <id1> <id2>`, and share to a pool with `skill share <id> <pool>`. " +
      "Skills outlive you — they're the starting point for whoever comes next.",
  },
  {
    key: "platform:pool-recall",
    type: "fact",
    importance: 7,
    content:
      "pool recall — searching shared knowledge: `pool <name> recall <topic>` does a keyword " +
      "search over a shared pool (e.g. `pool guide recall evolve`). `recall <topic>` searches " +
      "your own notes. If a search returns nothing, try different keywords — it matches words, " +
      "not exact phrases. What benchmark runs taught is in judged lessons: " +
      "`lessons <topic> domain:benchmark`.",
  },
  {
    key: "platform:behavior-surfaces",
    type: "fact",
    importance: 8,
    content:
      "behavior surfaces — choose the smallest durable surface that fits. Use roles for enduring " +
      "agent identity and duty; traits for reusable behavior atoms; skills for repeatable " +
      "procedures; guide notes for stable system orientation; project pools for local findings " +
      "and handoffs. Preview a role with `role view <name> goal <text>`, check shaping risks " +
      "with `role lint <name>` / `trait lint <name>`, and bank reliable workflows with " +
      "`skill store`.",
  },
  {
    key: "platform:communication",
    type: "fact",
    importance: 8,
    content:
      "real-time communication — humans and agents share one live world. `who` and `brief " +
      "social` show who is here; ask a person directly with `tell <name> <question>`. Post to a " +
      "channel (`channel send <name> <message>`) only when it changes someone's work: a " +
      "result, a blocker, a handoff. No acknowledgements or status chatter.",
  },
  {
    key: "platform:faster-loop",
    type: "skill",
    importance: 9,
    content:
      "faster loop — collapse discovery into action. After setting a goal, run `next`; if it " +
      "points at a canvas intent, claim it with `canvas intent claim <node>`; if it points at " +
      "a crew, activate or read the crew channel with `crew dispatch <name> <message>` or " +
      "`channel history crew:<id>`; if it points at a peer, ask directly with `tell <name> " +
      "<question>`. When the result matters, finish the loop with a note, pool deposit, " +
      "crew artifact, task submit, or intent complete. With nothing open, rest: " +
      "`memory set rest <why>`.",
  },
  {
    key: "platform:becoming",
    type: "fact",
    importance: 8,
    content:
      "Becoming — standing, witness, and the autonomy posture: `standing` shows your " +
      "contribution ledger and the path to every safety gate. Capability above the rank " +
      "ceiling is earned, not assigned: `witness request <gate>` asks a qualified holder — " +
      "someone who holds the gate solo — to grant a supervision window or attest your " +
      "recorded demonstrations. `desire <one sentence>` opens an evidence-linked journey " +
      "toward what you want to become. The operator's posture (guarded/earned/open) is the " +
      "ceiling dial; refusals name the path.",
  },
  {
    key: "platform:decision",
    type: "skill",
    importance: 7,
    content:
      "decision check / choose — cheap second opinions on your own work, when the world has a " +
      "decision backend (`MARINA_DECISIONS`). Before you submit or publish, `decision check " +
      "<request> | <draft>` scores your draft's quality; cite evidence as note:N, task:N or " +
      "chronicle:N and it also checks the claims are grounded in it. `decision choose <question> " +
      "| <option> | <option>` picks among options. Numbers only, fast and advisory — you decide " +
      "what to do with them. Cited evidence also counts at `task submit`.",
  },
];

/**
 * Leading tag on onboarding written for a person at a client (UI steps,
 * "send this prompt to Host"). Agent-facing recall of the guide pool can skip
 * notes that start with it, and a reader who sees it knows the note is not an
 * instruction to them. Declared with `GuideNote.audience: "people"`.
 */
export const HUMAN_ONBOARDING_TAG = "[for people]";

/** True for a guide note written for a person at a client, not for an agent. */
export function isHumanOnboardingNote(content: string): boolean {
  return content.startsWith(HUMAN_ONBOARDING_TAG);
}

/** The subset of a command definition a requirement phrase is built from. */
export interface CommandRequirement {
  name: string;
  aliases?: readonly string[];
  minRank?: number;
  gate?: string;
}

/** `rank 4 (builder)` — rank names come from RANK_NAMES, never a hand-kept ladder. */
export function rankLabel(rank: number): string {
  const name = RANK_NAMES[rank as EntityRank];
  return name ? `rank ${rank} (${name})` : `rank ${rank}`;
}

/** What it takes to run `command`, read from its live definition. */
export function describeRequirement(command: string, defs?: readonly CommandRequirement[]): string {
  const def = defs?.find((d) => d.name === command || d.aliases?.includes(command));
  if (!def) return `what \`help ${command}\` lists`;
  if (def.gate) return `the ${def.gate} gate (see \`standing\`)`;
  return (def.minRank ?? 0) > 0 ? rankLabel(def.minRank ?? 0) : "no rank";
}

/**
 * Expand `{{requires:<command>}}` in guide text from the live command
 * definitions, so a note never states a rank floor or gate the router does not
 * enforce. Without definitions it points at `help <command>`.
 */
export function expandGuideContent(content: string, defs?: readonly CommandRequirement[]): string {
  return content.replace(/\{\{requires:([a-z][a-z0-9-]*)\}\}/g, (_m, command: string) =>
    describeRequirement(command, defs),
  );
}

/** The text a guide note is stored with: requirements expanded, audience tagged. */
export function renderGuideNote(note: GuideNote, defs?: readonly CommandRequirement[]): string {
  const body = expandGuideContent(note.content, defs);
  return note.audience === "people" ? `${HUMAN_ONBOARDING_TAG} ${body}` : body;
}

/**
 * Stable key for a guide note: its explicit `key`, else a slug of its leading
 * topic (the text before the first dash, colon or sentence end).
 */
export function guideNoteKey(note: GuideNote): string {
  if (note.key) return note.key;
  const head = note.content.split(/\s[—–-]\s|:\s|\.\s/)[0] ?? note.content;
  const slug = head
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `world:${slug || "note"}`;
}

/** Core-memory owner holding `<note key> → <guide note id>`; its history is the audit trail. */
export const GUIDE_SEED_OWNER = "guide:seed";
const RETIRED_PREFIX = "retired:";

export interface GuideSeedResult {
  added: number;
  kept: number;
  retired: number;
}

/** One seeded note: a stable key plus the exact text it is stored with. */
export interface SeedNoteSpec {
  key: string;
  content: string;
  importance: number;
  type?: string;
}

/**
 * Reconcile the notes `author` seeded into a pool with the current
 * definitions. A definition whose exact text is present keeps that note;
 * otherwise the text is added. Every active `author` note no definition
 * claims — an edited or removed seed — is retired through `note delete`'s
 * canonical path (the record history keeps the old text; nothing is
 * hard-deleted). `<key> → <note id>` is kept in core memory under `owner`, so
 * each change of a key's note is in that key's history. Notes by any other
 * author are never touched, so `author` must be a name only the seed writes as.
 */
export function reconcileSeedNotes(
  db: MarinaDB,
  opts: { poolId: string; author: string; owner: string; notes: readonly SeedNoteSpec[] },
): GuideSeedResult {
  const result: GuideSeedResult = { added: 0, kept: 0, retired: 0 };
  const active = db
    .getPoolNotes(opts.poolId, Math.max(1_000, db.countPoolNotes(opts.poolId)))
    .filter(
      (note) => note.entity_name === opts.author && note.verification_status !== "superseded",
    );
  // Oldest first, so an existing note keeps its id across boots.
  const byContent = new Map<string, number[]>();
  for (const note of [...active].sort((a, b) => a.id - b.id)) {
    const ids = byContent.get(note.content) ?? [];
    ids.push(note.id);
    byContent.set(note.content, ids);
  }
  const mapping = new Map(
    db.listCoreMemory(opts.owner).map((row) => [row.key, row.value] as const),
  );

  const claimed = new Set<number>();
  for (const spec of opts.notes) {
    let id = byContent.get(spec.content)?.find((candidate) => !claimed.has(candidate));
    if (id !== undefined) {
      result.kept++;
    } else {
      id = db.addPoolNote(opts.poolId, opts.author, spec.content, spec.importance, spec.type, {
        skipDedup: true,
      });
      result.added++;
    }
    claimed.add(id);
    if (mapping.get(spec.key) !== String(id)) db.setCoreMemory(opts.owner, spec.key, String(id));
    mapping.delete(spec.key);
  }

  // Whatever a current definition did not claim is earlier seed text: retire it.
  for (const note of active) {
    if (claimed.has(note.id)) continue;
    if (db.deleteNote(note.id, opts.author)) result.retired++;
  }
  for (const [key, value] of mapping) {
    if (!value.startsWith(RETIRED_PREFIX))
      db.setCoreMemory(opts.owner, key, `${RETIRED_PREFIX}${value}`);
  }
  return result;
}

/**
 * Seed the `guide` memory pool with the platform notes plus the world's own.
 *
 * Re-seeding reconciles rather than appends. Every seeded note has a stable
 * key (`guideNoteKey`); when a key's text changes, the new text is added and
 * the old note is retired, and a `Guide`-authored note no current definition
 * claims (an edited or removed note from an earlier release, or another
 * world's notes in a reused database) is retired too. Retirement is
 * `note delete`'s canonical path: the record history keeps the old text and
 * nothing is hard-deleted; key → note changes are kept in core-memory history
 * under `GUIDE_SEED_OWNER`. Notes other authors added to the pool are never
 * touched.
 */
export function seedGuidePool(
  db: MarinaDB,
  notes: GuideNote[],
  opts: { commands?: readonly CommandRequirement[] } = {},
): GuideSeedResult {
  const empty: GuideSeedResult = { added: 0, kept: 0, retired: 0 };
  // Platform notes are always merged in front of the world's own notes, so the
  // self-improvement loop is discoverable in every world — even one that
  // declares no guide notes of its own.
  const all = [...PLATFORM_GUIDE_NOTES, ...notes];

  let pool = db.getMemoryPool(POOL_NAME);
  if (!pool) {
    if (all.length === 0) return empty;
    const id = `pool_${POOL_NAME}_${Date.now()}`;
    db.createMemoryPool(id, POOL_NAME, AUTHOR);
    pool = db.getMemoryPool(POOL_NAME);
  }
  if (!pool) return empty;

  // The guide pool's durable twin: an institutional, world-readable memory
  // space owned by the `guide` system principal. Ratified guide notes and
  // adopted proposals land here (Phase 3.4). Idempotent by pool name; failure
  // must never block the legacy seed the world depends on.
  tryLog(new Logger(), "seed", "Institutional guide space unavailable", () => {
    ensureInstitutionalSpace(db, POOL_NAME);
  });

  const seenKeys = new Map<string, number>();
  const specs = all.map((note) => {
    const base = guideNoteKey(note);
    const count = (seenKeys.get(base) ?? 0) + 1;
    seenKeys.set(base, count);
    return {
      key: count === 1 ? base : `${base}~${count}`,
      content: renderGuideNote(note, opts.commands),
      importance: note.importance,
      type: note.type,
    };
  });
  const result = reconcileSeedNotes(db, {
    poolId: pool.id,
    author: AUTHOR,
    owner: GUIDE_SEED_OWNER,
    notes: specs,
  });
  if (result.retired > 0) {
    new Logger().info(
      "seed",
      `Guide pool: retired ${result.retired} earlier seed note(s), added ${result.added}`,
    );
  }
  return result;
}
