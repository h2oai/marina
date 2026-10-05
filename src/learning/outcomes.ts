// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Outcome learning: whenever something Marina did gets a verdict — a benchmark
 * run scored, a forecast resolved, a code verification passed or failed, an
 * arena round scored — the outcome becomes a CANDIDATE lesson, the decision
 * layer scores the candidate, and only a candidate that passes is served as a
 * lesson. Successes teach as much as failures.
 *
 *   outcome ──► candidate (mechanical summary + optional writer rule)
 *           ──► judge (noul questions: grounded, general, leak-free, consistent)
 *           ──► trusted    → lesson record, served by recall
 *               unverified → lesson record, served labelled (no judge: decisions off/outage)
 *               rejected   → audit record, never served
 *
 * Nothing here stores a benchmark's question or answer text: the candidate is
 * built from the outcome's own general fields, the writer is told not to
 * restate the case, and a mechanical check rejects any rule that quotes the
 * case text it was shown. Recall applies the leakage rule `visibleAt` (a
 * lesson resolved at T is invisible to work whose cutoff precedes T).
 */

import type { DecisionProvider, DecisionQuestions, NoulAnswer } from "../decisions/types";

/**
 * Where a lesson is pooled. The first five are producers (where an outcome came
 * from); `meta` is the cross-board pool: trusted, transferable lessons about a
 * method, a configuration, a budget, calibration, retrieval, infrastructure or
 * model behaviour, mirrored from their producer domain so every surface that
 * does that kind of work recalls them.
 */
export type OutcomeDomain = "forecast" | "code" | "tools" | "benchmark" | "arena" | "meta";

/** Domains an outcome can come from (every domain except the `meta` mirror). */
export const PRODUCER_DOMAINS: readonly OutcomeDomain[] = [
  "forecast",
  "code",
  "tools",
  "benchmark",
  "arena",
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
  /**
   * Where a lesson came from when it was not learned by this loop — a record
   * migrated from an earlier store (`store`, `account`, `space`, `id`,
   * `version`), or a `meta` mirror (`promoted_from: <domain>/<id>`). Stored as
   * metadata, never served to a model.
   */
  provenance?: Record<string, string>;
}

export interface LessonWriter {
  name: string;
  complete: (system: string, user: string) => Promise<string>;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const WRITER_SYSTEM = [
  "You turn one outcome into one terse, reusable lesson for an AI agent. No pleasantries.",
  'Reply with ONE JSON object: {"category": "<2-5 words: domain + kind of work>",',
  '"rule": "<one imperative sentence under 30 words that applies to SIMILAR future work>",',
  `"scope": "<what the rule is about: one of ${LESSON_SCOPES.join("|")}>"}.`,
  "The rule generalizes: a method, a source to check, a failure to avoid, a setting that worked.",
  "Never restate the specific case, its question, its answer, names, numbers or quotes from it.",
].join(" ");

/** The mechanical lesson text, before any writer rule. */
function mechanicalText(o: Outcome, category?: string, rule?: string): string {
  return [
    `[lesson:${o.domain}] ${o.succeeded ? "success" : "failure"}${category ? ` · ${category}` : ""}`,
    o.score !== undefined ? `score ${o.score.toFixed(2)}` : "",
    o.detail ? clip(o.detail, 120) : "",
    rule ? `rule: ${rule}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A candidate lesson from one outcome: always the mechanical part; a category
 * and rule from `writer` when given and it answers (a failing writer leaves the
 * mechanical lesson, never nothing).
 */
export async function candidateFromOutcome(o: Outcome, writer?: LessonWriter): Promise<Lesson> {
  let category: string | undefined;
  let rule: string | undefined;
  let scope: LessonScope = o.scope ?? defaultScope(o.domain);
  if (writer) {
    try {
      const raw = await writer.complete(
        WRITER_SYSTEM,
        [
          `Domain: ${o.domain} (${o.source})`,
          `Attempted: ${clip(o.attempted, 400)}`,
          `Result: ${o.succeeded ? "success" : "failure"}${o.score !== undefined ? ` (score ${o.score.toFixed(2)})` : ""}`,
          o.detail ? `Detail: ${clip(o.detail, 300)}` : "",
          o.signals?.length ? `Signals: ${clip(o.signals.join("; "), 400)}` : "",
          o.privateContext ? `Context (do not quote): ${clip(o.privateContext, 800)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      const m = raw.match(/\{[\s\S]*\}/);
      const parsed = m
        ? (JSON.parse(m[0]) as { category?: unknown; rule?: unknown; scope?: unknown })
        : {};
      if (typeof parsed.category === "string") category = clip(parsed.category.trim(), 48);
      if (typeof parsed.rule === "string") rule = clip(parsed.rule.trim(), 220);
      const named = typeof parsed.scope === "string" ? parsed.scope.trim().toLowerCase() : "";
      if (LESSON_SCOPES.includes(named as LessonScope)) scope = named as LessonScope;
    } catch {
      // allow-empty-catch: a writer outage leaves the mechanical candidate
    }
  }
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
      "Is the lesson supported by the outcome it was written from (the result, detail and signals)?",
    criteria: {
      true: "The lesson follows from the stated outcome and evidence.",
      false: "The lesson claims something the outcome does not show.",
    },
  },
  general: {
    type: "noul",
    instructions:
      "Would the lesson help on DIFFERENT but similar future work, rather than only this one case?",
    criteria: {
      true: "A reusable method, check, source or pitfall.",
      false: "A one-off fact about this case, or too vague to act on.",
    },
  },
  leak_free: {
    type: "noul",
    instructions:
      "Is the lesson free of the specific case's question, answer or identifying details?",
    criteria: {
      true: "No case-specific answer, name, number or quote.",
      false: "It reveals or restates the case's answer or specifics.",
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

/** Bars a calibrated judge must clear; an uncalibrated one uses one cut at 0.5. */
export const LESSON_JUDGE_POLICY = {
  grounded: 0.6,
  general: 0.55,
  leak_free: 0.7,
  consistent: 0.5,
} as const;

/**
 * The `transferable` bar (calibrated; an uncalibrated judge uses 0.5). It never
 * decides trust: only whether a trusted lesson is mirrored into `lessons:meta`.
 */
export const TRANSFERABLE_BAR = 0.6;

export interface LessonVerdict {
  trust: LessonTrust;
  reason: string;
  judgement?: Record<string, number>;
  /** The judge that answered, labelled `(uncalibrated)` when it used the single 0.5 cut. */
  judge?: string;
  /** The judge found the lesson transferable to other task families (its own bar). */
  transferable?: boolean;
  costUsd?: number;
}

/**
 * Score a candidate with the decision layer. No provider (decisions off) or an
 * outage ⇒ `unverified` — the conservative fallback never promotes to trusted.
 * A mechanical leak is rejected before the judge is asked.
 */
export async function judgeLesson(
  candidate: Lesson,
  outcome: Outcome,
  provider: DecisionProvider | undefined,
  existing: Lesson[] = [],
): Promise<LessonVerdict> {
  if (leaksCase(candidate, outcome.privateContext))
    return { trust: "rejected", reason: "quotes the case text" };
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
        },
        lesson: candidate.text,
        ...(candidate.scope ? { scope: candidate.scope } : {}),
        ...(candidate.families?.length ? { families: candidate.families } : {}),
        existing_lessons: existing.slice(0, 5).map((l) => l.text),
      },
      questions: LESSON_JUDGE_QUESTIONS,
    });
    const judgement: Record<string, number> = {};
    for (const [k, a] of Object.entries(result.answers)) {
      if (a.type === "noul") judgement[k] = (a as NoulAnswer).noul;
    }
    const calibrated = provider.calibrated !== false && result.calibrated !== false;
    const bar = (k: keyof typeof LESSON_JUDGE_POLICY) =>
      calibrated ? LESSON_JUDGE_POLICY[k] : 0.5;
    const failed = (Object.keys(LESSON_JUDGE_POLICY) as Array<keyof typeof LESSON_JUDGE_POLICY>)
      .filter((k) => judgement[k] === undefined || judgement[k]! < bar(k))
      .map((k) => `${k} ${(judgement[k] ?? 0).toFixed(2)}`);
    const judge = `${result.model || provider.model}${calibrated ? "" : " (uncalibrated)"}`;
    const transferable =
      judgement.transferable !== undefined &&
      judgement.transferable >= (calibrated ? TRANSFERABLE_BAR : 0.5);
    return {
      trust: failed.length ? "rejected" : "trusted",
      transferable,
      reason: failed.length
        ? `below bar: ${failed.join(", ")}`
        : calibrated
          ? "passed"
          : "passed (uncalibrated judge, one cut at 0.5)",
      judgement,
      judge,
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

/** How a recall selects: budget, trust floor, and lessons the work must not see. */
export interface LessonRecallOptions {
  limit?: number;
  maxBytes?: number;
  includeUnverified?: boolean;
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
   * Retire one current lesson: a new version with validity closed and the
   * retirement in its metadata. Recall stops serving it; its history stays readable.
   */
  retire?(domain: OutcomeDomain, id: string, retirement: LessonRetirement): Promise<void>;
}

/** The leakage rule: a lesson exists for work only once its outcome was known. */
export function visibleAt(lesson: Pick<Lesson, "resolvedAt">, asOf: string): boolean {
  const r = Date.parse(lesson.resolvedAt);
  const a = Date.parse(asOf);
  return Number.isFinite(r) && Number.isFinite(a) && r <= a;
}

export const DEFAULT_RECALL_LIMIT = 5;
export const DEFAULT_RECALL_BYTES = 1_200;

/**
 * Served, visible lessons: trusted first, then newest; trimmed to the byte
 * budget. `exclude` drops lessons the work must not see (self-exclusion);
 * the leakage rule `visibleAt` always applies.
 */
export function selectServed(
  candidates: Lesson[],
  asOf: string,
  opts: LessonRecallOptions = {},
): Lesson[] {
  const limit = opts.limit ?? DEFAULT_RECALL_LIMIT;
  const budget = opts.maxBytes ?? DEFAULT_RECALL_BYTES;
  const exclude = opts.exclude;
  const served = candidates
    .filter(
      (l) =>
        l.trust === "trusted" || (opts.includeUnverified !== false && l.trust === "unverified"),
    )
    .filter((l) => visibleAt(l, asOf))
    .filter((l) => !exclude?.(l))
    .sort(
      (a, b) =>
        (a.trust === "trusted" ? 0 : 1) - (b.trust === "trusted" ? 0 : 1) ||
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
  const { id: _id, provenance: _p, ...rest } = lesson;
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
} {
  const lessons = [...initial];
  const retired = new Map<string, LessonRetirement>();
  const keyed = new Map<string, string>();
  const current = (l: Lesson) => !(l.id && retired.has(l.id));
  return {
    all: () => [...lessons],
    retirements: () => new Map(retired),
    async write(lesson, opts) {
      const seen = opts?.key ? keyed.get(opts.key) : undefined;
      if (seen) return { id: seen };
      const id = lesson.id ?? `lesson-${lessons.length + 1}`;
      lessons.push({ ...lesson, id });
      if (opts?.key) keyed.set(opts.key, id);
      return { id };
    },
    async find(domain, selector, limit) {
      return lessons
        .filter((l) => l.domain === domain && current(l) && lessonMatches(l, selector))
        .slice(0, limit);
    },
    async retire(domain, id, retirement) {
      const l = lessons.find((x) => x.id === id && x.domain === domain);
      if (!l) throw new Error(`no lesson ${id} in ${domain}`);
      if (retired.has(id)) throw new Error(`lesson ${id} is already retired`);
      retired.set(id, retirement);
    },
    async recall(domain, query, asOf, opts) {
      const q = lessonTokens(query);
      const fam = new Set(opts?.families ?? []);
      const ranked = lessons
        .filter((l) => l.domain === domain && current(l))
        .map((l) => ({
          l,
          hits: [...lessonTokens(`${l.text} ${l.category ?? ""}`)].filter((t) => q.has(t)).length,
        }))
        .filter((x) => x.hits > 0 || q.size === 0 || (x.l.families ?? []).some((f) => fam.has(f)))
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
 * The admission hook: runs AFTER the judge and BEFORE the write, for the
 * lesson and for its `meta` mirror. It returns the lesson to write (unchanged,
 * or carrying extra fields such as a rank), or `null` to write nothing (a merge
 * into an existing record it performed itself). Absent ⇒ every judged lesson is
 * written as judged. This is where memory admission ranking plugs in.
 */
export type LessonAdmission = (
  lesson: Lesson,
  ctx: LessonAdmissionContext,
) => Promise<Lesson | null>;

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
}

export interface OutcomeRecord {
  trust: LessonTrust;
  reason: string;
  lessonId?: string;
  lesson: Lesson;
  /** The `lessons:meta` mirror's id, when the lesson was mirrored. */
  metaId?: string;
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
  let existing: Lesson[] = [];
  try {
    existing = await deps.sink.recall(outcome.domain, candidate.text, outcome.resolvedAt, {
      includeUnverified: false,
      limit: 5,
    });
  } catch {
    // allow-empty-catch: consistency context is best effort
  }
  const verdict = await judgeLesson(candidate, outcome, deps.judge, existing);
  if (verdict.costUsd) deps.onSpend?.(verdict.costUsd);
  const judged: Lesson = {
    ...candidate,
    trust: verdict.trust,
    ...(verdict.judgement ? { judgement: verdict.judgement } : {}),
    ...(verdict.judge ? { judge: verdict.judge } : {}),
  };
  // ── Admission hook: after the judge, before the write. ──
  const lesson = deps.admit
    ? await deps.admit(judged, { outcome, verdict, target: "lesson", sink: deps.sink })
    : judged;
  if (!lesson)
    return { trust: verdict.trust, reason: `${verdict.reason}; not admitted`, lesson: judged };
  const { id } = await deps.sink.write(lesson);
  let metaId: string | undefined;
  const mirror = deps.meta && id ? metaMirror(lesson, id, verdict) : undefined;
  if (mirror) {
    try {
      const admitted = deps.admit
        ? await deps.admit(mirror, { outcome, verdict, target: "meta", sink: deps.sink })
        : mirror;
      // Keyed by the original: a retried mirror of the same lesson writes once.
      if (admitted) metaId = (await deps.sink.write(admitted, { key: `lesson-meta:${id}` })).id;
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
