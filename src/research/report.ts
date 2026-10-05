// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Research reports: a long-form, cited report for any research task, built on
 * the same retrieval and citation check as forecasting (`src/arena/research`).
 *
 *   plan     the lead turns the task into sections (mirroring any structure
 *            the task asks for), each with a goal and web queries;
 *   research each section's queries through a `Retriever` (normally the
 *            `search` retriever: every query through the backend chain,
 *            guarded page reads, passages quoted verbatim, paid calls in the
 *            spend ledger); then ONE gap round: the lead names what is still
 *            missing and the retriever runs its queries;
 *   verify   every evidence line goes through the mechanical citation check
 *            (`verifyDossier`); only verified passages become evidence, each
 *            under a global source number;
 *   write    the lead writes each section from its numbered evidence with
 *            `[n]` citations, then the opening and conclusion from the
 *            sections; markers are renumbered by first use and a reference
 *            list (`[n] url - title`) is appended;
 *   audit    every cited sentence's figures are checked against the evidence
 *            it cites (`auditCitations`).
 *
 * A cross-model fact and citation pass is a separate step (`./fact-pass.ts`)
 * applied to a finished report, so a run with and without it shares the same
 * research and draft. Same-model self-review is deliberately not offered.
 *
 * One model can do every step (plan, gaps, writing). Every model step that
 * returns junk fails soft: no plan ⇒ one section on the task itself; no gap
 * queries ⇒ no second round; a failed section ⇒ a one-line gap notice in its
 * place (counted). Nothing here is benchmark-specific: a task is a prompt plus
 * optional barred sources.
 */

import type { ResearchBrief, SourceExclusion } from "../arena/research/briefs";
import type { ResearchReport, Retriever } from "../arena/research/retrieve";
import { defaultPageText, type PageText, quoteBody, verifyDossier } from "../arena/research/verify";
import { extractJsonValue } from "../repair/output-repair";
import {
  auditCitations,
  type CitationAudit,
  type Evidence,
  type NumberedSource,
  normalizeCitationMarkers,
  referenceList,
  renumberCitations,
} from "./citations";
import {
  FRAME_SYSTEM,
  GAP_SYSTEM,
  languageName,
  PLAN_SYSTEM,
  SECTION_SYSTEM,
  sectionLength,
} from "./prompts";

export type Complete = (system: string, user: string) => Promise<string>;

export interface ReportModel {
  /** `provider/model`, for the audit trail. */
  name: string;
  complete: Complete;
}

export interface ReportTask {
  /** The task as the requester wrote it. */
  prompt: string;
  /** `en`, `zh`, …; detected from the prompt when absent. */
  language?: string;
  /** Sources the research must not use or cite. */
  exclude?: SourceExclusion;
}

export interface ReportOptions {
  lead: ReportModel;
  retriever: Retriever;
  /** Reads a cited page for the citation check when a source carries no text (default: guarded fetch). */
  pageText?: PageText;
  /** Sections planned at most (default 8). */
  maxSections?: number;
  /** Queries per section in the first round (default 6). */
  queriesPerSection?: number;
  /** Run the gap round (default true). */
  gapRound?: boolean;
  /** Evidence characters per retrieval (default 12 000). */
  evidenceChars?: number;
  /** Sections researched and written at once (default 3). */
  concurrency?: number;
  /** Lessons to show the planner (a pre-formatted block; the caller recalls them). */
  lessons?: string;
  log?: (line: string) => void;
}

export interface PlannedSection {
  heading: string;
  goal: string;
  queries: string[];
}

export interface ReportPlan {
  title: string;
  timeframe?: string;
  /** The task fixes the report's sections: no summary or conclusion sections are added around them. */
  fixedStructure?: boolean;
  sections: PlannedSection[];
  /** True when the plan reply was unusable and the task itself became the one section. */
  fallback?: boolean;
}

export interface SectionAudit {
  heading: string;
  queries: string[];
  gapQueries: string[];
  /** Evidence passages kept (verified) for this section. */
  evidence: number;
  /** Evidence lines the citation check did not verify (dropped). */
  dropped: number;
  searches: number;
  /** Funnel numbers from the retriever, summed over rounds. */
  pagesRead: number;
  excluded: number;
  words: number;
  failed?: string;
}

export interface ResearchReportResult {
  language: string;
  plan: ReportPlan;
  /** The finished report: markdown with `[n]` markers and the reference list. */
  markdown: string;
  /** The body without the reference list (what a fact pass edits). */
  body: string;
  sources: NumberedSource[];
  /** Every verified passage, numbered as in `sources` (the fact pass and the audit read these). */
  evidence: Evidence[];
  sections: SectionAudit[];
  citations: CitationAudit;
  searchUsd: number;
  searches: number;
  warnings: string[];
}

const DEFAULT_MAX_SECTIONS = 8;
const DEFAULT_QUERIES = 6;
const DEFAULT_EVIDENCE_CHARS = 12_000;
/** Characters of a section's evidence shown to the gap reviewer. */
const GAP_VIEW_CHARS = 9_000;
/** Characters of evidence shown to a section writer. */
const WRITER_EVIDENCE_CHARS = 40_000;

/** `zh` when the text is mostly CJK (ten or more CJK characters, at least a third of the Latin letters), else `en`. */
export function detectLanguage(text: string): string {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk >= 10 && cjk * 3 >= latin ? "zh" : "en";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strings(v: unknown, max: number): string[] {
  return Array.isArray(v)
    ? [...new Set(v.map(str).filter((s) => s.length > 1))].slice(0, max).map((s) => s.slice(0, 300))
    : [];
}

/** Parse the planner's reply; undefined when it has no usable section. */
export function parsePlan(
  reply: string,
  maxSections: number,
  queriesPerSection: number,
): ReportPlan | undefined {
  const v = extractJsonValue(reply) as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object") return undefined;
  const sections = (Array.isArray(v.sections) ? v.sections : [])
    .map((s) => s as Record<string, unknown>)
    .map((s) => ({
      heading: str(s?.heading).replace(/^#+\s*/, ""),
      goal: str(s?.goal),
      queries: strings(s?.queries, queriesPerSection),
    }))
    .filter((s) => s.heading && s.queries.length > 0)
    .slice(0, maxSections);
  if (sections.length === 0) return undefined;
  const timeframe = str(v.timeframe);
  return {
    title: str(v.title),
    ...(timeframe ? { timeframe } : {}),
    ...(v.fixedStructure === true ? { fixedStructure: true } : {}),
    sections,
  };
}

async function pool<T>(items: T[], n: number, run: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, n), items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) await run(items[i]!, i);
    }),
  );
}

/** One evidence line as the `search` retriever writes it: `- <date> — "<quote>" [title](url)`. */
const LINE = /^-\s*(\d{4}-\d{2}-\d{2}|undated)\s*[—–-]\s*"(.*)"\s*\[([^\]]*)\]\((\S+)\)\s*$/;

interface RawEvidence {
  url: string;
  title: string;
  quote: string;
  date?: string;
}

/** Verified evidence lines of one retrieval (lines the check did not verify are counted, not kept). */
async function verifiedEvidence(
  report: ResearchReport,
  pageText: PageText,
): Promise<{ kept: RawEvidence[]; dropped: number }> {
  const checked = await verifyDossier(report.report, pageText, report.sources);
  const verified = new Set(checked.verifiedText.split("\n").filter(Boolean));
  const kept: RawEvidence[] = [];
  let dropped = 0;
  for (const line of report.report.split("\n")) {
    const link = line.match(/\[([^\]]*)\]\((https?:\/\/\S+?)\)/);
    if (!link) continue;
    if (!verified.has(line)) {
      dropped++;
      continue;
    }
    const m = line.match(LINE);
    // The `search` retriever's quote lines parse exactly; any other cited line keeps its claim.
    const quote = m ? m[2]! : quoteBody(line);
    if (!quote) continue;
    const date = m?.[1] && m[1] !== "undated" ? m[1] : undefined;
    kept.push({
      url: m ? m[4]! : link[2]!,
      title: m ? m[3]! : link[1]!,
      quote,
      ...(date ? { date } : {}),
    });
  }
  return { kept, dropped };
}

/** Global source numbering shared by every section. */
class SourceBook {
  private byUrl = new Map<string, NumberedSource>();
  private quotes = new Set<string>();
  readonly evidence: Evidence[] = [];

  add(e: RawEvidence): Evidence | undefined {
    let s = this.byUrl.get(e.url);
    if (!s) {
      s = { n: this.byUrl.size + 1, url: e.url, ...(e.title ? { title: e.title } : {}) };
      this.byUrl.set(e.url, s);
    }
    const key = `${s.n}\u0000${e.quote}`;
    if (this.quotes.has(key)) return undefined;
    this.quotes.add(key);
    const ev: Evidence = { n: s.n, quote: e.quote, ...(e.date ? { date: e.date } : {}) };
    this.evidence.push(ev);
    return ev;
  }

  get sources(): NumberedSource[] {
    return [...this.byUrl.values()];
  }

  title(n: number): string | undefined {
    for (const s of this.byUrl.values()) if (s.n === n) return s.title;
    return undefined;
  }
}

/**
 * Evidence as `[n] title (date): "quote"` lines within a budget, fair across
 * sources: every source's first passage is taken before any source's second
 * (sources in order of first appearance), so a budget never silently drops a
 * whole source a reader is about to check. Lines come out grouped by source.
 */
export function evidenceBlock(
  evidence: readonly Evidence[],
  title: (n: number) => string | undefined,
  maxChars: number,
): string {
  const bySource = new Map<number, Evidence[]>();
  for (const e of evidence) bySource.set(e.n, [...(bySource.get(e.n) ?? []), e]);
  const taken = new Map<number, string[]>();
  let chars = 0;
  for (let round = 0, more = true; more; round++) {
    more = false;
    for (const [n, list] of bySource) {
      const e = list[round];
      if (!e) continue;
      more = true;
      const line = `[${n}] ${title(n) ?? "source"}${e.date ? ` (${e.date})` : ""}: "${e.quote}"`;
      if (chars + line.length > maxChars) continue;
      taken.set(n, [...(taken.get(n) ?? []), line]);
      chars += line.length + 1;
    }
  }
  return [...taken.values()].flat().join("\n");
}

function words(text: string): number {
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length;
  const latin = text
    .replace(/[㐀-鿿]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  // A CJK character counts as about half a word for length bookkeeping.
  return latin + Math.round(cjk / 2);
}

function brief(
  task: ReportTask,
  section: PlannedSection,
  queries: string[],
  evidenceChars: number,
  id: string,
): ResearchBrief {
  const now = new Date().toISOString();
  return {
    roundId: id,
    since: "1900-01-01",
    request: `${section.heading}: ${section.goal}\n${task.prompt.slice(0, 2_000)}`,
    queries,
    maxChars: evidenceChars,
    untilAt: now,
    ...(task.exclude ? { exclude: task.exclude } : {}),
  };
}

/**
 * Plan, research, verify and write a report for `task` (see the module
 * comment). Throws only when retrieval fails for every section or the lead
 * cannot write any section; partial failures are recorded in `warnings`.
 */
export async function writeResearchReport(
  task: ReportTask,
  opts: ReportOptions,
): Promise<ResearchReportResult> {
  const log = opts.log ?? (() => undefined);
  const language = task.language ?? detectLanguage(task.prompt);
  const maxSections = opts.maxSections ?? DEFAULT_MAX_SECTIONS;
  const queriesPerSection = opts.queriesPerSection ?? DEFAULT_QUERIES;
  const evidenceChars = opts.evidenceChars ?? DEFAULT_EVIDENCE_CHARS;
  const concurrency = opts.concurrency ?? 3;
  const pageText = opts.pageText ?? defaultPageText();
  const warnings: string[] = [];
  const barredTitles = task.exclude?.titles ?? [];

  // ── Plan ──────────────────────────────────────────────────────────────
  const planUser = [
    `Report language: ${languageName(language)}.`,
    opts.lessons
      ? `Lessons from earlier research work (apply where relevant):\n${opts.lessons}`
      : "",
    `Plan at most ${maxSections} sections with up to ${queriesPerSection} queries each.`,
    `TASK:\n${task.prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  let plan: ReportPlan | undefined;
  try {
    plan = parsePlan(
      await opts.lead.complete(PLAN_SYSTEM, planUser),
      maxSections,
      queriesPerSection,
    );
  } catch (err) {
    warnings.push(`plan failed: ${(err as Error).message.slice(0, 160)}`);
  }
  if (!plan) {
    warnings.push("plan unusable: the task is one section");
    plan = {
      title: "",
      fallback: true,
      sections: [
        {
          heading: "Findings",
          goal: task.prompt.slice(0, 500),
          queries: [task.prompt.slice(0, 200)],
        },
      ],
    };
  }
  log(
    `plan: ${plan.sections.length} sections${plan.timeframe ? ` · timeframe ${plan.timeframe}` : ""}`,
  );

  // ── Research (two rounds per section) and verification ────────────────
  const book = new SourceBook();
  const sectionEvidence: Evidence[][] = plan.sections.map(() => []);
  const audits: SectionAudit[] = plan.sections.map((s) => ({
    heading: s.heading,
    queries: s.queries,
    gapQueries: [],
    evidence: 0,
    dropped: 0,
    searches: 0,
    pagesRead: 0,
    excluded: 0,
    words: 0,
  }));
  let searchUsd = 0;
  let retrievalFailures = 0;
  const retrieve = async (i: number, queries: string[], round: string) => {
    const section = plan.sections[i]!;
    const audit = audits[i]!;
    try {
      const report = await opts.retriever(
        brief(task, section, queries, evidenceChars, `report-s${i + 1}-${round}`),
      );
      searchUsd += report.costUsd;
      audit.searches += report.searches;
      for (const f of report.funnels ?? []) {
        audit.pagesRead += f.read;
        audit.excluded += f.excluded ?? 0;
      }
      const { kept, dropped } = await verifiedEvidence(report, pageText);
      audit.dropped += dropped;
      for (const e of kept) {
        const ev = book.add(e);
        if (ev) sectionEvidence[i]!.push(ev);
      }
      audit.evidence = sectionEvidence[i]!.length;
    } catch (err) {
      retrievalFailures++;
      warnings.push(
        `research failed (${section.heading}, ${round}): ${(err as Error).message.slice(0, 160)}`,
      );
    }
  };
  await pool(plan.sections, concurrency, async (section, i) => {
    await retrieve(i, section.queries, "r1");
    if (opts.gapRound === false) return;
    const seen = evidenceBlock(sectionEvidence[i]!, (n) => book.title(n), GAP_VIEW_CHARS);
    try {
      const reply = await opts.lead.complete(
        GAP_SYSTEM,
        [
          `Report language: ${languageName(language)}.`,
          `Section: ${section.heading}\nGoal: ${section.goal}`,
          `Evidence so far:\n${seen || "(none)"}`,
        ].join("\n\n"),
      );
      const v = extractJsonValue(reply) as Record<string, unknown> | undefined;
      const queries = strings(v?.queries, 4).filter((q) => !section.queries.includes(q));
      audits[i]!.gapQueries = queries;
      if (queries.length) await retrieve(i, queries, "r2");
    } catch (err) {
      warnings.push(
        `gap round failed (${section.heading}): ${(err as Error).message.slice(0, 160)}`,
      );
    }
    log(`researched ${i + 1}/${plan.sections.length}: ${audits[i]!.evidence} passages`);
  });
  if (retrievalFailures > 0 && book.evidence.length === 0) {
    throw new Error(
      `research report: retrieval failed for every section (${warnings.join("; ").slice(0, 400)})`,
    );
  }

  // ── Write sections ──────────────────────────────────────────────────────
  const outline = plan.sections.map((s, i) => `${i + 1}. ${s.heading} — ${s.goal}`).join("\n");
  const length = sectionLength(language, plan.sections.length);
  const scope = plan.timeframe
    ? `The task limits the information to: ${plan.timeframe}. Respect this scope and say so where it matters.`
    : "";
  const barred = barredTitles.length
    ? `Never name, use or cite these barred sources: ${barredTitles.join("; ")}.`
    : "";
  const texts: string[] = plan.sections.map(() => "");
  let writeFailures = 0;
  await pool(plan.sections, concurrency, async (section, i) => {
    const ev = evidenceBlock(sectionEvidence[i]!, (n) => book.title(n), WRITER_EVIDENCE_CHARS);
    const user = [
      `Report language: ${languageName(language)}. Length: ${length}.`,
      scope,
      barred,
      `TASK:\n${task.prompt}`,
      `REPORT OUTLINE:\n${outline}`,
      `WRITE SECTION ${i + 1}: ${section.heading}\nGoal: ${section.goal}`,
      `NUMBERED EVIDENCE:\n${ev || "(no evidence was found for this section)"}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      let text = normalizeCitationMarkers((await opts.lead.complete(SECTION_SYSTEM, user)).trim());
      if (!/^##\s/m.test(text.split("\n")[0] ?? "")) text = `## ${section.heading}\n\n${text}`;
      texts[i] = text;
      audits[i]!.words = words(text);
    } catch (err) {
      writeFailures++;
      audits[i]!.failed = (err as Error).message.slice(0, 160);
      texts[i] =
        `## ${section.heading}\n\n${language === "zh" ? "（本节未能完成。）" : "(This section could not be completed.)"}`;
    }
    log(`wrote ${i + 1}/${plan.sections.length}: ${audits[i]!.words} words`);
  });
  if (writeFailures === plan.sections.length) {
    throw new Error(`research report: every section failed to write (${audits[0]?.failed ?? ""})`);
  }

  // ── Opening and conclusion ───────────────────────────────────────────────
  const bodySections = texts.join("\n\n");
  let title = plan.title;
  let summary = "";
  let conclusion = "";
  try {
    const v = extractJsonValue(
      await opts.lead.complete(
        FRAME_SYSTEM,
        [
          `Report language: ${languageName(language)}.`,
          scope,
          `TASK:\n${task.prompt}`,
          `SECTIONS:\n${bodySections}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    ) as Record<string, unknown> | undefined;
    title = str(v?.title) || title;
    summary = normalizeCitationMarkers(str(v?.summary));
    conclusion = normalizeCitationMarkers(str(v?.conclusion));
  } catch (err) {
    warnings.push(`opening/conclusion failed: ${(err as Error).message.slice(0, 160)}`);
  }
  const zh = language === "zh";
  // A task that fixes the report's sections gets exactly those: the summary
  // becomes an unheaded opening and no conclusion section is added.
  const fixed = plan.fixedStructure === true;
  const draft = [
    `# ${title || task.prompt.split("\n")[0]!.slice(0, 120)}`,
    summary ? (fixed ? summary : `## ${zh ? "摘要" : "Executive summary"}\n\n${summary}`) : "",
    bodySections,
    conclusion && !fixed ? `## ${zh ? "结论" : "Conclusion"}\n\n${conclusion}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return finishReport({
    language,
    plan,
    draft,
    sources: book.sources,
    evidence: book.evidence,
    sections: audits,
    searchUsd,
    searches: audits.reduce((s, a) => s + a.searches, 0),
    warnings,
  });
}

/**
 * Renumber citations by first use, append the reference list and audit the
 * citations. Shared by the writer and the fact pass (which edits `body`).
 */
export function finishReport(input: {
  language: string;
  plan: ReportPlan;
  draft: string;
  sources: NumberedSource[];
  evidence: Evidence[];
  sections: SectionAudit[];
  searchUsd: number;
  searches: number;
  warnings: string[];
}): ResearchReportResult {
  const { text: body, sources } = renumberCitations(input.draft, input.sources);
  // Evidence follows the new numbering; sources never cited drop out.
  const renumber = new Map<number, number>();
  for (const s of sources) {
    const old = input.sources.find((o) => o.url === s.url);
    if (old) renumber.set(old.n, s.n);
  }
  const evidence = input.evidence
    .filter((e) => renumber.has(e.n))
    .map((e) => ({ ...e, n: renumber.get(e.n)! }));
  const references = referenceList(sources, input.language === "zh" ? "参考文献" : "References");
  return {
    language: input.language,
    plan: input.plan,
    body,
    markdown: references ? `${body.trimEnd()}\n\n${references}` : body,
    sources,
    evidence,
    sections: input.sections,
    citations: auditCitations(body, evidence),
    searchUsd: input.searchUsd,
    searches: input.searches,
    warnings: input.warnings,
  };
}
