// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Outcome learning: whenever something Marina did gets a verdict — a benchmark
 * run scored, a forecast resolved, a code verification passed or failed, an
 * arena round scored — the outcome becomes a CANDIDATE lesson, the decision
 * layer scores the candidate, and only a candidate that passes is served as a
 * lesson. Successes teach as much as failures.
 *
 *   outcome ──► candidate (mechanical summary + writer rule; no rule ⇒ deferred, never judged)
 *           ──► judge (noul questions: grounded, general, leak-free, consistent)
 *           ──► trusted    → lesson record, served by recall
 *               contested  → trusted but held (failed only `consistent`): resolve case
 *               unverified → lesson record, never served (no judge: decisions off/outage)
 *               rejected   → audit record, never served
 *
 * Nothing here stores a benchmark's question or answer text: the candidate is
 * built from the outcome's own general fields, the writer is told not to
 * restate the case, and a mechanical check (`leaksCase`, `itemLeak`) rejects
 * any lesson that quotes the case text it was shown or names an item's id,
 * question or answer — before a judge reads it. A rejected lesson that failed
 * that check is stored with its text withheld. Recall applies the leakage rule `visibleAt` (a
 * lesson resolved at T is invisible to work whose cutoff precedes T).
 */

import type { DecisionProvider, DecisionQuestions, NoulAnswer } from "../decisions/types";
import { rankSortKey } from "../memory/admission-policy";
import { EVAL_REF_PREFIX } from "./eval-context";
import { type CaseGuard, itemLeak } from "./leak-guard";

/**
 * Where a lesson is pooled. All except `meta` are producers (where an outcome came
 * from); `meta` is the cross-board pool: trusted, transferable lessons about a
 * method, a configuration, a budget, calibration, retrieval, infrastructure or
 * model behaviour, mirrored from their producer domain so every surface that
 * does that kind of work recalls them.
 */
export type OutcomeDomain =
  | "forecast"
  | "code"
  | "tools"
  | "benchmark"
  | "arena"
  | "research"
  | "meta";

/** Domains an outcome can come from (every domain except the `meta` mirror). */
export const PRODUCER_DOMAINS: readonly OutcomeDomain[] = [
  "forecast",
  "code",
  "tools",
  "benchmark",
  "arena",
  "research",
];

export const OUTCOME_DOMAINS: readonly OutcomeDomain[] = [...PRODUCER_DOMAINS, "meta"];

/**
 * What a lesson is ABOUT (where it came from is provenance, not the address).
 * `case` lessons stay with their producer; every other scope may be mirrored
 * into `lessons:meta` when the judge trusts it and finds it transferable.
 */
export type LessonScope =
  | "case"
  | "method"
  | "config"
  | "budget"
  | "calibration"
  | "retrieval"
  | "infra"
  | "model";

export const LESSON_SCOPES: readonly LessonScope[] = [
  "case",
  "method",
  "config",
  "budget",
  "calibration",
  "retrieval",
  "infra",
  "model",
];

/** The scope a producer's lesson has when no writer names one. */
export function defaultScope(domain: OutcomeDomain): LessonScope {
  switch (domain) {
    case "benchmark":
      return "config";
    case "code":
    case "tools":
      return "method";
    default:
      return "case";
  }
}

/** At most this many family tags and subjects ride one lesson. */
export const MAX_FAMILIES = 3;
export const MAX_SUBJECTS = 6;

export interface Outcome {
  domain: OutcomeDomain;
  /** Short machine label of the producer, e.g. `benchmark:hle-verified-gold`, `code:verify`. */
  source: string;
  /** Whether the attempt succeeded (a hit, a pass, a beat-the-baseline). */
  succeeded: boolean;
  /** 0–1 when the verdict is graded. */
  score?: number;
  /** ISO time the verdict became known; lessons are invisible before it. */
  resolvedAt: string;
  /**
   * What was attempted, in GENERAL terms (a category, a method, a tool) —
   * never a benchmark question or answer verbatim.
   */
  attempted: string;
  /** Evidence, tools or settings that mattered (short phrases). */
  signals?: string[];
  /**
   * How the outcome was measured (trace coverage, provenance grades) — context
   * for the judge, never the finding a rule is about.
   */
  measurement?: string[];
  /**
   * The producer's own general rule for this outcome (method, configuration,
   * model choice; aggregate numbers as evidence only). The writer starts from
   * it; it is the lesson's rule when no writer answers or the writer's rule
   * fails the item check.
   */
  rule?: string;
  /** The mechanical failure mode, or a short success factor. */
  detail?: string;
  /** Pointers to the evidence: `trace:…`, `note:N`, `task:N`, `artifact:…`, `bench:…`. */
  refs?: string[];
  /** What the lesson will be about, when the producer knows (else `defaultScope`). */
  scope?: LessonScope;
  /** Task-family tags from the declared vocabulary (`src/learning/families.json`). */
  families?: string[];
  /** Model classes and formations a `config` or `model` lesson is about. */
  subjects?: string[];
  /**
   * Case text the writer may see for context (a question, an error excerpt)
   * but which must never appear in the lesson. Used by the leak check; never
   * stored.
   */
  privateContext?: string;
  /**
   * Fingerprints of the outcome's ITEMS (ids, hashed text shingles, hashed
   * answers) for the mechanical item check. Never shown to a model, never stored.
   */
  caseGuard?: CaseGuard;
  /** Stored on the lesson's provenance (e.g. `learner`, the writer version). */
  provenance?: Record<string, string>;
  /**
   * A measurement outcome (`eval_mode = measure`): the judge's `leak_free`
   * bar is enforced for it (see `leakFreeEnforced`).
   */
  measured?: boolean;
  /**
   * The outcome summarises this many single outcomes of one kind (a batch of
   * forecast rounds or research asks): the writer gets the aggregate prompt.
   */
  aggregateOf?: number;
  /**
   * The family or tracker the outcome's work belongs to (`family:<x>`), when
   * the lesson is scoped to it: judged general within it, served only to work
   * of that family (`selectServed`).
   */
  scopeFamily?: string;
}

/**
 * Whether the judge's `leak_free` answer is an enforced bar for `o`: only for
 * measurement — a benchmark outcome, an `eval_mode = measure` outcome, or one
 * naming the board it measured (`eval:<board>`). For live outcomes it is
 * recorded but advisory. The mechanical item check (`itemLeak`) is the hard
 * gate everywhere, before any judge.
 */
export function leakFreeEnforced(
  o: Pick<Outcome, "domain" | "source" | "refs" | "measured">,
): boolean {
  return (
    o.measured === true ||
    o.domain === "benchmark" ||
    o.source.startsWith("benchmark:") ||
    (o.refs ?? []).some((r) => r.startsWith(EVAL_REF_PREFIX))
  );
}

export type LessonTrust = "trusted" | "unverified" | "rejected";

export interface Lesson {
  id?: string;
  domain: OutcomeDomain;
  /** One terse line, the part a reader sees. */
  text: string;
  kind: "success" | "failure";
  category?: string;
  rule?: string;
  score?: number;
  trust: LessonTrust;
  /** The judge's numbers, when one answered. */
  judgement?: Record<string, number>;
  /** Which judge decided, e.g. `typesafe/jev-1.13` or `lesson-judge:marina/default (uncalibrated)`. */
  judge?: string;
  resolvedAt: string;
  source: string;
  refs?: string[];
  scope?: LessonScope;
  families?: string[];
  subjects?: string[];
  /** Served only to work of this family or tracker (see `Outcome.scopeFamily`). */
  scopeFamily?: string;
  /**
   * Where a lesson came from when it was not learned by this loop — a record
   * migrated from an earlier store (`store`, `account`, `space`, `id`,
   * `version`), or a `meta` mirror (`promoted_from: <domain>/<id>`). Stored as
   * metadata, never served to a model.
   */
  provenance?: Record<string, string>;
  /** The record version the store read it at (stores fill it; never written). */
  version?: number;
  /** Independent supports: 1 when written, +1 per admission merge. */
  support?: number;
  /** Provenance of the duplicates merged into it (newest last, capped). */
  merged?: LessonMergeEntry[];
  /** Admission rank (`src/memory/admission.ts` `StoredRank`), stored with the record. */
  rank?: LessonRank;
  /** What admission did (on) or proposed (observe) for this write. */
  admission?: LessonAdmissionStamp;
  /**
   * Held unserved: the lesson contradicts a trusted lesson that is still
   * current (an open resolve case). Stores compute it on read; never written.
   */
  contested?: boolean;
  /**
   * Set only on a lesson whose validity has ended (`findRetired`): the
   * retirement recorded with it — operator curation, supersession, a resolve
   * loser, or an invalidated run. Stores compute it on read; never written.
   */
  retired?: LessonRetirement & { at?: string };
}

/** One duplicate merged into a lesson at admission. */
export interface LessonMergeEntry {
  source: string;
  resolved_at: string;
  trust: LessonTrust;
  judge?: string;
  refs?: string[];
}

/** The stored rank (opaque here; `StoredRank` in `src/memory/admission.ts`). */
export interface LessonRank {
  score: number;
  [key: string]: unknown;
}

/** Admission's record on a lesson. */
export interface LessonAdmissionStamp {
  mode: "observe" | "on";
  /** The action: applied under `on`, only proposed under `observe`. */
  action: "new" | "merge" | "supersede" | "contest";
  applied: boolean;
  /** The neighbour the action targets. */
  target?: string;
  reason: string;
  mechanical?: boolean;
  similarity?: number;
  /** The judge's relation pick (`refines_N2 p0.8`). */
  relation?: string;
  /** `contested`: held unserved while a lesson in `contests` is current. */
  state?: "contested";
  contests?: string[];
  /** The resolve case opened for a contradiction (`memory_resolutions` id). */
  case?: string;
  /** Why the write was not ranked (it proceeded as off would). */
  skipped?: string;
}

export interface LessonWriter {
  name: string;
  complete: (system: string, user: string) => Promise<string>;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const WRITER_REPLY = [
  'Reply with ONE JSON object: {"category": "<2-5 words: domain + kind of work>",',
  '"rule": "<one sentence under 35 words that applies to SIMILAR future work>",',
  `"scope": "<what the rule is about: one of ${LESSON_SCOPES.join("|")}>"}.`,
].join(" ");

/** For a single case (a forecast, a code check): nothing specific to the case survives. */
const WRITER_SYSTEM_CASE = [
  "You turn one outcome into one terse, reusable lesson for an AI agent. No pleasantries.",
  WRITER_REPLY,
  "The rule generalizes: a method, a source to check, a failure to avoid, a setting that worked.",
  "Never restate the specific case, its question, its answer, names, numbers or quotes from it.",
].join(" ");

/**
 * For an aggregate outcome (a whole run, a configuration compared with
 * another): the rule is about method, configuration or model choice.
 */
const WRITER_SYSTEM_AGGREGATE = [
  "You turn one aggregate outcome (a whole evaluation run compared with the best other configuration",
  "on the same items, or a batch of outcomes of the same kind) into one terse, reusable lesson for",
  "an AI agent. No pleasantries.",
  WRITER_REPLY,
  "The rule is about METHOD, CONFIGURATION or MODEL CHOICE: what worked or failed, and under",
  "what conditions (the kind of work), e.g. 'On multi-hop retrieval questions, a strong lead model",
  "reading whole documents beats a single cheap agent.' Name models, formations and settings;",
  "you may cite aggregate scores, sample sizes or costs as evidence strength.",
  "Never include item ids, question text, answers or details of any single item.",
  "Measurement notes say how the run was recorded; they are not the finding, so never make them the rule.",
  "When the outcome has no comparable baseline, say what the result does and does not show.",
].join(" ");

/** Scopes whose lessons come from aggregate outcomes, not a single case. */
const AGGREGATE_SCOPES = new Set<LessonScope>(["config", "model", "budget", "calibration"]);

/** The lesson text: header, then the rule when there is one, then the evidence. */
function mechanicalText(o: Outcome, category?: string, rule?: string): string {
  return [
    `[lesson:${o.domain}] ${o.succeeded ? "success" : "failure"}${category ? ` · ${category}` : ""}`,
    rule ? `rule: ${rule}` : "",
    o.score !== undefined ? `score ${o.score.toFixed(2)}` : "",
    o.detail ? clip(o.detail, 120) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The text the writer was shown about the outcome (its general fields): never an item leak. */
function outcomeVocabulary(o: Outcome): string {
  return [o.attempted, o.detail, o.rule, ...(o.signals ?? []), ...(o.subjects ?? [])]
    .filter(Boolean)
    .join(" ");
}

/** Why `text` fails the mechanical case/item check for `o`, or undefined. */
export function mechanicalLeak(text: string, o: Outcome): string | undefined {
  if (leaksCase({ text }, o.privateContext)) return "quotes the case text";
  return itemLeak(text, o.caseGuard, outcomeVocabulary(o));
}

/** One writer answer: a category, rule and scope, or why there is none. */
async function askWriter(
  o: Outcome,
  writer: LessonWriter,
  scope: LessonScope,
): Promise<{ category?: string; rule?: string; scope?: LessonScope; missing?: string }> {
  try {
    const raw = await writer.complete(
      o.aggregateOf || AGGREGATE_SCOPES.has(scope) ? WRITER_SYSTEM_AGGREGATE : WRITER_SYSTEM_CASE,
      [
        `Domain: ${o.domain} (${o.source})`,
        `Attempted: ${clip(o.attempted, 400)}`,
        `Result: ${o.succeeded ? "success" : "failure"}${o.score !== undefined ? ` (score ${o.score.toFixed(2)})` : ""}`,
        o.detail ? `Detail: ${clip(o.detail, 300)}` : "",
        o.signals?.length ? `Signals: ${clip(o.signals.join("; "), 400)}` : "",
        o.measurement?.length
          ? `Measurement notes (not a finding): ${clip(o.measurement.join("; "), 300)}`
          : "",
        o.rule ? `Draft rule (improve it; keep it general): ${clip(o.rule, 300)}` : "",
        o.privateContext ? `Context (do not quote): ${clip(o.privateContext, 800)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { missing: "writer returned no JSON" };
    const parsed = JSON.parse(m[0]) as { category?: unknown; rule?: unknown; scope?: unknown };
    const named = typeof parsed.scope === "string" ? parsed.scope.trim().toLowerCase() : "";
    const rule = typeof parsed.rule === "string" ? clip(parsed.rule.trim(), 220) : "";
    return {
      ...(typeof parsed.category === "string"
        ? { category: clip(parsed.category.trim(), 48) }
        : {}),
      ...(rule ? { rule } : { missing: "writer returned no rule" }),
      ...(LESSON_SCOPES.includes(named as LessonScope) ? { scope: named as LessonScope } : {}),
    };
  } catch (err) {
    return { missing: `writer unavailable: ${clip(String((err as Error)?.message ?? err), 80)}` };
  }
}

/**
 * A candidate lesson from one outcome: the mechanical part, and a category and
 * rule from `writer`. A writer that fails, returns no JSON or no rule is asked
 * once more; the producer's own rule stands in when it still gives none. A
 * candidate that ends with no rule carries `provenance.no_rule` (why) and is
 * never judged or stored (`recordOutcome` defers it).
 */
export async function candidateFromOutcome(o: Outcome, writer?: LessonWriter): Promise<Lesson> {
  let category: string | undefined;
  let rule: string | undefined;
  let scope: LessonScope = o.scope ?? defaultScope(o.domain);
  let writerNote: string | undefined;
  let missing: string | undefined = writer ? undefined : "no writer";
  if (writer) {
    // A second ask only when nothing else would give the lesson a rule.
    for (let attempt = 0; attempt < (o.rule ? 1 : 2); attempt++) {
      const answer = await askWriter(o, writer, scope);
      missing = answer.missing;
      if (answer.scope) scope = answer.scope;
      if (answer.category) category = answer.category;
      if (!answer.rule) continue;
      rule = answer.rule;
      break;
    }
    // A writer's rule or category that carries item content is discarded (and
    // never stored): the producer's own rule stands in for it.
    const leak =
      rule || category ? mechanicalLeak(`${category ?? ""} ${rule ?? ""}`, o) : undefined;
    if (leak) {
      writerNote = `writer rule discarded: ${leak}`;
      missing = writerNote;
      rule = undefined;
      category = undefined;
    }
  }
  rule ??= o.rule ? clip(o.rule, 260) : undefined;
  const provenance = {
    ...(o.provenance ?? {}),
    ...(writer ? { writer: writer.name } : {}),
    ...(writerNote ? { writer_note: writerNote } : {}),
    ...(rule ? {} : { no_rule: missing ?? "no rule" }),
  };
  return {
    domain: o.domain,
    text: mechanicalText(o, category, rule),
    kind: o.succeeded ? "success" : "failure",
    ...(category ? { category } : {}),
    ...(rule ? { rule } : {}),
    ...(o.score !== undefined ? { score: o.score } : {}),
    trust: "unverified",
    resolvedAt: o.resolvedAt,
    source: o.source,
    ...(o.refs?.length ? { refs: o.refs.slice(0, 8) } : {}),
    scope,
    ...(o.families?.length ? { families: o.families.slice(0, MAX_FAMILIES) } : {}),
    ...(o.subjects?.length ? { subjects: o.subjects.slice(0, MAX_SUBJECTS) } : {}),
    ...(o.scopeFamily ? { scopeFamily: o.scopeFamily } : {}),
    ...(Object.keys(provenance).length ? { provenance } : {}),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Mechanical leak check: the lesson must not quote the case text the writer
 * saw. Any 6-word run (or a 40-character run) of the private context that
 * appears in the lesson text is a leak.
 */
export function leaksCase(lesson: Pick<Lesson, "text">, privateContext?: string): boolean {
  if (!privateContext) return false;
  const text = norm(lesson.text);
  const ctx = norm(privateContext);
  if (ctx.length >= 40) {
    for (let i = 0; i + 40 <= ctx.length; i += 20) {
      if (text.includes(ctx.slice(i, i + 40))) return true;
    }
  }
  const words = ctx.split(" ").filter(Boolean);
  for (let i = 0; i + 6 <= words.length; i++) {
    if (text.includes(words.slice(i, i + 6).join(" "))) return true;
  }
  return false;
}

export const LESSON_JUDGE_QUESTIONS: DecisionQuestions = {
  grounded: {
    type: "noul",
    instructions:
      "Is the lesson supported by the outcome it was written from (the result, detail and signals)? Any numbers it cites must match the outcome.",
    criteria: {
      true: "The lesson follows from the stated outcome and evidence.",
      false: "The lesson claims something the outcome does not show.",
    },
  },
  general: {
    type: "noul",
    instructions:
      "Would the lesson help on DIFFERENT but similar future work WITHIN its declared scope (`applies_to`: the source shape and, when named, the family or tracker it was learned on) — other questions, rounds or tasks of that kind — rather than only this one case? A rule that holds across its declared scope is general even if it would not hold for all work. A rule that restates one case's or one round's numbers is not.",
    criteria: {
      true: "A reusable method, check, source, pitfall, setting, or a configuration or model choice that holds across the declared scope.",
      false: "A one-off fact or one case's or round's numbers restated, or too vague to act on.",
    },
  },
  leak_free: {
    type: "noul",
    instructions:
      "Is the lesson free of benchmark ITEM content — any question text, answer, item id or instance-specific detail (a name, date, quantity or quote from one particular question or task) that would let a future run memorise answers? Aggregate scores, percentages, sample sizes, costs, model names, formations and configuration descriptions are NOT item content.",
    criteria: {
      true: "No item's question, answer, id or instance detail; at most aggregate results and configuration.",
      false: "It reveals or restates an item's question, answer, id or instance-specific details.",
    },
  },
  consistent: {
    type: "noul",
    instructions:
      "Is the lesson consistent with the existing trusted lessons shown (it may refine them, not contradict them without evidence)?",
    criteria: {
      true: "Consistent, or no relevant existing lessons.",
      false: "Contradicts higher-trust lessons without new evidence.",
    },
  },
  transferable: {
    type: "noul",
    instructions:
      "Would this lesson hold for a DIFFERENT task family or board than the one it came from?",
    criteria: {
      true: "A method, configuration, budget or calibration finding that carries to other kinds of work.",
      false: "It holds only for this board, this task family or this case.",
    },
  },
};

/**
 * The bars every lesson judge must clear, calibrated or not: one set, so the
 * same lesson gets the same verdict whichever engine answered (an uncalibrated
 * judge no longer gets a single 0.5 cut; its verdicts stay labelled
 * `(uncalibrated)`). `leak_free` is enforced only for measurement outcomes
 * (`leakFreeEnforced`); failing only `consistent` stores the lesson contested.
 */
export const LESSON_JUDGE_POLICY = {
  grounded: 0.6,
  general: 0.55,
  leak_free: 0.7,
  consistent: 0.5,
} as const;

/**
 * The `transferable` bar (every judge). It never decides trust: only whether a
 * trusted lesson is mirrored into `lessons:meta`.
 */
export const TRANSFERABLE_BAR = 0.6;

export interface LessonVerdict {
  trust: LessonTrust;
  reason: string;
  judgement?: Record<string, number>;
  /** The judge that answered, labelled `(uncalibrated)` when the engine is not calibrated. */
  judge?: string;
  /**
   * Trusted, but it failed only `consistent` against the existing lesson
   * `contests`: stored held (contested) with a resolve case, never served
   * while that lesson is current.
   */
  contests?: string;
  /** The judge found the lesson transferable to other task families (its own bar). */
  transferable?: boolean;
  costUsd?: number;
  /** Rejected by the mechanical case/item check (no judge asked; the text is withheld). */
  leak?: boolean;
}

/**
 * Score a candidate with the decision layer. No provider (decisions off) or an
 * outage ⇒ `unverified` — the conservative fallback never promotes to trusted.
 * A mechanical leak (case text, an item's id, question or answer) is rejected
 * before the judge is asked.
 */
export async function judgeLesson(
  candidate: Lesson,
  outcome: Outcome,
  provider: DecisionProvider | undefined,
  existing: Lesson[] = [],
): Promise<LessonVerdict> {
  const leak = mechanicalLeak(candidate.text, outcome);
  if (leak) return { trust: "rejected", reason: leak, leak: true };
  if (!provider) return { trust: "unverified", reason: "no decision backend" };
  try {
    const result = await provider.ask({
      state: {
        outcome: {
          domain: outcome.domain,
          source: outcome.source,
          result: outcome.succeeded ? "success" : "failure",
          ...(outcome.score !== undefined ? { score: outcome.score } : {}),
          attempted: clip(outcome.attempted, 400),
          ...(outcome.detail ? { detail: clip(outcome.detail, 300) } : {}),
          ...(outcome.signals?.length ? { signals: outcome.signals.slice(0, 8) } : {}),
          ...(outcome.measurement?.length ? { measurement: outcome.measurement.slice(0, 4) } : {}),
        },
        // The lesson is its rule and scope; per-case numbers reach the judge
        // only as outcome detail above, never as part of the lesson.
        lesson: candidate.rule ? `rule: ${candidate.rule}` : candidate.text,
        ...(candidate.scope ? { scope: candidate.scope } : {}),
        ...(candidate.families?.length ? { families: candidate.families } : {}),
        // What `general` is judged within: the source shape and declared family.
        applies_to: {
          source: outcome.source,
          ...(candidate.scopeFamily ? { family: candidate.scopeFamily } : {}),
        },
        existing_lessons: existing.slice(0, 5).map((l) => (l.rule ? `rule: ${l.rule}` : l.text)),
      },
      questions: LESSON_JUDGE_QUESTIONS,
    });
    const judgement: Record<string, number> = {};
    for (const [k, a] of Object.entries(result.answers)) {
      if (a.type === "noul") judgement[k] = (a as NoulAnswer).noul;
    }
    // One set of bars for every judge; what answered only labels the verdict
    // (a composite engine is uncalibrated when an uncalibrated opinion joined in).
    const calibrated = (result.calibrated ?? provider.calibrated) !== false;
    const below = (k: keyof typeof LESSON_JUDGE_POLICY) =>
      judgement[k] === undefined || judgement[k]! < LESSON_JUDGE_POLICY[k];
    const show = (k: string) => `${k} ${(judgement[k] ?? 0).toFixed(2)}`;
    const enforced = leakFreeEnforced(outcome);
    const notes: string[] = [];
    const failed = (Object.keys(LESSON_JUDGE_POLICY) as Array<keyof typeof LESSON_JUDGE_POLICY>)
      .filter(below)
      .filter((k) => {
        // Live outcomes: leak_free is recorded, not a bar (itemLeak ran above).
        if (k === "leak_free" && !enforced) {
          notes.push(`advisory ${show(k)}`);
          return false;
        }
        // Nothing shown to contradict: consistency is not in question.
        if (k === "consistent" && existing.length === 0) {
          notes.push(`no existing lesson (${show(k)})`);
          return false;
        }
        return true;
      })
      .map(show);
    const judge = `${result.model || provider.model}${calibrated ? "" : " (uncalibrated)"}`;
    const transferable =
      judgement.transferable !== undefined && judgement.transferable >= TRANSFERABLE_BAR;
    // Failing only `consistent` is a contradiction to resolve, not a rejection.
    const contests =
      failed.length === 1 && failed[0]!.startsWith("consistent ")
        ? existing.find((l) => l.id)?.id
        : undefined;
    const note = notes.length ? `; ${notes.join(", ")}` : "";
    return {
      trust: failed.length && !contests ? "rejected" : "trusted",
      transferable,
      reason: contests
        ? `contested: ${failed[0]} against ${contests}${note}`
        : failed.length
          ? `below bar: ${failed.join(", ")}${note}`
          : `passed${note}`,
      judgement,
      judge,
      ...(contests ? { contests } : {}),
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    };
  } catch {
    return { trust: "unverified", reason: "decision backend unavailable" };
  }
}

// ─── Storage and recall ──────────────────────────────────────────────────────

/** Why and by whom a lesson was retired. Recorded on the lesson's history; never erased. */
export interface LessonRetirement {
  reason: string;
  /** Opaque durable account key of the curator (never a display name). */
  by: string;
  /** The replacement lesson's id when the retirement is a supersession. */
  supersededBy?: string;
}

/** Which current lessons a curation command addresses. Every given field must match. */
export interface LessonSelector {
  /** A full lesson id, or a prefix of at least 8 characters (as `lessons` displays). */
  id?: string;
  /** Exact `source` (e.g. a run or round id). */
  source?: string;
  /** Case-insensitive substring of the lesson text or category. */
  match?: string;
  /** An exact evidence ref the lesson cites (e.g. `bench:<run id>`). */
  ref?: string;
}

export const MIN_LESSON_ID_PREFIX = 8;

export function lessonMatches(l: Lesson, sel: LessonSelector): boolean {
  if (sel.id !== undefined) {
    if (!l.id) return false;
    if (l.id !== sel.id && !(sel.id.length >= MIN_LESSON_ID_PREFIX && l.id.startsWith(sel.id)))
      return false;
  }
  if (sel.source !== undefined && l.source !== sel.source) return false;
  if (sel.match !== undefined) {
    const needle = sel.match.toLowerCase();
    if (!`${l.text}\n${l.category ?? ""}`.toLowerCase().includes(needle)) return false;
  }
  if (sel.ref !== undefined && !(l.refs ?? []).includes(sel.ref)) return false;
  return true;
}

/** How a recall selects: budget, and lessons the work must not see. */
export interface LessonRecallOptions {
  limit?: number;
  maxBytes?: number;
  /**
   * Lessons this work must not see beyond the time rule — e.g. a measurement
   * run's self-exclusion (`evalExclusion`). Applied before the budget.
   */
  exclude?: (lesson: Lesson) => boolean;
  /**
   * Family tags of the work. A store may add lessons tagged with any of them
   * when the lexical match is thin (a key match, no embeddings needed).
   */
  families?: readonly string[];
  /**
   * Ranked serving (`MARINA_MEMORY_RANKING=on`): order by trust, then admission
   * rank (records below the floor last), then recency.
   */
  rankOrder?: boolean;
}

/** Neighbours of a candidate in one domain's pool (for admission). */
export interface LessonNeighbours {
  lessons: Lesson[];
  generation?: number;
  mode: "lexical" | "hybrid";
  degraded: string[];
}

export interface LessonSink {
  /**
   * Persist a lesson (trusted / unverified served; rejected kept as audit only).
   * `key` makes the write idempotent: the same key and lesson write once.
   */
  write(lesson: Lesson, opts?: { key?: string }): Promise<{ id?: string }>;
  /**
   * Served lessons of `domain` known at `asOf` matching `query`, newest first,
   * byte-budgeted. A retired lesson (validity closed) is never served.
   */
  recall(
    domain: OutcomeDomain,
    query: string,
    asOf: string,
    opts?: LessonRecallOptions,
  ): Promise<Lesson[]>;
  /** Current (not retired) lessons of `domain` matching `selector`, any trust — for curation. */
  find?(domain: OutcomeDomain, selector: LessonSelector, limit: number): Promise<Lesson[]>;
  /**
   * Retired lessons of `domain` matching `selector` (latest version, validity
   * ended), each with `retired` filled — so a pass can tell a decided lesson
   * from one never learned (the backfill never re-learns a retired run).
   */
  findRetired?(domain: OutcomeDomain, selector: LessonSelector, limit: number): Promise<Lesson[]>;
  /**
   * Retire one current lesson: a new version with validity closed and the
   * retirement in its metadata. Recall stops serving it; its history stays readable.
   */
  retire?(domain: OutcomeDomain, id: string, retirement: LessonRetirement): Promise<void>;
  /**
   * Current lessons of `domain` nearest `text` (any trust), nearest first —
   * the admission neighbour search. `hybrid` asks for hybrid search when the
   * store has embeddings (falling back to lexical, labelled).
   */
  neighbours?(
    domain: OutcomeDomain,
    text: string,
    opts: { limit: number; hybrid?: boolean },
  ): Promise<LessonNeighbours>;
  /**
   * Revise one current lesson's metadata (a merge: support, refs, merged
   * provenance). The text, validity and `resolvedAt` are kept.
   */
  update?(domain: OutcomeDomain, id: string, change: (l: Lesson) => Lesson): Promise<void>;
  /**
   * Open a resolve case between `id` (the new, held lesson) and `against` (the
   * trusted lesson it contradicts). `autoResolve` closes `against` at once with
   * an audit row (a calibrated judge with an evidence gap). Returns the case id.
   */
  contest?(
    domain: OutcomeDomain,
    id: string,
    against: string,
    opts: { autoResolve: boolean; rationale: string },
  ): Promise<{ caseId?: string; resolved: boolean }>;
}

/** The leakage rule: a lesson exists for work only once its outcome was known. */
export function visibleAt(lesson: Pick<Lesson, "resolvedAt">, asOf: string): boolean {
  const r = Date.parse(lesson.resolvedAt);
  const a = Date.parse(asOf);
  return Number.isFinite(r) && Number.isFinite(a) && r <= a;
}

export const DEFAULT_RECALL_LIMIT = 5;
export const DEFAULT_RECALL_BYTES = 1_200;

/** A curator's replacement (`supersedeLesson`): a person's text, served unjudged. */
export const CURATED_SOURCE_PREFIX = "supersede:";

/**
 * Whether a lesson may be served at all: it has a rule, and a judge trusted it
 * (or a curator wrote it). Never-judged (`unverified`) lessons — migrated
 * records, outage-era writes — stay stored but are never served, and a record
 * without a rule (a bare mechanical restatement) is never served whatever its trust.
 */
export function servableLesson(l: Pick<Lesson, "trust" | "rule" | "source">): boolean {
  if (!l.rule?.trim()) return false;
  return (
    l.trust === "trusted" ||
    (l.trust === "unverified" && l.source.startsWith(CURATED_SOURCE_PREFIX))
  );
}

/**
 * Served, visible lessons (`servableLesson`; a family-scoped lesson only when
 * `opts.families` names its family): trusted first, then (ranked
 * serving only) by admission rank with records below the floor last, then
 * newest; trimmed to the byte budget. `exclude` drops lessons the work must
 * not see (self-exclusion); a contested lesson is never served; the leakage
 * rule `visibleAt` always applies.
 */
export function selectServed(
  candidates: Lesson[],
  asOf: string,
  opts: LessonRecallOptions = {},
): Lesson[] {
  const limit = opts.limit ?? DEFAULT_RECALL_LIMIT;
  const budget = opts.maxBytes ?? DEFAULT_RECALL_BYTES;
  const exclude = opts.exclude;
  const families = new Set(opts.families ?? []);
  const served = candidates
    .filter(servableLesson)
    // A family-scoped lesson reaches only work that names that family.
    .filter((l) => !l.scopeFamily || families.has(l.scopeFamily))
    .filter((l) => visibleAt(l, asOf))
    .filter((l) => !l.contested)
    .filter((l) => !exclude?.(l))
    .sort(
      (a, b) =>
        (a.trust === "trusted" ? 0 : 1) - (b.trust === "trusted" ? 0 : 1) ||
        (opts.rankOrder ? rankSortKey(a.rank?.score) - rankSortKey(b.rank?.score) : 0) ||
        Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt),
    );
  const out: Lesson[] = [];
  let bytes = 0;
  for (const l of served) {
    const n = Buffer.byteLength(l.text);
    if (out.length >= limit || bytes + n > budget) break;
    out.push(l);
    bytes += n;
  }
  return out;
}

/**
 * How a recalled lesson is shown to a model: labelled by trust, and a `meta`
 * lesson labelled as learned on other work (`cross-board <scope>`).
 */
export function formatLesson(l: Lesson): string {
  const tags: string[] = [];
  if (l.domain === "meta") tags.push(`cross-board ${l.scope ?? "lesson"}`);
  if (l.trust !== "trusted") tags.push("unverified");
  return tags.length ? `${l.text} (${tags.join(", ")})` : l.text;
}

/**
 * The `meta` mirror of a judged lesson: same text, judgement, judge and
 * `resolvedAt` (so the leakage rule is unchanged), refs gaining the original
 * (`lesson:<id>`, which is how retiring the original retires the mirror), and
 * `promoted_from` provenance. Undefined when the lesson does not qualify: only
 * a TRUSTED, non-`case` lesson the judge found transferable is mirrored.
 */
export function metaMirror(
  lesson: Lesson,
  originalId: string,
  verdict: Pick<LessonVerdict, "trust" | "transferable">,
): Lesson | undefined {
  if (lesson.domain === "meta" || verdict.trust !== "trusted" || !verdict.transferable)
    return undefined;
  if (!lesson.scope || lesson.scope === "case") return undefined;
  // The mirror is a new record: admission ranks it on its own.
  const {
    id: _id,
    provenance: _p,
    version: _v,
    rank: _r,
    admission: _a,
    support: _s,
    merged: _m,
    contested: _c,
    ...rest
  } = lesson;
  return {
    ...rest,
    domain: "meta",
    refs: [`lesson:${originalId}`, ...(lesson.refs ?? [])].slice(0, 9),
    provenance: { promoted_from: `${lesson.domain}/${originalId}` },
  };
}

const TOKEN = /[a-z0-9]{3,}/g;
const STOP = new Set([
  "the",
  "and",
  "will",
  "for",
  "what",
  "which",
  "who",
  "with",
  "this",
  "that",
  "from",
  "are",
  "was",
  "how",
  "lesson",
  "success",
  "failure",
  "score",
  "rule",
]);
export const lessonTokens = (s: string) =>
  new Set([...(s.toLowerCase().match(TOKEN) ?? [])].filter((t) => !STOP.has(t)));

/** In-process sink for tests and one-off runs: token overlap, then `selectServed`. */
export function memoryLessonSink(initial: Lesson[] = []): LessonSink & {
  all(): Lesson[];
  retirements(): Map<string, LessonRetirement>;
  cases(): Array<{ id: string; against: string; resolved: boolean; rationale: string }>;
} {
  const lessons = [...initial];
  const retired = new Map<string, LessonRetirement>();
  const keyed = new Map<string, string>();
  const cases: Array<{ id: string; against: string; resolved: boolean; rationale: string }> = [];
  const current = (l: Lesson) => !(l.id && retired.has(l.id));
  // A contested lesson is held only while a lesson it contests is current.
  const view = (l: Lesson): Lesson => {
    if (l.admission?.state !== "contested") return l;
    const held = (l.admission.contests ?? []).some((id) => !retired.has(id));
    return { ...l, contested: held };
  };
  const overlap = (l: Lesson, q: Set<string>) =>
    [...lessonTokens(`${l.text} ${l.category ?? ""}`)].filter((t) => q.has(t)).length;
  return {
    all: () => lessons.map(view),
    retirements: () => new Map(retired),
    cases: () => [...cases],
    async write(lesson, opts) {
      const seen = opts?.key ? keyed.get(opts.key) : undefined;
      if (seen) return { id: seen };
      const id = lesson.id ?? `lesson-${lessons.length + 1}`;
      const { contested: _c, ...stored } = lesson;
      lessons.push({ ...stored, id, version: 1 });
      if (opts?.key) keyed.set(opts.key, id);
      return { id };
    },
    async find(domain, selector, limit) {
      return lessons
        .filter((l) => l.domain === domain && current(l) && lessonMatches(l, selector))
        .map(view)
        .slice(0, limit);
    },
    async findRetired(domain, selector, limit) {
      return lessons
        .filter(
          (l) => l.domain === domain && l.id && retired.has(l.id) && lessonMatches(l, selector),
        )
        .map((l) => ({ ...view(l), retired: { ...retired.get(l.id!)! } }))
        .slice(0, limit);
    },
    async retire(domain, id, retirement) {
      const l = lessons.find((x) => x.id === id && x.domain === domain);
      if (!l) throw new Error(`no lesson ${id} in ${domain}`);
      if (retired.has(id)) throw new Error(`lesson ${id} is already retired`);
      retired.set(id, retirement);
    },
    async neighbours(domain, text, opts) {
      const q = lessonTokens(text);
      const ranked = lessons
        .filter((l) => l.domain === domain && current(l))
        .map((l) => ({ l, hits: overlap(l, q) }))
        .filter((x) => x.hits > 0)
        .sort((a, b) => b.hits - a.hits);
      return {
        lessons: ranked.slice(0, opts.limit).map((x) => view(x.l)),
        generation: lessons.length,
        mode: "lexical",
        degraded: opts.hybrid ? ["semantic_not_configured"] : [],
      };
    },
    async update(domain, id, change) {
      const i = lessons.findIndex((x) => x.id === id && x.domain === domain);
      if (i < 0 || !current(lessons[i]!)) throw new Error(`no current lesson ${id} in ${domain}`);
      const before = lessons[i]!;
      const { contested: _c, ...next } = change(view(before));
      lessons[i] = {
        ...next,
        id,
        text: before.text,
        resolvedAt: before.resolvedAt,
        version: (before.version ?? 1) + 1,
      };
    },
    async contest(domain, id, against, opts) {
      if (!lessons.some((x) => x.id === against && x.domain === domain && current(x)))
        throw new Error(`no current lesson ${against} in ${domain}`);
      const caseId = `case-${cases.length + 1}`;
      cases.push({ id: caseId, against, resolved: opts.autoResolve, rationale: opts.rationale });
      if (opts.autoResolve)
        retired.set(against, { reason: opts.rationale, by: "admission", supersededBy: id });
      return { caseId, resolved: opts.autoResolve };
    },
    async recall(domain, query, asOf, opts) {
      const q = lessonTokens(query);
      const fam = new Set(opts?.families ?? []);
      const ranked = lessons
        .filter((l) => l.domain === domain && current(l))
        .map((l) => ({ l: view(l), hits: overlap(l, q) }))
        .filter(
          (x) =>
            x.hits > 0 ||
            q.size === 0 ||
            (x.l.families ?? []).some((f) => fam.has(f)) ||
            (!!x.l.scopeFamily && fam.has(x.l.scopeFamily)),
        )
        .sort((a, b) => b.hits - a.hits);
      return selectServed(
        ranked.map((x) => x.l),
        asOf,
        opts,
      );
    },
  };
}

// ─── The loop ────────────────────────────────────────────────────────────────

/** What an admission step sees for one judged write. */
export interface LessonAdmissionContext {
  outcome: Outcome;
  verdict: LessonVerdict;
  /** `lesson` for the producer-domain write, `meta` for its cross-board mirror. */
  target: "lesson" | "meta";
  sink: LessonSink;
}

/**
 * What an admission step decided, when it needs more than "write this": a
 * lesson to write (or `null` for nothing — a merge it performed itself, into
 * `mergedInto`), and an `afterWrite` step run with the new record's id (a
 * supersession, a resolve case). A failing `afterWrite` never fails the write.
 */
export interface LessonAdmissionDecision {
  lesson: Lesson | null;
  /** The action taken (`new`, `merge`, `supersede`, `contest`), for the record. */
  action?: string;
  mergedInto?: string;
  afterWrite?: (id: string) => Promise<void>;
}

/**
 * The admission hook: runs AFTER the judge and BEFORE the write, for the
 * lesson and for its `meta` mirror. It returns the lesson to write (unchanged,
 * or carrying extra fields such as a rank), `null` to write nothing (a merge
 * into an existing record it performed itself), or a `LessonAdmissionDecision`.
 * Absent ⇒ every judged lesson is written as judged. This is where memory
 * admission ranking (`src/learning/admission.ts`) plugs in.
 */
export type LessonAdmission = (
  lesson: Lesson,
  ctx: LessonAdmissionContext,
) => Promise<Lesson | null | LessonAdmissionDecision>;

function asDecision(r: Lesson | null | LessonAdmissionDecision): LessonAdmissionDecision {
  if (r === null) return { lesson: null };
  return "text" in r && "domain" in r ? { lesson: r as Lesson } : (r as LessonAdmissionDecision);
}

async function runAfterWrite(d: LessonAdmissionDecision, id: string | undefined): Promise<void> {
  if (!d.afterWrite || !id) return;
  try {
    await d.afterWrite(id);
  } catch {
    // allow-empty-catch: the write stands; the follow-up (supersede/case) is best effort
  }
}

/**
 * A lesson that failed only `consistent` is written HELD (`contested`, never
 * served while the lesson it contradicts is current) and a resolve case is
 * opened against that lesson, the same path admission's `contest` takes.
 * Nothing changes when admission merged it (nothing new is written).
 */
function judgeContest(
  d: LessonAdmissionDecision,
  verdict: LessonVerdict,
  sink: LessonSink,
): LessonAdmissionDecision {
  const against = verdict.contests;
  if (!d.lesson || !against) return d;
  const prior = d.afterWrite;
  return {
    ...d,
    action: d.action ?? "contest",
    lesson: {
      ...d.lesson,
      admission: {
        ...(d.lesson.admission ?? { mode: "on", action: "contest", applied: true }),
        reason: verdict.reason,
        state: "contested",
        contests: [...new Set([...(d.lesson.admission?.contests ?? []), against])],
      },
    },
    afterWrite: async (id) => {
      try {
        await prior?.(id);
      } catch {
        // allow-empty-catch: admission's follow-up is best effort; the case below still opens
      }
      if (!sink.contest) return; // held anyway while `against` is current
      await sink.contest(d.lesson!.domain, id, against, {
        autoResolve: false,
        rationale: `lesson judge: ${verdict.reason}`,
      });
    },
  };
}

export interface OutcomeLearnerDeps {
  sink: LessonSink;
  writer?: LessonWriter;
  judge?: DecisionProvider;
  /** Called with the judge's cost (the writer records its own through modelComplete). */
  onSpend?: (usd: number) => void;
  /** Mirror trusted, transferable, non-case lessons into `lessons:meta` (MARINA_LESSONS_META ≠ off). */
  meta?: boolean;
  /** See `LessonAdmission`. */
  admit?: LessonAdmission;
  /**
   * Write nothing when no judge verdict was reached (outage, spend cap): the
   * outcome stays unlearned so a later pass judges it, instead of leaving an
   * `unverified` lesson behind. For batch passes such as the ledger backfill.
   */
  deferUnjudged?: boolean;
}

export interface OutcomeRecord {
  trust: LessonTrust;
  reason: string;
  lessonId?: string;
  lesson: Lesson;
  /** The `lessons:meta` mirror's id, when the lesson was mirrored. */
  metaId?: string;
  /** Not written: no verdict was reached and the caller asked to defer (`deferUnjudged`). */
  deferred?: boolean;
  /** What admission did with the lesson (absent: no admission step). */
  admission?: string;
  /** The existing lesson a duplicate was merged into (nothing new was written). */
  mergedInto?: string;
  /** Written held (contested): it contradicts this trusted lesson; a resolve case is open. */
  contests?: string;
}

/**
 * One outcome through the loop: candidate → judge (with the domain's current
 * trusted lessons as the consistency context) → [admission] → write → [meta
 * mirror]. Rejected candidates are written too, as audit records the recall
 * path never serves.
 */
export async function recordOutcome(
  deps: OutcomeLearnerDeps,
  outcome: Outcome,
): Promise<OutcomeRecord> {
  const candidate = await candidateFromOutcome(outcome, deps.writer);
  // No rule, no lesson: a bare mechanical restatement is never judged or
  // stored. The outcome waits (a durable caller retries it later).
  if (!candidate.rule)
    return {
      trust: "unverified",
      reason: `no rule (${candidate.provenance?.no_rule ?? "no writer"})`,
      lesson: candidate,
      deferred: true,
    };
  let existing: Lesson[] = [];
  try {
    existing = await deps.sink.recall(outcome.domain, candidate.text, outcome.resolvedAt, {
      limit: 5,
    });
  } catch {
    // allow-empty-catch: consistency context is best effort
  }
  existing = existing.filter((l) => l.trust === "trusted");
  const verdict = await judgeLesson(candidate, outcome, deps.judge, existing);
  if (verdict.costUsd) deps.onSpend?.(verdict.costUsd);
  if (deps.deferUnjudged && verdict.trust === "unverified")
    return { trust: verdict.trust, reason: verdict.reason, lesson: candidate, deferred: true };
  // A mechanical leak is kept as an audit record WITHOUT the leaking text.
  const audited: Lesson = verdict.leak
    ? (({ rule: _r, category: _c, ...rest }) => ({
        ...rest,
        text: `[lesson:${candidate.domain}] withheld · ${verdict.reason}`,
      }))(candidate)
    : candidate;
  const judged: Lesson = {
    ...audited,
    trust: verdict.trust,
    ...(verdict.judgement ? { judgement: verdict.judgement } : {}),
    ...(verdict.judge ? { judge: verdict.judge } : {}),
  };
  // ── Admission hook: after the judge, before the write. ──
  const admitted = deps.admit
    ? asDecision(await deps.admit(judged, { outcome, verdict, target: "lesson", sink: deps.sink }))
    : { lesson: judged };
  const decision = verdict.contests ? judgeContest(admitted, verdict, deps.sink) : admitted;
  const lesson = decision.lesson;
  if (!lesson)
    return {
      trust: verdict.trust,
      reason: `${verdict.reason}; ${decision.mergedInto ? "merged into an existing lesson" : "not admitted"}`,
      lesson: judged,
      ...(decision.action ? { admission: decision.action } : {}),
      ...(decision.mergedInto ? { mergedInto: decision.mergedInto } : {}),
    };
  const { id } = await deps.sink.write(lesson);
  await runAfterWrite(decision, id);
  let metaId: string | undefined;
  // A lesson held unserved (contested) is not mirrored until its case resolves.
  const held = lesson.admission?.state === "contested";
  const mirror = deps.meta && id && !held ? metaMirror(lesson, id, verdict) : undefined;
  if (mirror) {
    try {
      const metaDecision = deps.admit
        ? asDecision(
            await deps.admit(mirror, { outcome, verdict, target: "meta", sink: deps.sink }),
          )
        : { lesson: mirror };
      // Keyed by the original: a retried mirror of the same lesson writes once.
      if (metaDecision.lesson) {
        metaId = (await deps.sink.write(metaDecision.lesson, { key: `lesson-meta:${id}` })).id;
        await runAfterWrite(metaDecision, metaId);
      }
    } catch {
      // allow-empty-catch: a failed mirror leaves the lesson served in its own domain
    }
  }
  return {
    trust: verdict.trust,
    reason: verdict.reason,
    ...(id ? { lessonId: id } : {}),
    lesson,
    ...(metaId ? { metaId } : {}),
    ...(decision.action ? { admission: decision.action } : {}),
    ...(verdict.contests && lesson.admission?.state === "contested"
      ? { contests: verdict.contests }
      : {}),
  };
}

/**
 * A batch of outcomes, bounded: at most `maxOutcomes` are processed (the rest
 * are dropped and counted), `concurrency` at a time. One failing outcome never
 * stops the batch.
 */
export async function recordOutcomes(
  deps: OutcomeLearnerDeps,
  outcomes: Outcome[],
  opts: { maxOutcomes?: number; concurrency?: number } = {},
): Promise<{ records: OutcomeRecord[]; dropped: number; failed: number }> {
  const max = Math.max(0, opts.maxOutcomes ?? 50);
  const take = outcomes.slice(0, max);
  const queue = [...take];
  const records: OutcomeRecord[] = [];
  let failed = 0;
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, async () => {
    for (let o = queue.shift(); o; o = queue.shift()) {
      try {
        records.push(await recordOutcome(deps, o));
      } catch {
        failed++;
      }
    }
  });
  await Promise.all(workers);
  return { records, dropped: outcomes.length - take.length, failed };
}
