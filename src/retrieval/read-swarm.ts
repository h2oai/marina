// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read swarm: research where cheap reader models read whole documents and a
 * lead never has to. Most failures on hard multi-constraint questions are not
 * retrieval failures — the evidence was in the search results but nobody read
 * it. A read swarm reads it:
 *
 *   1. decompose  the question into atomic clues (`decomposeQuestion`, the
 *                 first move's decomposer; or clues the caller already has);
 *   2. retrieve   per clue (any `search`: BM25, hybrid, the web chain), fuse
 *                 by reciprocal rank, optionally rerank (a listwise model or a
 *                 decision backend), and pick the documents to read — each
 *                 clue's best few first, then the fused order;
 *   3. read       N reader calls in parallel, each over a FULL document in
 *                 chunks (not a snippet), against the numbered clues. A reader
 *                 returns structured evidence: the candidate answer the
 *                 document names, verbatim quotes tagged with the clue each
 *                 supports, a confidence, and whether the rest of the document
 *                 is worth reading (then the next chunk is read). Everything
 *                 is bounded by a per-question read budget (documents ×
 *                 characters);
 *   4. aggregate  quotes are verified mechanically against the text the reader
 *                 saw (`foldForQuote`, the dossier check's folding) — an
 *                 unverified quote supports nothing; candidates are grouped
 *                 by normalised answer and ranked by how many distinct clues
 *                 verified quotes support, then by documents and confidence;
 *   5. hand off   a compact candidate table (`renderCandidateTable`) for a
 *                 lead — any model — which can keep searching through the
 *                 same swarm (`search`: each search's documents are read, not
 *                 previewed) and answers. The lead's own loop and its
 *                 budget-terminal answer stay with the caller.
 *
 * One model can play every part (decomposer, reranker, reader and lead), so
 * the single-LLM tier needs nothing more. Every model step fails open: no
 * clues ⇒ the question is the only clue; a failed reranker ⇒ the fused order;
 * a failed reader ⇒ that document reports nothing. Errors the caller marks
 * fatal (`isFatal`, e.g. a spend stop) propagate.
 *
 * Engine-agnostic and general: callers supply `search` and, optionally,
 * `read` (a document from an offset; without it the search candidate's text
 * is the document). BrowseComp-Plus uses it as the `read-swarm` formation;
 * research retrievers wrap any `Retriever` with it (`readSwarmRetriever` in
 * `src/arena/research/read-swarm-retriever.ts`).
 */

import { foldForQuote } from "../arena/research/verify";
import type { DecisionProvider } from "../decisions/types";
import {
  type Candidate,
  decomposeQuestion,
  type FirstMoveModel,
  fuseRankings,
  jsonObject,
  judgeRerank,
  llmRerank,
} from "./first-move";

export interface SwarmDocument {
  id: string;
  title?: string;
  /** The text from the requested offset. */
  text: string;
  /** The document's full length in characters, when known. */
  totalChars?: number;
}

export interface ReadSwarmOptions {
  /** Searches one query; ranked candidates, best first. */
  search: (query: string, depth: number) => Promise<Candidate[]>;
  /**
   * Reads a document from `offset`, at most `maxChars`. Absent ⇒ the search
   * candidate's own text is the whole document.
   */
  read?: (id: string, offset: number, maxChars: number) => Promise<SwarmDocument | undefined>;
  /** The reader model (cheap; called once per document chunk). */
  reader: FirstMoveModel;
  /** Decomposes the question into clues (none and no `clues` ⇒ the question is the only clue). */
  decomposer?: FirstMoveModel;
  /** Clues the caller already has (a research plan's queries): no decomposition call. */
  clues?: readonly string[];
  /** Listwise reranker for the opening pool (none ⇒ the fused order). */
  reranker?: FirstMoveModel;
  /** Pointwise decision-backend reranker; replaces `reranker` when set. */
  judge?: DecisionProvider;
  /** Results per clue in the opening retrieval (default 50). */
  depth?: number;
  /** Fused candidates the reranker orders (default 30). */
  rerankPool?: number;
  /** Documents read in the opening (default 16). */
  openDocs?: number;
  /** Each clue's top documents always read in the opening (default 2). */
  perClue?: number;
  /** Characters per reader call (default 32,000 ≈ 8k tokens). */
  chunkChars?: number;
  /** Chunks read from one document at most (default 2). */
  maxChunks?: number;
  /** Read budget: documents per question (default 60). */
  maxDocs?: number;
  /** Read budget: characters per question (default 2,000,000). */
  maxChars?: number;
  /** Reader calls in flight at once (default 8). */
  concurrency?: number;
  /** Errors that must stop the swarm instead of failing open (a spend stop). */
  isFatal?: (err: unknown) => boolean;
  /** Called after each document is read (for run records). */
  onRead?: (reading: DocReading) => void;
}

export interface SwarmQuote {
  text: string;
  /** The clue the reader says it supports (1-based), when it named one. */
  clue?: number;
  /** Found verbatim (up to `foldForQuote`) in the text the reader saw. */
  verified: boolean;
}

/** One document as the swarm read it. */
export interface DocReading {
  id: string;
  title?: string;
  /** Characters actually read (all chunks). */
  charsRead: number;
  totalChars?: number;
  chunks: number;
  relevant: boolean;
  /** The answer the document names or identifies, per its reader. */
  candidate?: string;
  /** The candidate's words appear in the text read (not inferred). */
  candidateInText: boolean;
  /** Clues (1-based) backed by at least one verified quote. */
  clues: number[];
  quotes: SwarmQuote[];
  /** Reader's confidence (0–1) that the candidate is the answer. */
  confidence: number;
  note?: string;
  /** The search intent it was read under, when not the opening. */
  focus?: string;
  /** Why the reader produced nothing usable. */
  error?: string;
}

/** One candidate answer, aggregated over every document that names it. */
export interface CandidateRow {
  answer: string;
  key: string;
  /** Distinct clues backed by verified quotes in its documents. */
  clues: number[];
  docs: string[];
  quotes: Array<{ doc: string; clue?: number; text: string }>;
  /** Highest reader confidence. */
  confidence: number;
  /** Some document contains the candidate's words. */
  inText: boolean;
  score: number;
}

export interface SwarmOpening {
  clues: string[];
  /** Documents the opening retrieval surfaced (the reranked pool, best first). */
  surfaced: Candidate[];
  /** Documents read in the opening, in reading order. */
  read: string[];
  order: "reranked" | "judged" | "fused";
  error?: string;
}

export interface SwarmSearch {
  hits: Candidate[];
  /** The reading of each hit (undefined when the budget ran out before it). */
  readings: Array<DocReading | undefined>;
}

export interface SwarmStats {
  clues: number;
  docsRead: number;
  charsRead: number;
  readerCalls: number;
  readerFailures: number;
  quotes: number;
  quotesVerified: number;
  budgetExhausted: boolean;
}

const DEFAULTS = {
  depth: 50,
  rerankPool: 30,
  openDocs: 16,
  perClue: 2,
  chunkChars: 32_000,
  maxChunks: 2,
  maxDocs: 60,
  maxChars: 2_000_000,
  concurrency: 8,
} as const;

/** Smallest remainder of the character budget worth a reader call. */
const MIN_READ_CHARS = 1_000;
/** A quote fragment shorter than this (folded) matches too easily by chance. */
const MIN_QUOTE_PART = 8;
const MAX_QUOTES_PER_CALL = 8;
const MAX_QUOTE_CHARS = 400;

export const READER_SYSTEM = [
  "You read ONE document for a research team answering a hard question. Judge only from the document text, never from memory.",
  'Reply with ONE JSON object: {"relevant": true|false, "candidate": "<the answer to the question if this document names or identifies it, else empty>", "evidence": [{"clue": <clue number>, "quote": "<words copied exactly from the document>"}], "confidence": <0-1 that the candidate is the answer>, "more": true|false, "note": "<at most 25 words: what the document is and what it adds>"}.',
  "Quotes are checked mechanically against the document: copy them character for character (at most 300 characters each); a paraphrase is discarded. Give a quote only for a clue it actually supports, at most 8 quotes.",
  '"more": true only when this is part of a longer document and the rest likely holds more evidence.',
].join(" ");

function clueList(clues: readonly string[]): string {
  return clues.map((c, i) => `${i + 1}. ${c}`).join("\n");
}

/** The reader's user prompt for one chunk. */
export function readerPrompt(
  question: string,
  clues: readonly string[],
  doc: { id: string; title?: string; text: string; offset: number; totalChars?: number },
  focus?: string,
): string {
  const end = doc.offset + doc.text.length;
  const span =
    doc.totalChars !== undefined && (doc.offset > 0 || end < doc.totalChars)
      ? ` (characters ${doc.offset}–${end} of ${doc.totalChars})`
      : "";
  return [
    `Question: ${question}`,
    "",
    "Clues:",
    clueList(clues),
    ...(focus ? ["", `The team is currently looking for: ${focus}`] : []),
    "",
    `Document [${doc.id}]${doc.title ? ` ${doc.title.replace(/\s+/g, " ").slice(0, 200)}` : ""}${span}:`,
    doc.text,
  ].join("\n");
}

/** True when every fragment of `quote` (split at ellipses) is in `foldedText`. */
export function quoteVerified(quote: string, foldedText: string): boolean {
  const parts = quote
    .split(/…|\.\.\./)
    .map((p) => foldForQuote(p))
    .filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  if (parts.reduce((t, p) => t + p.length, 0) < 15) return false;
  return parts.every((p) => p.length >= MIN_QUOTE_PART && foldedText.includes(p));
}

interface ParsedReading {
  relevant: boolean;
  candidate?: string;
  quotes: Array<{ text: string; clue?: number }>;
  confidence: number;
  more: boolean;
  note?: string;
}

/** A reader's reply, or undefined when it is not the asked-for JSON. */
export function parseReaderReply(reply: string, clueCount: number): ParsedReading | undefined {
  const obj = jsonObject(reply);
  if (!obj) return undefined;
  const evidence = Array.isArray(obj.evidence) ? obj.evidence : [];
  const quotes: ParsedReading["quotes"] = [];
  for (const e of evidence.slice(0, MAX_QUOTES_PER_CALL)) {
    if (!e || typeof e !== "object") continue;
    const q = (e as Record<string, unknown>).quote;
    const n = Number((e as Record<string, unknown>).clue);
    if (typeof q !== "string" || !q.trim()) continue;
    quotes.push({
      text: q.trim().slice(0, MAX_QUOTE_CHARS),
      ...(Number.isInteger(n) && n >= 1 && n <= clueCount ? { clue: n } : {}),
    });
  }
  const candidate =
    typeof obj.candidate === "string" && obj.candidate.trim()
      ? obj.candidate.trim().slice(0, 200)
      : undefined;
  const conf = Number(obj.confidence);
  return {
    relevant: obj.relevant === true || quotes.length > 0 || Boolean(candidate),
    ...(candidate && !/^(none|n\/a|unknown|empty|-)$/i.test(candidate) ? { candidate } : {}),
    quotes,
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf > 1 ? conf / 100 : conf)) : 0,
    more: obj.more === true,
    ...(typeof obj.note === "string" && obj.note.trim()
      ? { note: obj.note.trim().slice(0, 240) }
      : {}),
  };
}

/** The grouping key of a candidate answer: case, accents of punctuation, articles and spacing folded. */
export function answerKey(answer: string): string {
  return answer
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’'`"“”]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/^(the|a|an) /, "")
    .trim();
}

/** A simple counting semaphore (reader calls in flight). */
class Gate {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * One question's read swarm: the opening (decompose → retrieve → read), then
 * any number of reader-backed searches and targeted reads, all under one read
 * budget and one cache (a document is read once per question).
 */
export class ReadSwarm {
  readonly question: string;
  private readonly opts: ReadSwarmOptions;
  private readonly cfg: { [K in keyof typeof DEFAULTS]: number };
  private readonly gate: Gate;
  private readonly done = new Map<string, DocReading>();
  private readonly inflight = new Map<string, Promise<DocReading | undefined>>();
  private clueList: string[] = [];
  private docsRead = 0;
  private charsRead = 0;
  private readerCalls = 0;
  private readerFailures = 0;

  constructor(question: string, opts: ReadSwarmOptions) {
    this.question = question;
    this.opts = opts;
    const pick = (k: keyof typeof DEFAULTS) => {
      const v = opts[k];
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULTS[k];
    };
    this.cfg = {
      depth: pick("depth"),
      rerankPool: pick("rerankPool"),
      openDocs: pick("openDocs"),
      perClue: pick("perClue"),
      chunkChars: pick("chunkChars"),
      maxChunks: pick("maxChunks"),
      maxDocs: pick("maxDocs"),
      maxChars: pick("maxChars"),
      concurrency: pick("concurrency"),
    };
    this.gate = new Gate(this.cfg.concurrency);
    if (opts.clues?.length) this.clueList = [...opts.clues];
  }

  /** The clues readers read against (the question itself when there are none). */
  get clues(): string[] {
    return this.clueList.length ? this.clueList : [this.question];
  }

  /** Read budget left. */
  budgetLeft(): { docs: number; chars: number } {
    return {
      docs: Math.max(0, this.cfg.maxDocs - this.docsRead),
      chars: Math.max(0, this.cfg.maxChars - this.charsRead),
    };
  }

  exhausted(): boolean {
    const left = this.budgetLeft();
    return left.docs === 0 || left.chars < MIN_READ_CHARS;
  }

  private fatal(err: unknown): boolean {
    return this.opts.isFatal?.(err) === true;
  }

  /**
   * Decompose (unless clues were given), search each clue and the question,
   * fuse, optionally rerank, and read the opening documents: each clue's top
   * `perClue` first, then the reranked order, up to `openDocs`.
   */
  async open(): Promise<SwarmOpening> {
    if (!this.clueList.length && this.opts.decomposer) {
      this.clueList = await decomposeQuestion(this.question, this.opts.decomposer);
    }
    const queries = [this.question, ...this.clueList];
    const rankings = await Promise.all(
      queries.map((q) =>
        this.opts.search(q, this.cfg.depth).catch((err: unknown) => {
          if (this.fatal(err)) throw err;
          return [] as Candidate[];
        }),
      ),
    );
    const fused = fuseRankings(rankings);
    let ordered = fused;
    let order: SwarmOpening["order"] = "fused";
    let error: string | undefined;
    if (this.opts.judge || this.opts.reranker) {
      const pool = fused.slice(0, this.cfg.rerankPool);
      const r = this.opts.judge
        ? await judgeRerank(this.question, pool, this.opts.judge)
        : await llmRerank(this.question, pool, this.opts.reranker!);
      ordered = [...r.ranked, ...fused.slice(pool.length)];
      if (r.ok) order = this.opts.judge ? "judged" : "reranked";
      if (r.error) error = r.error;
    }
    // Each clue's best documents first, so no clue goes unread; then the overall order.
    const pick: Candidate[] = [];
    const seen = new Set<string>();
    const add = (c: Candidate) => {
      if (pick.length >= this.cfg.openDocs || seen.has(c.id)) return;
      seen.add(c.id);
      pick.push(c);
    };
    for (const list of rankings.slice(1)) for (const c of list.slice(0, this.cfg.perClue)) add(c);
    for (const c of ordered) add(c);
    await this.readMany(pick);
    return {
      clues: this.clueList,
      surfaced: ordered.slice(0, Math.max(this.cfg.rerankPool, this.cfg.openDocs)),
      read: pick.filter((c) => this.done.has(c.id)).map((c) => c.id),
      order,
      ...(error ? { error } : {}),
    };
  }

  /** Search `query` and read its top `k` (already-read documents come from the cache). */
  async search(query: string, k: number): Promise<SwarmSearch> {
    const hits = (await this.opts.search(query, k)).slice(0, k);
    const readings = await this.readMany(hits, query);
    return { hits, readings };
  }

  /** Read these documents (cached, budgeted, `concurrency` at a time). */
  async readMany(
    cands: readonly Candidate[],
    focus?: string,
  ): Promise<Array<DocReading | undefined>> {
    return Promise.all(cands.map((c) => this.readDoc(c, focus)));
  }

  /** One document, read once per question; undefined when the budget is spent. */
  readDoc(c: Candidate, focus?: string): Promise<DocReading | undefined> {
    const had = this.done.get(c.id);
    if (had) return Promise.resolve(had);
    const running = this.inflight.get(c.id);
    if (running) return running;
    if (this.exhausted()) return Promise.resolve(undefined);
    this.docsRead++; // reserved now, so parallel reads never overshoot the document budget
    const p = this.readFresh(c, focus).finally(() => this.inflight.delete(c.id));
    this.inflight.set(c.id, p);
    return p;
  }

  private async readFresh(c: Candidate, focus?: string): Promise<DocReading> {
    const reading: DocReading = {
      id: c.id,
      ...(c.title ? { title: c.title } : {}),
      charsRead: 0,
      chunks: 0,
      relevant: false,
      candidateInText: false,
      clues: [],
      quotes: [],
      confidence: 0,
      ...(focus ? { focus } : {}),
    };
    let folded = "";
    let offset = 0;
    for (let chunk = 0; chunk < this.cfg.maxChunks; chunk++) {
      const room = Math.min(this.cfg.chunkChars, this.cfg.maxChars - this.charsRead);
      if (room < MIN_READ_CHARS) break;
      let doc: SwarmDocument | undefined;
      try {
        doc = this.opts.read
          ? await this.opts.read(c.id, offset, room)
          : chunk === 0
            ? { id: c.id, text: c.text.slice(0, room), totalChars: c.text.length }
            : undefined;
      } catch (err) {
        if (this.fatal(err)) throw err;
        reading.error = "document unreadable";
        break;
      }
      const text = doc?.text.slice(0, room) ?? "";
      if (!text) {
        if (chunk === 0) reading.error = "document not found";
        break;
      }
      if (doc?.title && !reading.title) reading.title = doc.title;
      if (doc?.totalChars !== undefined) reading.totalChars = doc.totalChars;
      this.charsRead += text.length;
      reading.charsRead += text.length;
      reading.chunks++;
      let reply: string;
      try {
        reply = await this.gate.run(() => {
          this.readerCalls++;
          return this.opts.reader.complete(
            READER_SYSTEM,
            readerPrompt(
              this.question,
              this.clues,
              {
                id: c.id,
                ...(reading.title ? { title: reading.title } : {}),
                text,
                offset,
                ...(reading.totalChars !== undefined ? { totalChars: reading.totalChars } : {}),
              },
              focus,
            ),
          );
        });
      } catch (err) {
        if (this.fatal(err)) throw err;
        this.readerFailures++;
        reading.error = (err instanceof Error ? err.message : String(err)).slice(0, 160);
        break;
      }
      const parsed = parseReaderReply(reply, this.clues.length);
      if (!parsed) {
        this.readerFailures++;
        reading.error = "reader reply was not the asked-for JSON";
        break;
      }
      delete reading.error;
      const foldedChunk = foldForQuote(text);
      folded += ` ${foldedChunk}`;
      for (const q of parsed.quotes) {
        reading.quotes.push({ ...q, verified: quoteVerified(q.text, foldedChunk) });
      }
      reading.relevant ||= parsed.relevant;
      if (parsed.candidate && (!reading.candidate || parsed.confidence > reading.confidence)) {
        reading.candidate = parsed.candidate;
      }
      reading.confidence = Math.max(reading.confidence, parsed.confidence);
      if (parsed.note && !reading.note) reading.note = parsed.note;
      offset += text.length;
      const total = reading.totalChars ?? (this.opts.read ? undefined : c.text.length);
      if (!parsed.more || (total !== undefined && offset >= total)) break;
    }
    if (reading.candidate) {
      const name = foldForQuote(reading.candidate);
      reading.candidateInText = name.length >= 2 && folded.includes(name);
    }
    reading.clues = [
      ...new Set(
        reading.quotes.filter((q) => q.verified && q.clue !== undefined).map((q) => q.clue!),
      ),
    ].sort((a, b) => a - b);
    this.done.set(c.id, reading);
    this.opts.onRead?.(reading);
    return reading;
  }

  /** Every document read so far, in reading order. */
  readings(): DocReading[] {
    return [...this.done.values()];
  }

  /** Candidates aggregated over every reading, best first. */
  candidates(): CandidateRow[] {
    return aggregateCandidates(this.readings());
  }

  stats(): SwarmStats {
    const quotes = this.readings().flatMap((r) => r.quotes);
    return {
      clues: this.clueList.length,
      docsRead: this.done.size,
      charsRead: this.charsRead,
      readerCalls: this.readerCalls,
      readerFailures: this.readerFailures,
      quotes: quotes.length,
      quotesVerified: quotes.filter((q) => q.verified).length,
      budgetExhausted: this.exhausted(),
    };
  }
}

/**
 * Group readings by normalised candidate and rank: distinct clues backed by
 * verified quotes first (the multi-clue candidates), then the number of
 * documents naming it, then whether its words appear in a document, then the
 * readers' confidence. A key that is a multi-word subset of another key's words
 * ("john smith" ⊂ "john a smith") joins it.
 */
export function aggregateCandidates(readings: readonly DocReading[]): CandidateRow[] {
  const groups = new Map<string, { answers: Map<string, number>; readings: DocReading[] }>();
  for (const r of readings) {
    if (!r.candidate) continue;
    const key = answerKey(r.candidate);
    if (!key) continue;
    const g = groups.get(key) ?? {
      answers: new Map<string, number>(),
      readings: [] as DocReading[],
    };
    g.answers.set(r.candidate, (g.answers.get(r.candidate) ?? 0) + 1);
    g.readings.push(r);
    groups.set(key, g);
  }
  // Merge multi-word keys into a key whose words contain theirs.
  const keys = [...groups.keys()].sort((a, b) => b.split(" ").length - a.split(" ").length);
  for (const small of [...keys].reverse()) {
    const words = small.split(" ");
    if (words.length < 2 || !groups.has(small)) continue;
    const host = keys.find((big) => {
      if (big === small || !groups.has(big)) return false;
      const bigWords = new Set(big.split(" "));
      return bigWords.size > words.length && words.every((w) => bigWords.has(w));
    });
    if (!host) continue;
    const from = groups.get(small)!;
    const into = groups.get(host)!;
    for (const [a, n] of from.answers) into.answers.set(a, (into.answers.get(a) ?? 0) + n);
    into.readings.push(...from.readings);
    groups.delete(small);
  }
  const rows: CandidateRow[] = [];
  for (const [key, g] of groups) {
    const answer = [...g.answers.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const clues = [...new Set(g.readings.flatMap((r) => r.clues))].sort((a, b) => a - b);
    const docs = [...new Set(g.readings.map((r) => r.id))];
    const quotes = g.readings.flatMap((r) =>
      r.quotes
        .filter((q) => q.verified)
        .map((q) => ({
          doc: r.id,
          ...(q.clue !== undefined ? { clue: q.clue } : {}),
          text: q.text,
        })),
    );
    const confidence = Math.max(...g.readings.map((r) => r.confidence));
    const inText = g.readings.some((r) => r.candidateInText);
    rows.push({
      answer,
      key,
      clues,
      docs,
      quotes,
      confidence,
      inText,
      score:
        clues.length + 0.25 * Math.min(docs.length - 1, 4) + (inText ? 0.25 : 0) + 0.5 * confidence,
    });
  }
  return rows.sort((a, b) => b.score - a.score || b.docs.length - a.docs.length);
}

export interface TableOptions {
  /** Candidate rows shown (default 8). */
  rows?: number;
  /** Verified quotes shown per candidate (default 3). */
  quotesPerRow?: number;
  /** Characters per quote (default 220). */
  quoteChars?: number;
  /** Relevant documents without a candidate shown (default 6). */
  otherDocs?: number;
}

function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * The compact hand-off for a lead: the clues, the ranked candidates with the
 * clues their verified quotes support and the documents behind them, and the
 * relevant documents that named no candidate. Document ids are in square
 * brackets so a lead can cite or open them.
 */
export function renderCandidateTable(
  clues: readonly string[],
  readings: readonly DocReading[],
  opts: TableOptions = {},
): string {
  const rows = aggregateCandidates(readings).slice(0, opts.rows ?? 8);
  const perRow = opts.quotesPerRow ?? 3;
  const qChars = opts.quoteChars ?? 220;
  const lines: string[] = [`Clues (${clues.length}):`, clueList(clues), ""];
  if (rows.length === 0) {
    lines.push(`Candidates: none yet (${readings.length} documents read).`);
  } else {
    lines.push(
      `Candidates (from ${readings.length} documents read in full; clues backed by verified quotes):`,
    );
    rows.forEach((r, i) => {
      lines.push(
        `${i + 1}. ${r.answer} — clues ${r.clues.length ? r.clues.join(",") : "none verified"} of ${clues.length} — docs ${r.docs.map((d) => `[${d}]`).join(" ")} — reader confidence ${r.confidence.toFixed(2)}${r.inText ? "" : " — name not found verbatim (inferred)"}`,
      );
      // One quote per clue first, so the quotes shown cover the most clues.
      const shown: CandidateRow["quotes"] = [];
      const clueSeen = new Set<number | undefined>();
      for (const q of r.quotes) {
        if (shown.length < perRow && !clueSeen.has(q.clue)) {
          shown.push(q);
          clueSeen.add(q.clue);
        }
      }
      for (const q of shown) {
        lines.push(
          `   [${q.doc}]${q.clue !== undefined ? ` clue ${q.clue}` : ""}: "${clip(q.text, qChars)}"`,
        );
      }
    });
  }
  const other = readings
    .filter((r) => !r.candidate && r.clues.length > 0)
    .sort((a, b) => b.clues.length - a.clues.length)
    .slice(0, opts.otherDocs ?? 6);
  if (other.length) {
    lines.push("", "Relevant documents without a candidate:");
    for (const r of other) {
      lines.push(
        `- [${r.id}] clues ${r.clues.join(",")}${r.note ? ` — ${clip(r.note, 160)}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

/** One reading as a compact object (a search tool's per-hit report). */
export function readingSummary(r: DocReading, quoteChars = 240): Record<string, unknown> {
  const verified = r.quotes.filter((q) => q.verified);
  if (!r.relevant && verified.length === 0 && !r.candidate) {
    return { relevant: false, ...(r.note ? { note: clip(r.note, 160) } : {}) };
  }
  return {
    ...(r.candidate ? { candidate: r.candidate } : {}),
    clues: r.clues,
    quotes: verified
      .slice(0, 4)
      .map((q) => ({
        ...(q.clue !== undefined ? { clue: q.clue } : {}),
        quote: clip(q.text, quoteChars),
      })),
    confidence: Number(r.confidence.toFixed(2)),
    ...(r.note ? { note: clip(r.note, 160) } : {}),
    ...(r.totalChars !== undefined && r.charsRead < r.totalChars
      ? { read_chars: r.charsRead, total_chars: r.totalChars }
      : {}),
  };
}
