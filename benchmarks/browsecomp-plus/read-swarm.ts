// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `read-swarm` formation: Marina's general read swarm
 * (`src/retrieval/read-swarm.ts`) over the BrowseComp-Plus corpus.
 *
 *   opening   decompose the question into clues, search each clue (and the
 *             question) `depth` deep, fuse, rerank with the reader model, and
 *             read the best documents IN FULL with parallel reader calls;
 *   lead      one agent (any model, `--lead-model`) gets the candidate table
 *             and keeps researching with two tools: `search`, whose top `k`
 *             documents are read in full by the readers before the lead sees
 *             them (it gets each document's clues, candidate and verified
 *             quotes, not a snippet; snippets once the read budget is spent),
 *             and the official `get_document` for its own targeted reads. It
 *             answers in the official format; with `--final-answer` the turn
 *             cap ends in a labelled forced answer.
 *
 * The readers are the arm's `--model` unless `--reader-model` names another;
 * every call goes through the same Marina endpoint and spend guard. The run
 * record keeps every step: `first_move_search` (the documents the opening
 * read), one `swarm_read` per document read (docid, clues, whether a
 * candidate was named — no text), the lead's searches and reads, and the
 * answer. Recall counts the documents shown to the lead, as for any agent.
 */

import type { Candidate, FirstMoveModel } from "../../src/retrieval/first-move";
import {
  type DocReading,
  ReadSwarm,
  readingSummary,
  renderCandidateTable,
} from "../../src/retrieval/read-swarm";
import { BudgetExhausted } from "../call-spend-guard";
import {
  type AgentOptions,
  type ChatEndpoint,
  endpointModel,
  executeTool,
  localBackend,
  type QueryRun,
  toolLoop,
  toolSchemas,
} from "./agent";
import { queryPrompt } from "./official";

export interface SwarmSettings {
  /** Reader model (default: the arm's model). */
  readerModel?: string;
  /** Decompose the question into clues (default true; false = the question is the only clue). */
  decompose?: boolean;
  /** Documents read in the opening (default 16). */
  openDocs?: number;
  /** Read budget: documents per query (default 60). */
  maxDocs?: number;
  /** Characters per reader call (default 32,000). */
  chunkChars?: number;
  /** Reader calls in flight per query (default 8). */
  concurrency?: number;
  /** Per-clue search depth in the opening (default 50). */
  depth?: number;
}

/** The settings as recorded in run metadata and the arm configuration. */
export function swarmLabel(s: SwarmSettings, armModel: string): Record<string, unknown> {
  return {
    reader_model: s.readerModel ?? armModel,
    decompose: s.decompose !== false,
    open_docs: s.openDocs ?? 16,
    max_docs: s.maxDocs ?? 60,
    chunk_chars: s.chunkChars ?? 32_000,
    depth: s.depth ?? 50,
  };
}

const SEARCH_DESCRIPTION = (k: number) =>
  `Search the collection. The top ${k} documents are READ IN FULL by research assistants before you see them: for each you get the clues it satisfies (with verified verbatim quotes), the candidate answer it names, and a note — or a snippet once the reading budget is spent. Also returns the leading candidates so far.`;

function leadTools(k: number) {
  const [search, getDocument] = toolSchemas(k) as [
    { type: string; function: { name: string; description: string; parameters: unknown } },
    unknown,
  ];
  return [
    { ...search, function: { ...search.function, description: SEARCH_DESCRIPTION(k) } },
    getDocument,
  ];
}

export function swarmLeadPrompt(question: string, table: string, budget: string): string {
  return [
    queryPrompt(question),
    "",
    "Research assistants have already split the question into clues and read the most relevant documents in full. What they found (quotes are verified verbatim against the documents):",
    "",
    table,
    "",
    `Your search tool is backed by the same assistants: each search's top documents are read in full against the clues. Check the leading candidate against EVERY clue — search for clues no candidate covers yet — and use get_document to verify a document yourself. ${budget}`,
  ].join("\n");
}

/** Run one query through the read swarm and its lead. */
export async function runReadSwarm(
  ep: ChatEndpoint,
  run: QueryRun,
  question: string,
  opts: AgentOptions,
  models: { model: string; leadModel?: string },
  s: SwarmSettings,
): Promise<{ text?: string; budgetForced?: QueryRun["budgetForced"] }> {
  const backend = opts.backend ?? localBackend(opts.corpus, opts.corpusDir);
  const reader: FirstMoveModel = endpointModel(
    ep,
    s.readerModel ?? models.model,
    run,
    opts.timeoutMs,
  );
  const record = (r: DocReading) =>
    run.record.result.push({
      type: "tool_call",
      tool_name: "swarm_read",
      arguments: JSON.stringify({ docid: r.id, chars: r.charsRead, chunks: r.chunks }),
      output: JSON.stringify({
        docid: r.id,
        relevant: r.relevant,
        clues: r.clues,
        candidate: Boolean(r.candidate),
        quotes: r.quotes.length,
        verified: r.quotes.filter((q) => q.verified).length,
        ...(r.error ? { error: r.error } : {}),
      }),
      agent: "reader",
    });
  const swarm = new ReadSwarm(question, {
    search: async (q, depth): Promise<Candidate[]> =>
      (await backend.search(q, depth, opts.snippetChars)).map((h) => ({
        id: h.docid,
        ...(h.title ? { title: h.title } : {}),
        text: h.window || h.lead,
      })),
    read: async (id, offset, maxChars) => {
      const doc = await backend.get(id, maxChars, offset);
      return doc
        ? {
            id: doc.docid,
            ...(doc.title ? { title: doc.title } : {}),
            text: doc.text,
            ...(doc.totalChars !== undefined ? { totalChars: doc.totalChars } : {}),
          }
        : undefined;
    },
    reader,
    ...(s.decompose !== false ? { decomposer: reader } : {}),
    reranker: reader,
    ...(s.openDocs ? { openDocs: s.openDocs } : {}),
    ...(s.maxDocs ? { maxDocs: s.maxDocs } : {}),
    ...(s.chunkChars ? { chunkChars: s.chunkChars } : {}),
    ...(s.concurrency ? { concurrency: s.concurrency } : {}),
    ...(s.depth ? { depth: s.depth } : {}),
    isFatal: (e) => e instanceof BudgetExhausted,
    onRead: record,
  });
  const opening = await swarm.open();
  run.record.result.push({
    type: "tool_call",
    tool_name: "first_move_search",
    arguments: JSON.stringify({ clues: opening.clues.length, order: opening.order }),
    output: JSON.stringify(opening.read.map((docid) => ({ docid }))),
  });
  const budgetNote = () => {
    const left = swarm.budgetLeft();
    return swarm.exhausted()
      ? "The reading budget is spent: searches now return snippets."
      : `Reading budget left: ${left.docs} documents.`;
  };
  const leaders = () =>
    swarm
      .candidates()
      .slice(0, 5)
      .map((c) => ({ answer: c.answer, clues: c.clues, docs: c.docs.slice(0, 6) }));
  const execute = async (name: string, rawArgs: string): Promise<string | undefined> => {
    if (name !== "search") return undefined; // get_document: the official tool
    let query = "";
    try {
      const args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
      query = typeof args.query === "string" ? args.query : "";
    } catch {
      return JSON.stringify({ error: "arguments must be a JSON object" });
    }
    if (!query.trim()) return JSON.stringify({ error: "query is required" });
    if (swarm.exhausted()) return executeTool(name, rawArgs, opts);
    const found = await swarm.search(query, opts.k);
    return JSON.stringify([
      ...found.hits.map((h, i) => {
        const r = found.readings[i];
        return r
          ? { docid: h.id, read: readingSummary(r) }
          : { docid: h.id, snippet: h.text.slice(0, opts.snippetChars) };
      }),
      { leading_candidates: leaders(), budget: budgetNote() },
    ]);
  };
  const table = renderCandidateTable(swarm.clues, swarm.readings());
  const out = await toolLoop(
    ep,
    models.leadModel ?? models.model,
    [{ role: "user", content: swarmLeadPrompt(question, table, budgetNote()) }],
    opts,
    run,
    { agent: "lead", execute, toolSchemas: leadTools(opts.k) },
  );
  const st = swarm.stats();
  run.record.metadata.swarm_stats = {
    clues: st.clues,
    docs_read: st.docsRead,
    chars_read: st.charsRead,
    reader_calls: st.readerCalls,
    reader_failures: st.readerFailures,
    quotes: st.quotes,
    quotes_verified: st.quotesVerified,
    budget_exhausted: st.budgetExhausted,
    opening_order: opening.order,
  };
  return {
    ...(out.text ? { text: out.text } : {}),
    ...(out.budgetForced ? { budgetForced: out.budgetForced } : {}),
  };
}
