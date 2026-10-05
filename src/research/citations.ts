// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Citations in a research report: numbered evidence, `[n]` markers in the
 * prose, the reference list, and a mechanical audit of what each cited
 * sentence claims against the evidence it cites.
 *
 * The audit is deterministic and model-free: every figure in a cited sentence
 * (percentages, decimals, numbers of three or more digits that are not years —
 * `figuresIn`) must appear in the quoted evidence of at least one source the
 * sentence cites. That is the same test the forecasting dossier applies, run
 * on the report's own sentences. It measures citation precision for figures;
 * a figureless sentence is counted but not checked (a model judge — or the
 * benchmark's own FACT pipeline — is needed for those).
 */

import { figuresIn, figuresMissing } from "../arena/research/verify";

/** One quoted passage from a source page, as the retriever read it. */
export interface Evidence {
  /** Source number (`[n]` in the report). */
  n: number;
  /** The passage, verbatim from the page. */
  quote: string;
  /** Publication date when the page reported one (ISO day). */
  date?: string;
}

export interface NumberedSource {
  n: number;
  url: string;
  title?: string;
}

/** `[3, 7]` / `[3,7]` / `【3】` / `[3-5]` → `[3][7]` / `[3][4][5]`. Other brackets are left alone. */
export function normalizeCitationMarkers(text: string): string {
  return text
    .replace(/【(\d+)】/g, "[$1]")
    .replace(/\[(\d+(?:\s*[,，;]\s*\d+)+)\]/g, (_, list: string) =>
      list
        .split(/\s*[,，;]\s*/)
        .map((n) => `[${n}]`)
        .join(""),
    )
    .replace(/\[(\d+)\s*[-–]\s*(\d+)\]/g, (whole, a: string, b: string) => {
      const lo = Number(a);
      const hi = Number(b);
      if (!(hi > lo) || hi - lo > 10) return whole;
      return Array.from({ length: hi - lo + 1 }, (_, i) => `[${lo + i}]`).join("");
    });
}

const MARKER = /\[(\d+)\]/g;

/** The source numbers a piece of text cites, in order, de-duplicated. */
export function citedNumbers(text: string): number[] {
  return [...new Set([...text.matchAll(MARKER)].map((m) => Number(m[1])))];
}

/**
 * Renumber `[n]` markers in order of first appearance, keeping only numbers
 * that exist in `sources`; markers for unknown numbers are removed. Returns
 * the rewritten text and the sources it cites, in their new order.
 */
export function renumberCitations(
  text: string,
  sources: readonly NumberedSource[],
): { text: string; sources: NumberedSource[] } {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const map = new Map<number, number>();
  const out: NumberedSource[] = [];
  const rewritten = text.replace(MARKER, (_, raw: string) => {
    const old = Number(raw);
    const src = byN.get(old);
    if (!src) return "";
    let next = map.get(old);
    if (next === undefined) {
      next = out.length + 1;
      map.set(old, next);
      out.push({ ...src, n: next });
    }
    return `[${next}]`;
  });
  return { text: rewritten, sources: out };
}

/**
 * The reference list in the form DeepResearch Bench's FACT extractor reads
 * (and any reader expects): one `[n] url - title` line per cited source.
 */
export function referenceList(sources: readonly NumberedSource[], heading = "References"): string {
  if (sources.length === 0) return "";
  const lines = sources.map(
    (s) => `[${s.n}] ${s.url}${s.title ? ` - ${oneLineTitle(s.title)}` : ""}`,
  );
  return `## ${heading}\n\n${lines.join("\n")}\n`;
}

function oneLineTitle(t: string): string {
  return t.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Sentences of prose: Latin ends need a following space; CJK ends do not. Headings and table rows are units of their own. */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    const l = line.trim();
    if (!l) continue;
    if (/^#|^\|/.test(l)) {
      out.push(l);
      continue;
    }
    // A citation marker after the full stop belongs to the sentence before it.
    for (const s of l.split(/(?<=[.!?](?:\[\d+\])*)\s+(?=\S)|(?<=[。！？](?:\[\d+\])*)/)) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

export interface CitationAudit {
  /** Sentences (and table rows) with at least one `[n]`. */
  citedSentences: number;
  /** Cited sentences with figures, every figure found in the cited evidence. */
  figuresVerified: number;
  /** Cited sentences with a figure found in none of the cited sources' evidence. */
  figuresUnverified: number;
  /** Cited sentences without figures (not checkable mechanically). */
  figureless: number;
  /** Sentences that state figures but cite nothing. */
  uncitedFigures: number;
  /** Markers that point at a number with no evidence. */
  danglingMarkers: number;
  /** Distinct sources cited. */
  sourcesCited: number;
  /** figuresVerified / (figuresVerified + figuresUnverified), or undefined with none checked. */
  figurePrecision?: number;
  /** Up to 20 unverified sentences (for the audit trail; clipped). */
  unverifiedSamples: Array<{ sentence: string; missing: string[] }>;
}

/** Strip `[n]` markers before reading figures, so `[123]` is never read as a figure. */
function withoutMarkers(s: string): string {
  return s.replace(MARKER, " ");
}

/**
 * Audit a written report against its evidence (see the module comment).
 * `evidence` is every quoted passage, keyed by source number.
 */
export function auditCitations(text: string, evidence: readonly Evidence[]): CitationAudit {
  const bySource = new Map<number, string[]>();
  for (const e of evidence) {
    const list = bySource.get(e.n) ?? [];
    list.push(e.quote);
    bySource.set(e.n, list);
  }
  const audit: CitationAudit = {
    citedSentences: 0,
    figuresVerified: 0,
    figuresUnverified: 0,
    figureless: 0,
    uncitedFigures: 0,
    danglingMarkers: 0,
    sourcesCited: 0,
    unverifiedSamples: [],
  };
  const cited = new Set<number>();
  for (const sentence of sentencesOf(text)) {
    if (/^#/.test(sentence)) continue;
    const ns = citedNumbers(sentence);
    const bare = withoutMarkers(sentence);
    const figures = figuresIn(bare);
    if (ns.length === 0) {
      if (figures.length > 0) audit.uncitedFigures++;
      continue;
    }
    audit.citedSentences++;
    for (const n of ns) {
      if (bySource.has(n)) cited.add(n);
      else audit.danglingMarkers++;
    }
    if (figures.length === 0) {
      audit.figureless++;
      continue;
    }
    const pages = ns.flatMap((n) => bySource.get(n) ?? []);
    const missing = figuresMissing(bare, pages);
    if (missing.length === 0) audit.figuresVerified++;
    else {
      audit.figuresUnverified++;
      if (audit.unverifiedSamples.length < 20)
        audit.unverifiedSamples.push({ sentence: sentence.slice(0, 300), missing });
    }
  }
  audit.sourcesCited = cited.size;
  const checked = audit.figuresVerified + audit.figuresUnverified;
  if (checked > 0) audit.figurePrecision = audit.figuresVerified / checked;
  return audit;
}
