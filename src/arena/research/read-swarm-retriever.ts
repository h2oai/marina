// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Any research `Retriever` with a read swarm on top (`src/retrieval/read-swarm.ts`):
 * the inner retriever searches as before; reader models then read every page
 * it found IN FULL (not the engine's snippet) against the brief's queries as
 * clues, and the report leads with what they verified — one dossier line per
 * quote, copied verbatim from the page and cited to it, so the dossier's
 * citation check (`verifyDossier`) passes it by construction — followed by the
 * inner report unchanged. The pages' text rides on the sources, so the check
 * reads exactly what the readers read.
 *
 * Off unless an operator names a reader model (`MARINA_READ_SWARM_READER`); a
 * reader outage leaves the inner report as it was. Date-strictness is
 * preserved: the readers only read pages the inner retriever returned.
 */

import { getCorpusDocument, parseCorpusUrl } from "../../engine/search-providers/corpus";
import type { FirstMoveModel } from "../../retrieval/first-move";
import { type DocReading, ReadSwarm } from "../../retrieval/read-swarm";
import { isDateStrict, type ResearchReport, type Retriever, type Source } from "./retrieve";
import { defaultPageText, fetchAllowed, MIN_QUOTE_CHARS, type PageText } from "./verify";

export interface ReadSwarmRetrieverOptions {
  reader: FirstMoveModel;
  /** Decompose the request into clues (default: the brief's queries are the clues). */
  decompose?: boolean;
  /** Pages read per brief (default 24). */
  maxDocs?: number;
  /** Characters per reader call (default 32,000). */
  chunkChars?: number;
  /** Reader calls in flight (default 8). */
  concurrency?: number;
  /** Reads a page the inner retriever returned without text (default: a guarded fetch). */
  pageText?: PageText;
  /** The readers' spend so far, so each report carries its own cost. */
  spent?: () => number;
}

/** Dossier lines carried per brief (the most clues first). */
const MAX_LINES = 40;

function linkTitle(title: string): string {
  return title.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "source";
}

/** One cited line per verified quote: `- "<quote>" [title](url)`, clue-bearing readings first. */
export function swarmDossierLines(
  readings: readonly DocReading[],
  titles: ReadonlyMap<string, string | undefined>,
): string[] {
  const lines: string[] = [];
  const ordered = [...readings].sort((a, b) => b.clues.length - a.clues.length);
  for (const r of ordered) {
    for (const q of r.quotes) {
      if (!q.verified || q.text.replace(/\s+/g, " ").trim().length < MIN_QUOTE_CHARS) continue;
      const quote = q.text.replace(/\s+/g, " ").replace(/"/g, "'").trim();
      lines.push(`- "${quote}" [${linkTitle(titles.get(r.id) ?? r.title ?? r.id)}](${r.id})`);
    }
  }
  return lines.slice(0, MAX_LINES);
}

export function readSwarmRetriever(inner: Retriever, opts: ReadSwarmRetrieverOptions): Retriever {
  const pageText = opts.pageText ?? defaultPageText();
  const wrapped: Retriever = async (brief) => {
    const base = await inner(brief);
    const before = opts.spent?.() ?? 0;
    const texts = new Map<string, string>();
    const titles = new Map<string, string | undefined>();
    for (const s of base.sources) {
      titles.set(s.url, s.title);
      if (s.text) texts.set(s.url, s.text);
    }
    const question = brief.request.slice(0, 2000);
    const clues = (brief.queries ?? []).map((q) => q.trim()).filter(Boolean);
    const swarm = new ReadSwarm(question, {
      search: async () => [],
      read: async (url, offset, maxChars) => {
        // A local corpus document is read whole from the corpus, not from the source's lead.
        const local = parseCorpusUrl(url);
        if (local) {
          const doc = getCorpusDocument(local.name, local.docid, { offset, maxChars });
          if (doc && offset === 0) texts.set(url, doc.text);
          return doc
            ? {
                id: url,
                ...(doc.title ? { title: doc.title } : {}),
                text: doc.text,
                totalChars: doc.totalChars,
              }
            : undefined;
        }
        let text = texts.get(url);
        if (text === undefined && fetchAllowed(url)) {
          text = (await pageText(url)) ?? "";
          texts.set(url, text);
        }
        return text
          ? { id: url, text: text.slice(offset, offset + maxChars), totalChars: text.length }
          : undefined;
      },
      reader: opts.reader,
      ...(opts.decompose || clues.length === 0 ? { decomposer: opts.reader } : { clues }),
      maxDocs: opts.maxDocs ?? 24,
      ...(opts.chunkChars ? { chunkChars: opts.chunkChars } : {}),
      ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    });
    if (opts.decompose || clues.length === 0) await swarm.open().catch(() => undefined);
    const pages = base.sources.filter((s) => /^(https?|corpus):\/\//.test(s.url));
    await swarm.readMany(
      pages.map((s) => ({ id: s.url, ...(s.title ? { title: s.title } : {}), text: "" })),
    );
    const readings = swarm.readings();
    const lines = swarmDossierLines(readings, titles);
    const cost = Math.max(0, (opts.spent?.() ?? before) - before);
    const st = swarm.stats();
    const sources: Source[] = base.sources.map((s) => {
      const text = texts.get(s.url);
      return text && !s.text ? { ...s, text } : s;
    });
    const out: ResearchReport = {
      ...base,
      report: lines.length
        ? [
            `Read swarm: ${st.docsRead} pages read in full, ${st.quotesVerified} quotes verified verbatim:`,
            ...lines,
            "",
            base.report,
          ].join("\n")
        : base.report,
      sources,
      costUsd: base.costUsd + cost,
      retriever: `${base.retriever}+read-swarm`,
      ...(st.readerFailures > 0 && st.readerFailures >= st.readerCalls
        ? { warnings: [...(base.warnings ?? []), "read swarm: every reader call failed"] }
        : {}),
    };
    return out;
  };
  return isDateStrict(inner) ? Object.assign(wrapped, { dateStrict: true as const }) : wrapped;
}
