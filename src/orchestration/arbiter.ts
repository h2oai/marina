// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Arbiter: adjudication only where answers disagree, in place of
 * always-on verification.
 *
 * A same-model verifier that reviews every answer overrules correct answers too
 * easily. On BrowseComp-Plus the `marina/verify:` arm cut accuracy and gold
 * recall (85 % to 66 %). The Arbiter works the other way round:
 *
 *   1. Disagreement detection (free). Signals the pipeline already has decide
 *      whether an item is contested: agreement among independent runs by
 *      answer type, a verifier's or critic's dissent, and the spread of judge
 *      scores. Only contested items reach the Arbiter, and at most
 *      `policy.cap` of them per batch (`selectForArbiter`) or per UTC day
 *      (`ArbiterQuota`).
 *   2. The contract. The Arbiter answers with one JSON verdict: keep,
 *      overrule (with the answer it overrules to) or abstain; citations for
 *      every answer item; a source-quality and a reasoning-quality score; and
 *      a confidence. Abstaining is encouraged.
 *   3. The overrule bar (`applyOverruleBar`). Overruling a majority of
 *      agreeing runs needs grounded citations from at least `minDomains`
 *      independent registrable domains AND confidence of at least
 *      `minConfidence`. Anything short of that is downgraded to keep or
 *      abstain, and both keep the majority's answer.
 *   4. Earned trust (`arbiterTrackRecord`). Each overrule, including the ones
 *      recorded in observe mode, is scored when its question resolves. The
 *      right to act on an overrule can be gated on that record: precision of
 *      at least `earn.minPrecision` over at least `earn.minResolved` resolved
 *      overrules.
 *
 * The module is pure. Every model call goes through the injected `complete`,
 * so typed forecasts (`src/forecast/arbiter.ts`), the passthru verification
 * formation (`src/net/model-api/verify.ts`), the in-world `arbiter` command and
 * offline replays share one implementation. In the world, the Arbiter is also
 * a resident role (`arbiter`, seeded in `worlds/seed.ts`) that crews invite.
 */

/** off: never consulted; observe: adjudicates and records, changes nothing; on: acts. */
export type ArbiterMode = "off" | "observe" | "on";
export const ARBITER_MODES: readonly ArbiterMode[] = ["off", "observe", "on"];

export type ArbiterAnswerType = "choice" | "multi" | "number" | "ranking" | "text";

export type ArbiterValue = string | number | string[];

export interface ArbiterPolicy {
  /** An item is contested when its runs' agreement is below this (1 = any disagreement). */
  contestedBelow: number;
  /** Agreement above this means the runs have a majority (the bar then applies in full). */
  majorityAbove: number;
  /** Independent registrable domains an overrule of a majority must cite. */
  minDomains: number;
  /** Domains an overrule must cite when the runs had no majority to overrule. */
  minDomainsNoMajority: number;
  /** Confidence an overrule needs. */
  minConfidence: number;
  /** Two numbers within this relative distance are the same answer. */
  numberTolerance: number;
  /** Judge scores (0–1) spread wider than this mark an item contested. */
  judgeSpread: number;
  /** Most items that reach the Arbiter per batch or per UTC day (0 = no cap). */
  cap: number;
  /** Earned trust: when an overrule may change an answer. */
  earn: {
    minResolved: number;
    minPrecision: number;
    /** Until earned: `strict` acts on overrules that clear the bar; `observe` only records them. */
    unearned: "strict" | "observe";
  };
}

export const DEFAULT_ARBITER_POLICY: ArbiterPolicy = {
  contestedBelow: 1,
  majorityAbove: 0.5,
  minDomains: 2,
  minDomainsNoMajority: 1,
  minConfidence: 0.7,
  numberTolerance: 0.025,
  judgeSpread: 0.5,
  cap: 100,
  earn: { minResolved: 20, minPrecision: 0.6, unearned: "strict" },
};

const num = (v: string | undefined, lo: number, hi: number): number | undefined => {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
};

/** The policy from `MARINA_ARBITER_*` (unset or invalid values keep the defaults). */
export function arbiterPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ArbiterPolicy {
  const d = DEFAULT_ARBITER_POLICY;
  const unearned = env.MARINA_ARBITER_UNEARNED?.trim().toLowerCase();
  return {
    ...d,
    contestedBelow: num(env.MARINA_ARBITER_CONTESTED_BELOW, 0, 1) ?? d.contestedBelow,
    minDomains: Math.round(num(env.MARINA_ARBITER_MIN_DOMAINS, 0, 10) ?? d.minDomains),
    minConfidence: num(env.MARINA_ARBITER_MIN_CONFIDENCE, 0, 1) ?? d.minConfidence,
    judgeSpread: num(env.MARINA_ARBITER_JUDGE_SPREAD, 0, 1) ?? d.judgeSpread,
    cap: Math.round(num(env.MARINA_ARBITER_CAP, 0, 1e6) ?? d.cap),
    earn: {
      minResolved: Math.round(
        num(env.MARINA_ARBITER_EARN_MIN_RESOLVED, 0, 1e6) ?? d.earn.minResolved,
      ),
      minPrecision: num(env.MARINA_ARBITER_EARN_MIN_PRECISION, 0, 1) ?? d.earn.minPrecision,
      unearned: unearned === "observe" ? "observe" : "strict",
    },
  };
}

/** A mode from a raw setting: `observe` / `on` (also true/1/yes), else off. */
export function parseArbiterMode(raw: string | undefined): ArbiterMode {
  const v = raw?.trim().toLowerCase();
  if (v === "observe") return "observe";
  if (v === "on" || v === "true" || v === "1" || v === "yes") return "on";
  return "off";
}

// ─── Answers and their keys ─────────────────────────────────────────────────

/** Case, accents, punctuation and spacing folded away (text answers compare on this). */
export function foldText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A raw answer as the type's value (a list from a comma list, a number from text). */
export function toArbiterValue(type: ArbiterAnswerType, raw: unknown): ArbiterValue | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (type === "number") {
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[,\s_]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "multi" || type === "ranking") {
    const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(",");
    const items = list.map((s) => s.trim()).filter(Boolean);
    return items.length ? items : undefined;
  }
  const s = Array.isArray(raw) ? raw.join(", ") : String(raw);
  return s.trim() ? s.trim() : undefined;
}

/** The comparison key of a non-number answer (numbers cluster by tolerance instead). */
export function answerKey(type: ArbiterAnswerType, v: ArbiterValue): string {
  if (type === "number") return String(v);
  if (type === "multi") return [...(v as string[])].map(foldText).sort().join("|");
  if (type === "ranking") return (v as string[]).map(foldText).join(">");
  return foldText(Array.isArray(v) ? v.join(", ") : String(v));
}

/** One answer as text (lists comma-separated). */
export function formatArbiterValue(v: ArbiterValue): string {
  return Array.isArray(v) ? v.join(", ") : String(v);
}

/** The parts of an answer that each need a citation: list elements, else the whole answer. */
export function answerItems(v: ArbiterValue): string[] {
  return Array.isArray(v) ? v.map(String) : [formatArbiterValue(v)];
}

function sameNumber(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1e-9) * tol;
}

// ─── Disagreement detection ─────────────────────────────────────────────────

export interface ArbiterRun {
  answer: ArbiterValue;
  /** Default 1. */
  weight?: number;
  /** Who gave it (`run 2`, a model name). */
  label?: string;
}

/** A reviewer that disagreed: a verifier's correction, a critic's revision, a checker's flag. */
export interface ArbiterDissent {
  by: string;
  /** The answer it proposes, when it proposes one. */
  answer?: ArbiterValue;
  reason?: string;
}

export interface ArbiterItem {
  /** A stable id (never question text). */
  id: string;
  question: string;
  type: ArbiterAnswerType;
  runs: ArbiterRun[];
  dissent?: ArbiterDissent[];
  /** Judge scores of the runs, 0–1 (grounding, support …). */
  judgeScores?: number[];
  /**
   * The evidence the runs read. Citations are grounded against it: a quote must
   * appear in it, and a cited source must appear in it or in `sources`.
   */
  evidence?: string;
  /** Sources the evidence came from (URLs or document ids). */
  sources?: string[];
  /** Choice options, shown to the Arbiter. */
  options?: Array<{ id: string; label: string }>;
}

export type DisagreementReason = "runs-disagree" | "dissent" | "judge-spread";

export interface Disagreement {
  contested: boolean;
  reasons: DisagreementReason[];
  /** Weight share of the most supported answer (1 = unanimous; 0 = no runs). */
  agreement: number;
  /** The most supported answer (absent with no runs). */
  majority?: ArbiterValue;
  /** True when that answer has more than `majorityAbove` of the weight. */
  hasMajority: boolean;
  /** Distinct answers, most supported first. */
  answers: Array<{ answer: ArbiterValue; weight: number }>;
  /** Dissenting reviewers whose answer differs from the majority (or who proposed none). */
  dissent: ArbiterDissent[];
  judgeSpread?: number;
  /** Higher = more contested; orders items under a cap. */
  severity: number;
}

interface Group {
  answer: ArbiterValue;
  key: string;
  weight: number;
  values: Array<{ x: number; w: number }>;
}

function group(type: ArbiterAnswerType, runs: ArbiterRun[], tol: number): Group[] {
  const groups: Group[] = [];
  const usable = runs.filter((r) => (r.weight ?? 1) > 0);
  if (type === "number") {
    const sorted = usable
      .map((r) => ({ x: Number(r.answer), w: r.weight ?? 1 }))
      .filter((v) => Number.isFinite(v.x))
      .sort((a, b) => a.x - b.x);
    for (const v of sorted) {
      const g = groups.find((c) => sameNumber(c.values[0]!.x, v.x, tol));
      if (g) {
        g.values.push(v);
        g.weight += v.w;
      } else groups.push({ answer: v.x, key: String(v.x), weight: v.w, values: [v] });
    }
    for (const g of groups) g.answer = weightedMedian(g.values);
  } else {
    for (const r of usable) {
      const key = answerKey(type, r.answer);
      const g = groups.find((c) => c.key === key);
      if (g) g.weight += r.weight ?? 1;
      else groups.push({ answer: r.answer, key, weight: r.weight ?? 1, values: [] });
    }
  }
  return groups.sort((a, b) => b.weight - a.weight);
}

function weightedMedian(values: Array<{ x: number; w: number }>): number {
  const sorted = [...values].sort((a, b) => a.x - b.x);
  const total = sorted.reduce((s, v) => s + v.w, 0);
  let acc = 0;
  for (const v of sorted) {
    acc += v.w;
    if (acc >= total / 2) return v.x;
  }
  return sorted[sorted.length - 1]!.x;
}

/** Whether two answers are the same answer under the type's comparison. */
export function sameAnswer(
  type: ArbiterAnswerType,
  a: ArbiterValue,
  b: ArbiterValue,
  tol = DEFAULT_ARBITER_POLICY.numberTolerance,
): boolean {
  if (type === "number") return sameNumber(Number(a), Number(b), tol);
  return answerKey(type, a) === answerKey(type, b);
}

/** Whether an item is contested, from free signals only (no model call). */
export function detectDisagreement(
  item: Pick<ArbiterItem, "type" | "runs" | "dissent" | "judgeScores">,
  policy: ArbiterPolicy = DEFAULT_ARBITER_POLICY,
): Disagreement {
  const groups = group(item.type, item.runs, policy.numberTolerance);
  const total = groups.reduce((s, g) => s + g.weight, 0);
  const top = groups[0];
  const agreement = top && total > 0 ? round(top.weight / total) : 0;
  const reasons: DisagreementReason[] = [];
  if (groups.length > 1 && agreement < policy.contestedBelow) reasons.push("runs-disagree");
  const dissent = (item.dissent ?? []).filter(
    (d) =>
      d.answer === undefined ||
      !top ||
      !sameAnswer(item.type, d.answer, top.answer, policy.numberTolerance),
  );
  if (dissent.length) reasons.push("dissent");
  const scores = (item.judgeScores ?? []).filter((s) => Number.isFinite(s));
  const spread = scores.length > 1 ? round(Math.max(...scores) - Math.min(...scores)) : undefined;
  if (spread !== undefined && spread > policy.judgeSpread) reasons.push("judge-spread");
  return {
    contested: reasons.length > 0,
    reasons,
    agreement,
    ...(top ? { majority: top.answer } : {}),
    hasMajority: agreement > policy.majorityAbove,
    answers: groups.map((g) => ({ answer: g.answer, weight: round(g.weight) })),
    dissent,
    ...(spread !== undefined ? { judgeSpread: spread } : {}),
    severity: round(1 - agreement + dissent.length * 0.5 + (spread ?? 0) * 0.25),
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

// ─── The cap ────────────────────────────────────────────────────────────────

/** The contested items that reach the Arbiter under a cap, most contested first. */
export function selectForArbiter<T extends { id: string; disagreement: Disagreement }>(
  items: readonly T[],
  cap: number,
): { selected: T[]; capped: T[]; uncontested: T[] } {
  const contested = items.filter((i) => i.disagreement.contested);
  const uncontested = items.filter((i) => !i.disagreement.contested);
  const ranked = contested
    .map((item, i) => ({ item, i }))
    .sort((a, b) => b.item.disagreement.severity - a.item.disagreement.severity || a.i - b.i)
    .map((x) => x.item);
  const n = cap > 0 ? cap : ranked.length;
  return { selected: ranked.slice(0, n), capped: ranked.slice(n), uncontested };
}

/** A per-process, per-UTC-day allowance of Arbiter calls (a cap for streaming callers). */
export class ArbiterQuota {
  private day = "";
  private used = 0;
  constructor(private readonly cap: number) {}
  /** Take one call; false when today's cap is spent (cap 0 = unlimited). */
  take(now: Date = new Date()): boolean {
    const day = now.toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
    if (this.cap > 0 && this.used >= this.cap) return false;
    this.used++;
    return true;
  }
  get spent(): number {
    return this.used;
  }
}

// ─── Domains ────────────────────────────────────────────────────────────────

/** Second-level labels under which a registrable domain takes three labels (`bbc.co.uk`). */
const SECOND_LEVEL = /^(co|com|org|net|gov|ac|edu|gob|nic|ne|or|go|mil|sch|ltd|plc)$/;

/**
 * The independence key of a cited source. A URL (or bare host) is its
 * registrable domain, approximately (`news.bbc.co.uk` and `www.bbc.co.uk` are
 * both `bbc.co.uk`; `en.wikipedia.org` is `wikipedia.org`). Anything else (a
 * corpus document id, `note:12`) is its own key, folded.
 */
export function sourceKey(source: string): string {
  const s = source.trim();
  let host: string | undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  const bareHost = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(s);
  if (withScheme || bareHost) {
    try {
      host = new URL(withScheme ? s : `https://${s}`).hostname.toLowerCase();
    } catch {
      host = undefined;
    }
  }
  if (!host) return s.toLowerCase().replace(/\s+/g, " ");
  const parts = host.replace(/^www\d*\./, "").split(".");
  if (parts.length <= 2 || /^\d+$/.test(parts[parts.length - 1]!)) return parts.join(".");
  const sld = parts[parts.length - 2]!;
  const tld = parts[parts.length - 1]!;
  const three = tld.length === 2 && SECOND_LEVEL.test(sld);
  return parts.slice(three ? -3 : -2).join(".");
}

// ─── The contract ───────────────────────────────────────────────────────────

export interface ArbiterCitation {
  source: string;
  quote?: string;
}

export interface ArbiterItemCitations {
  item: string;
  citations: ArbiterCitation[];
}

export type ArbiterVerdictKind = "keep" | "overrule" | "abstain";

export interface ArbiterVerdict {
  verdict: ArbiterVerdictKind;
  /** The answer to overrule to (overrule only), as the Arbiter wrote it. */
  answer?: unknown;
  /** Citations per answer item. */
  items: ArbiterItemCitations[];
  /** 0–1: how good the cited sources are (primary, recent, independent). */
  sourceQuality: number;
  /** 0–1: how sound the reasoning from the sources to the answer is. */
  reasoningQuality: number;
  /** 0–1. */
  confidence: number;
  reason?: string;
}

export const ARBITER_SYSTEM = [
  "You are the Arbiter. Independent attempts at one question disagree, or a reviewer disputes their answer.",
  "Decide from the EVIDENCE shown, not from memory. Your verdict is one of:",
  '"keep" — the majority answer stands; "overrule" — the evidence shows a different answer; "abstain" — the evidence does not settle it.',
  "Abstaining is good: it keeps the majority answer. Overrule only with evidence you can cite.",
  "For every item of the answer you give (every element of a list answer, or the single answer), cite at least one source with a verbatim quote from the evidence that supports it.",
  "To overrule answers that several attempts agree on you need sources from at least two independent websites and confidence of at least 0.7; otherwise keep or abstain.",
  "Score the cited sources (source_quality: primary, recent, independent) and the reasoning from them to the answer (reasoning_quality), each 0–1.",
  'Reply with ONE JSON object: {"verdict":"keep"|"overrule"|"abstain","answer":<only on overrule, in the answer format>,',
  '"items":[{"item":"<answer item>","citations":[{"source":"<URL or document id from the evidence>","quote":"<verbatim excerpt>"}]}],',
  '"source_quality":<0-1>,"reasoning_quality":<0-1>,"confidence":<0-1>,"reason":"<one or two sentences>"}.',
].join("\n");

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The Arbiter's user message for one contested item. */
export function arbiterPrompt(
  item: ArbiterItem,
  d: Disagreement,
  opts: { evidenceChars?: number; answerFormat?: string } = {},
): string {
  const answers = d.answers.map(
    (a, i) =>
      `${i + 1}. ${formatArbiterValue(a.answer)} — weight ${a.weight}${i === 0 && d.hasMajority ? " (MAJORITY)" : ""}`,
  );
  const dissent = d.dissent.map(
    (x) =>
      `- ${x.by}${x.answer !== undefined ? ` proposes ${formatArbiterValue(x.answer)}` : " disputes the answer"}${x.reason ? `: ${clip(x.reason, 400)}` : ""}`,
  );
  return [
    `QUESTION: ${clip(item.question, 4_000)}`,
    `ANSWER TYPE: ${item.type}`,
    item.options?.length
      ? `OPTIONS:\n${item.options.map((o) => `- ${o.id}: ${o.label}`).join("\n")}`
      : "",
    opts.answerFormat ? `ANSWER FORMAT: ${opts.answerFormat}` : "",
    `ANSWERS FROM INDEPENDENT ATTEMPTS (agreement ${d.agreement}):`,
    ...answers,
    dissent.length ? `REVIEWERS WHO DISAGREE:\n${dissent.join("\n")}` : "",
    item.sources?.length
      ? `SOURCES:\n${item.sources
          .slice(0, 60)
          .map((s) => `- ${s}`)
          .join("\n")}`
      : "",
    `EVIDENCE:\n${item.evidence ? clip(item.evidence, opts.evidenceChars ?? 16_000) : "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const unit = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

/** The Arbiter's reply, leniently; undefined when it holds no verdict. */
export function parseArbiterVerdict(text: string): ArbiterVerdict | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const raw = typeof j.verdict === "string" ? j.verdict.trim().toLowerCase() : "";
  const verdict: ArbiterVerdictKind | undefined =
    raw === "keep" || raw === "overrule" || raw === "abstain"
      ? raw
      : raw === "revise" || raw.startsWith("overrule")
        ? "overrule"
        : undefined;
  if (!verdict) return undefined;
  const items: ArbiterItemCitations[] = [];
  if (Array.isArray(j.items)) {
    for (const it of j.items.slice(0, 50)) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const cites: ArbiterCitation[] = [];
      for (const c of Array.isArray(o.citations) ? o.citations.slice(0, 20) : []) {
        if (typeof c === "string" && c.trim()) cites.push({ source: c.trim() });
        else if (c && typeof c === "object") {
          const cc = c as Record<string, unknown>;
          const source = typeof cc.source === "string" ? cc.source.trim() : "";
          if (!source) continue;
          const quote = typeof cc.quote === "string" ? cc.quote.trim() : "";
          cites.push({ source, ...(quote ? { quote: clip(quote, 600) } : {}) });
        }
      }
      items.push({ item: String(o.item ?? "").trim(), citations: cites });
    }
  }
  const reason = typeof j.reason === "string" ? clip(j.reason.trim(), 500) : undefined;
  return {
    verdict,
    ...(verdict === "overrule" && j.answer !== undefined && j.answer !== null
      ? { answer: j.answer }
      : {}),
    items,
    sourceQuality: unit(j.source_quality ?? j.sourceQuality),
    reasoningQuality: unit(j.reasoning_quality ?? j.reasoningQuality),
    confidence: unit(j.confidence),
    ...(reason ? { reason } : {}),
  };
}

// ─── The overrule bar ───────────────────────────────────────────────────────

export interface BarResult {
  /** The verdict after the bar. */
  verdict: ArbiterVerdictKind;
  /** The answer an overrule changes to (overrule only). */
  answer?: ArbiterValue;
  /** Why an overrule was downgraded (empty when it cleared the bar or none was asked). */
  downgraded: string[];
  /** Independent domains among the grounded citations. */
  domains: string[];
  /** Domains the bar required. */
  requiredDomains: number;
  /** Answer items with no grounded citation. */
  uncited: string[];
  /** Citations dropped because their quote or source is not in the evidence. */
  ungrounded: number;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function grounded(c: ArbiterCitation, evidence: string | undefined, known: Set<string>): boolean {
  if (evidence === undefined) return true;
  const ev = fold(evidence);
  if (!c.quote || !ev.includes(fold(c.quote))) return false;
  const key = sourceKey(c.source);
  return known.has(key) || ev.includes(fold(c.source)) || ev.includes(key);
}

/** Whether a cited item names this answer item (folded, as whole words either way). */
function citesItem(cited: string, item: string): boolean {
  const a = foldText(cited);
  const b = foldText(item);
  if (!a || !b) return false;
  return a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

/**
 * The overrule bar. An overrule of a majority stands only with grounded
 * citations for every answer item, from at least `minDomains` independent
 * registrable domains, at confidence of at least `minConfidence`; without a
 * majority the domain floor is `minDomainsNoMajority`. Anything short is
 * downgraded: to abstain when confidence is the problem, otherwise to keep.
 * Keep and abstain pass through unchanged (both keep the majority answer).
 */
export function applyOverruleBar(
  v: ArbiterVerdict,
  ctx: {
    type: ArbiterAnswerType;
    disagreement: Disagreement;
    evidence?: string;
    sources?: string[];
    policy?: ArbiterPolicy;
  },
): BarResult {
  const policy = ctx.policy ?? DEFAULT_ARBITER_POLICY;
  const requiredDomains = ctx.disagreement.hasMajority
    ? policy.minDomains
    : policy.minDomainsNoMajority;
  const base: BarResult = {
    verdict: v.verdict,
    downgraded: [],
    domains: [],
    requiredDomains,
    uncited: [],
    ungrounded: 0,
  };
  if (v.verdict !== "overrule") return base;
  const answer = toArbiterValue(ctx.type, v.answer);
  if (answer === undefined) return { ...base, verdict: "abstain", downgraded: ["no answer"] };
  const majority = ctx.disagreement.majority;
  if (majority !== undefined && sameAnswer(ctx.type, answer, majority, policy.numberTolerance))
    return { ...base, verdict: "keep", downgraded: ["same as the majority"] };
  const known = new Set((ctx.sources ?? []).map(sourceKey));
  const domains = new Set<string>();
  let ungrounded = 0;
  const citedItems: Array<{ item: string; ok: boolean }> = [];
  for (const it of v.items) {
    const ok = it.citations.filter((c) => {
      const g = grounded(c, ctx.evidence, known);
      if (!g) ungrounded++;
      return g;
    });
    for (const c of ok) domains.add(sourceKey(c.source));
    citedItems.push({ item: it.item, ok: ok.length > 0 });
  }
  const items = answerItems(answer);
  const uncited = items.filter(
    (item) =>
      !citedItems.some((c) => c.ok && citesItem(c.item, item)) &&
      // A single-item answer may be cited under any item label.
      !(items.length === 1 && citedItems.some((c) => c.ok)),
  );
  const downgraded: string[] = [];
  if (uncited.length) downgraded.push(`uncited item(s): ${uncited.slice(0, 5).join(", ")}`);
  if (domains.size < requiredDomains)
    downgraded.push(`${domains.size} independent domain(s), ${requiredDomains} required`);
  const lowConfidence = v.confidence < policy.minConfidence;
  if (lowConfidence) downgraded.push(`confidence ${v.confidence} < ${policy.minConfidence}`);
  const result = { ...base, domains: [...domains].sort(), uncited, ungrounded, downgraded };
  if (downgraded.length === 0) return { ...result, verdict: "overrule", answer };
  return { ...result, verdict: lowConfidence ? "abstain" : "keep" };
}

// ─── Earned trust ───────────────────────────────────────────────────────────

/** One overrule and, once its question resolved, whether it beat the majority. */
export interface ArbiterTrackEntry {
  evaluator: string;
  /** Resolved: true when the overrule's answer was better than the majority's. */
  right?: boolean;
}

export interface ArbiterTrackRecord {
  evaluator: string;
  /** Overrules whose question has resolved. */
  resolved: number;
  right: number;
  /** right / resolved (0 with none). */
  precision: number;
  /** Overrules still waiting for their outcome. */
  pending: number;
  earned: boolean;
}

/** An evaluator's overrule record against `policy.earn`. */
export function arbiterTrackRecord(
  entries: readonly ArbiterTrackEntry[],
  evaluator: string,
  policy: ArbiterPolicy = DEFAULT_ARBITER_POLICY,
): ArbiterTrackRecord {
  const mine = entries.filter((e) => e.evaluator === evaluator);
  const resolved = mine.filter((e) => e.right !== undefined);
  const right = resolved.filter((e) => e.right).length;
  const precision = resolved.length ? round(right / resolved.length) : 0;
  return {
    evaluator,
    resolved: resolved.length,
    right,
    precision,
    pending: mine.length - resolved.length,
    earned: resolved.length >= policy.earn.minResolved && precision >= policy.earn.minPrecision,
  };
}

/** Whether a bar-clearing overrule may change an answer under the earned-trust rule. */
export function overruleAllowed(
  record: ArbiterTrackRecord | undefined,
  policy: ArbiterPolicy = DEFAULT_ARBITER_POLICY,
): { allowed: boolean; why: string } {
  if (record?.earned)
    return {
      allowed: true,
      why: `earned: ${record.right}/${record.resolved} overrules right (${record.precision})`,
    };
  if (policy.earn.unearned === "strict")
    return { allowed: true, why: "strict bar (not yet earned)" };
  return {
    allowed: false,
    why: `not yet earned (${record?.right ?? 0}/${record?.resolved ?? 0} right; needs ${policy.earn.minResolved} at ≥ ${policy.earn.minPrecision})`,
  };
}

// ─── One adjudication ───────────────────────────────────────────────────────

export type ArbiterComplete = (system: string, user: string) => Promise<string>;

export type ArbiterStatus = "uncontested" | "capped" | "adjudicated" | "unavailable" | "no-answers";

/** What the Arbiter did with one item: the audit record (numbers, labels, short reasons). */
export interface ArbiterResult {
  mode: Exclude<ArbiterMode, "off">;
  evaluator: string;
  status: ArbiterStatus;
  disagreement: Disagreement;
  /** The Arbiter's own verdict, before the bar. */
  verdict?: ArbiterVerdict;
  /** The verdict after the bar. */
  bar?: BarResult;
  /** The answer the item should carry: the majority, or an applied overrule. */
  final?: ArbiterValue;
  /** True when an overrule changed the answer (mode `on`, bar cleared, trust allowed). */
  applied: boolean;
  /** Why a bar-clearing overrule was or was not applied (earned trust). */
  trust?: string;
  error?: string;
}

export interface ArbitrateOptions {
  mode: Exclude<ArbiterMode, "off">;
  complete: ArbiterComplete;
  /** The Arbiter's name in records (`<model>`); trust is earned per evaluator. */
  evaluator: string;
  policy?: ArbiterPolicy;
  /** A streaming cap; unset = no cap here (batch callers use `selectForArbiter`). */
  quota?: ArbiterQuota;
  /** The evaluator's overrule record so far. */
  track?: ArbiterTrackRecord;
  /** How the answer must be written (shown to the Arbiter). */
  answerFormat?: string;
}

/**
 * Detect, and when contested ask the Arbiter once and apply the bar. Never
 * throws for a model failure: an outage or an unreadable reply is
 * `unavailable` and keeps the majority answer.
 */
export async function arbitrate(item: ArbiterItem, o: ArbitrateOptions): Promise<ArbiterResult> {
  const policy = o.policy ?? DEFAULT_ARBITER_POLICY;
  const d = detectDisagreement(item, policy);
  const base: ArbiterResult = {
    mode: o.mode,
    evaluator: o.evaluator,
    status: "uncontested",
    disagreement: d,
    ...(d.majority !== undefined ? { final: d.majority } : {}),
    applied: false,
  };
  if (item.runs.length === 0) return { ...base, status: "no-answers" };
  if (!d.contested) return base;
  if (o.quota && !o.quota.take()) return { ...base, status: "capped" };
  let text: string;
  try {
    text = await o.complete(
      ARBITER_SYSTEM,
      arbiterPrompt(item, d, o.answerFormat ? { answerFormat: o.answerFormat } : {}),
    );
  } catch (err) {
    return {
      ...base,
      status: "unavailable",
      error: clip(err instanceof Error ? err.message : String(err), 200),
    };
  }
  const verdict = parseArbiterVerdict(text);
  if (!verdict) return { ...base, status: "unavailable", error: "no readable verdict" };
  const bar = applyOverruleBar(verdict, {
    type: item.type,
    disagreement: d,
    ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
    ...(item.sources ? { sources: item.sources } : {}),
    policy,
  });
  const out: ArbiterResult = { ...base, status: "adjudicated", verdict, bar };
  if (bar.verdict !== "overrule" || bar.answer === undefined) return out;
  const trust = overruleAllowed(o.track, policy);
  out.trust = trust.why;
  if (o.mode === "on" && trust.allowed) {
    out.final = bar.answer;
    out.applied = true;
  }
  return out;
}

/**
 * Whether an overrule beat the majority once the truth is known: `true` when
 * the overrule's answer is right and the majority's is not (or, for numbers,
 * strictly closer), `false` otherwise. Undefined when the truth cannot judge it.
 */
export function overruleRight(
  type: ArbiterAnswerType,
  majority: ArbiterValue | undefined,
  overrule: ArbiterValue,
  truth: ArbiterValue,
  tol = DEFAULT_ARBITER_POLICY.numberTolerance,
): boolean | undefined {
  if (type === "number") {
    const t = Number(truth);
    if (!Number.isFinite(t)) return undefined;
    const e = Math.abs(Number(overrule) - t);
    const m = majority === undefined ? Number.POSITIVE_INFINITY : Math.abs(Number(majority) - t);
    return e < m && !(majority !== undefined && sameNumber(Number(majority), t, tol));
  }
  const right = sameAnswer(type, overrule, truth, tol);
  const majorityRight = majority !== undefined && sameAnswer(type, majority, truth, tol);
  return right && !majorityRight;
}
