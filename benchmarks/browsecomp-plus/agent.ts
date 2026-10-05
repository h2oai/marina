// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * BrowseComp-Plus — one query through a Marina model endpoint.
 *
 * Two shapes, both against Marina's OpenAI-compatible `/v1/chat/completions`:
 *
 *   - tools  — the official agent loop: the model gets `search` (top-k,
 *              docid + score + a leading snippet) and `get_document`, served
 *              from a local corpus (`src/engine/search-providers/corpus.ts`).
 *              Works with any id Marina serves with tool calling: a passthru
 *              model (`openrouter/…`) or the verification formation
 *              (`marina/verify:<proposer>[+<checker>]`). Multi-agent research
 *              formations (`formations.ts`) compose this same loop.
 *   - crew   — a `marina:<crew>` endpoint answers in text. The crew's agents
 *              search the same corpus in-world (`web search
 *              engines:corpus:<name>`, `web fetch corpus://<name>/<docid>`);
 *              the adapter cannot see their tool calls, so recall is measured
 *              on the docids the answer cites.
 *
 * Every call carries the operator's key; cost comes from `x-marina-cost-usd`
 * and the trace id from `x-request-id`.
 */

import {
  BUDGET_FORCED_HEADER,
  type BudgetForced,
  budgetFinalRequest,
  budgetSteerAt,
  budgetSteerNote,
  DEADLINE_HEADER,
} from "../../src/agent/budget-terminal";
import { getDecisionProvider } from "../../src/decisions/config";
import {
  type CorpusDoc,
  type CorpusHit,
  explicitBm25FromEnv,
  getCorpusDocument,
  searchCorpusHybridPage,
} from "../../src/engine/search-providers/corpus";
import { corpusEmbeddingStatus } from "../../src/engine/search-providers/corpus-vectors";
import { firstMove } from "../../src/retrieval/first-move";
import { BudgetExhausted, type CallSpendGuard, isSpendCapRefusal } from "../call-spend-guard";
import {
  extractCitations,
  GET_DOCUMENT_DESCRIPTION,
  queryPrompt,
  type RunRecord,
  retrievedDocids,
  searchToolDescription,
} from "./official";

export interface ChatEndpoint {
  /** Base URL of the Marina server (e.g. http://localhost:3300). */
  baseUrl: string;
  apiKey?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Hard spend stop: checked before every call, fed every call's cost. */
  guard?: CallSpendGuard;
}

/** Where tool calls are answered. In-process by default; `corpus-pool.ts` runs them in workers. */
export interface CorpusBackend {
  search(query: string, k: number, leadChars: number, offset?: number): Promise<CorpusHit[]>;
  get(
    docid: string,
    maxChars: number,
    offset?: number,
  ): Promise<(CorpusDoc & { totalChars?: number }) | undefined>;
}

export function localBackend(corpus: string, dir?: string): CorpusBackend {
  return {
    // Hybrid (BM25 + dense) only when MARINA_CORPUS_EMBEDDINGS names a model
    // whose vectors the corpus holds; otherwise exactly the BM25 search.
    search: async (query, k, leadChars, offset) =>
      (
        await searchCorpusHybridPage(corpus, query, {
          dir,
          k,
          leadChars,
          ...(offset ? { offset } : {}),
          // The harness ranks with FTS5 unless BM25 parameters are set explicitly
          // (the official protocol's plain BM25; recorded in the run metadata).
          bm25: explicitBm25FromEnv() ?? null,
        })
      ).hits,
    get: async (docid, maxChars, offset) =>
      getCorpusDocument(corpus, docid, { dir, maxChars, ...(offset ? { offset } : {}) }),
  };
}

export interface AgentOptions {
  corpus: string;
  corpusDir?: string;
  backend?: CorpusBackend;
  /** Hits per search (official default 5). */
  k: number;
  /** Snippet length in characters (≈ the official 512-token snippet). */
  snippetChars: number;
  /** Cap on a get_document reply, in characters. */
  docChars: number;
  /** Model turns before the run is cut off as incomplete. */
  maxTurns: number;
  /**
   * Budget-terminal answering (`src/agent/budget-terminal.ts`): from about
   * 75 % of `maxTurns` the agent is told how many turns are left and to
   * converge; at the cap it gets one more call with tools disabled asking for
   * its final answer from what it has found. The answer is labelled
   * `budget_forced`. Off = the official protocol (the cap ends the run
   * incomplete).
   */
  finalAnswer?: boolean;
  /**
   * Marina harness options (all off = the official harness):
   *   snippet: "matched" shows each hit's best-matching window instead of the
   *     document's opening characters;
   *   docPaging: get_document takes an `offset` and reports the document's
   *     full length, so a reader can page past `docChars`;
   *   searchPaging: search takes a `page`, served from the cached ranking.
   */
  snippet?: "lead" | "matched";
  docPaging?: boolean;
  searchPaging?: boolean;
  /**
   * First move: decompose the question into clues, search each `depth` deep,
   * fuse, rerank with `model` and show the top `k` before the first turn.
   */
  /** `judge`: the configured decision backend (MARINA_DECISIONS) reranks instead of the model. */
  firstMove?: { model: string; depth?: number; k?: number; judge?: boolean };
  maxTokens?: number;
  temperature?: number;
  /** Per-request timeout. */
  timeoutMs: number;
}

/** Restrict `search` to one hash shard of the corpus (the sharding formation). */
export interface Shard {
  index: number;
  of: number;
}

export interface QueryRun {
  record: RunRecord;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  latencyMs: number;
  traceIds: string[];
  error?: string;
  /** Set when the spend guard stopped this query: it is NOT RUN, never scored. */
  stoppedBy?: string;
  /** Set when the answer was forced at the turn cap (budget-terminal answering). */
  budgetForced?: BudgetForced;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatReply {
  message: ChatMessage;
  finishReason: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  traceId?: string;
  /** Marina's `x-marina-budget-forced` reason: a crew's draft forced at the deadline. */
  budgetForced?: string;
}

export function toolSchemas(k: number, more: { docPaging?: boolean; searchPaging?: boolean } = {}) {
  return [
    {
      type: "function",
      function: {
        name: "search",
        description: more.searchPaging
          ? `${searchToolDescription(k)} Pass page (1, 2, …) to see the next results of the same query.`
          : searchToolDescription(k),
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query string" },
            ...(more.searchPaging
              ? { page: { type: "integer", description: "Result page, 1 = the first (default)" } }
              : {}),
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_document",
        description: more.docPaging
          ? `${GET_DOCUMENT_DESCRIPTION} Long documents are returned in parts: pass offset (a character position, from next_offset) to read on.`
          : GET_DOCUMENT_DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            docid: { type: "string", description: "Document ID to retrieve" },
            ...(more.docPaging
              ? {
                  offset: {
                    type: "integer",
                    description: "Character offset to start at (default 0)",
                  },
                }
              : {}),
          },
          required: ["docid"],
        },
      },
    },
  ];
}

/** FNV-1a of the docid → its shard. */
export function shardOf(docid: string, of: number): number {
  let h = 2166136261;
  for (let i = 0; i < docid.length; i++) {
    h ^= docid.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % of;
}

/** Run one tool call against the corpus; returns the JSON text the model sees. */
export async function executeTool(
  name: string,
  rawArgs: string,
  opts: AgentOptions,
  shard?: Shard,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: "arguments must be a JSON object" });
  }
  const backend = opts.backend ?? localBackend(opts.corpus, opts.corpusDir);
  if (name === "search") {
    const query = typeof args.query === "string" ? args.query : "";
    const page = opts.searchPaging ? Math.max(1, Math.floor(Number(args.page) || 1)) : 1;
    // A shard reads deeper into the ranking and keeps only its own documents.
    const depth = shard && shard.of > 1 ? Math.min(100, opts.k * shard.of * 2) : opts.k;
    let hits = await backend.search(query, depth, opts.snippetChars, (page - 1) * depth);
    if (shard && shard.of > 1)
      hits = hits.filter((h) => shardOf(h.docid, shard.of) === shard.index);
    return JSON.stringify(
      hits.slice(0, opts.k).map((h) => ({
        docid: h.docid,
        score: Number(h.score.toFixed(4)),
        snippet: opts.snippet === "matched" ? h.window || h.lead : h.lead,
      })),
    );
  }
  if (name === "get_document") {
    const docid = String(args.docid ?? "");
    const offset = opts.docPaging ? Math.max(0, Math.floor(Number(args.offset) || 0)) : 0;
    const doc = await backend.get(docid, opts.docChars, offset);
    if (!doc) return JSON.stringify({ error: `Document with docid '${docid}' not found` });
    if (!opts.docPaging) return JSON.stringify({ docid: doc.docid, text: doc.text });
    const total = doc.totalChars ?? offset + doc.text.length;
    const next = offset + doc.text.length;
    return JSON.stringify({
      docid: doc.docid,
      offset,
      total_chars: total,
      ...(next < total ? { next_offset: next } : {}),
      text: doc.text,
    });
  }
  return JSON.stringify({ error: `unknown tool ${name}` });
}

export async function chat(
  ep: ChatEndpoint,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<ChatReply> {
  ep.guard?.check();
  const doFetch = ep.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // A crew answers with its best draft before this deadline (budget-terminal).
    [DEADLINE_HEADER]: String(timeoutMs),
  };
  if (ep.apiKey) headers.Authorization = `Bearer ${ep.apiKey}`;
  const resp = await doFetch(`${ep.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  ep.guard?.add(Number(resp.headers.get("x-marina-cost-usd")));
  if (!resp.ok) {
    if (ep.guard && isSpendCapRefusal(resp.status, text)) {
      ep.guard.trip("the server's daily spend cap");
      ep.guard.check();
    }
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text) as {
    choices?: { message?: ChatMessage; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const choice = data.choices?.[0];
  if (!choice?.message) throw new Error("reply has no message");
  const headerCost = Number(resp.headers.get("x-marina-cost-usd"));
  return {
    message: choice.message,
    finishReason: choice.finish_reason ?? "",
    costUsd: Number.isFinite(headerCost) ? headerCost : (data.usage?.cost ?? 0),
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    traceId: resp.headers.get("x-request-id") ?? undefined,
    budgetForced: resp.headers.get(BUDGET_FORCED_HEADER) ?? undefined,
  };
}

export function emptyRun(model: string, queryId: string, extra: Record<string, unknown>): QueryRun {
  return {
    record: {
      metadata: { model, ...extra },
      query_id: queryId,
      tool_call_counts: {},
      usage: {},
      status: "incomplete",
      retrieved_docids: [],
      result: [],
    },
    costUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    calls: 0,
    latencyMs: 0,
    traceIds: [],
  };
}

/** Close a run: retrieved docids from every search, usage totals, latency. */
export function finishRun(run: QueryRun, started: number): QueryRun {
  if (run.stoppedBy) run.record.metadata.stopped_by = run.stoppedBy;
  if (run.budgetForced) run.record.metadata.budget_forced = run.budgetForced;
  run.record.retrieved_docids = retrievedDocids(run.record.result);
  run.record.usage = {
    input_tokens: run.promptTokens,
    output_tokens: run.completionTokens,
    total_tokens: run.promptTokens + run.completionTokens,
  };
  run.latencyMs = Date.now() - started;
  return run;
}

export interface LoopResult {
  /** The agent's text answer, if it gave one before the turn cap. */
  text?: string;
  /** The conversation, for a caller that continues it (blackboard rounds). */
  messages: ChatMessage[];
  /** The answer was forced at the turn cap (`finalAnswer`). */
  budgetForced?: BudgetForced;
}

/** Append a budget note to the latest tool result (no extra user turn: every provider accepts it). */
function noteOnLastTool(messages: ChatMessage[], note: string): boolean {
  const last = messages[messages.length - 1];
  if (last?.role !== "tool") return false;
  last.content = `${last.content ?? ""}\n\n${note}`;
  return true;
}

/**
 * One agent's tool loop, accumulated into `run` (cost, calls, tool items tagged
 * with `agent`). Ends at the first text answer or after `maxTurns` turns.
 * With `finalAnswer` (budget-terminal answering) the agent is steered toward
 * answering from about 75 % of the turns, and at the cap one more call with
 * tools disabled asks for its final answer — labelled `budgetForced`.
 * Throws on a transport error; the caller decides what that means.
 */
export async function toolLoop(
  ep: ChatEndpoint,
  model: string,
  messages: ChatMessage[],
  opts: AgentOptions,
  run: QueryRun,
  more: {
    agent?: string;
    maxTurns?: number;
    shard?: Shard;
    tools?: boolean;
    /** Overrides `opts.finalAnswer` for this loop (a blackboard round is not the last word). */
    finalAnswer?: boolean;
  } = {},
): Promise<LoopResult> {
  const tools =
    more.tools === false
      ? undefined
      : toolSchemas(opts.k, { docPaging: opts.docPaging, searchPaging: opts.searchPaging });
  const turns = more.maxTurns ?? opts.maxTurns;
  const tag = more.agent ? { agent: more.agent } : {};
  const forceAnswer = Boolean(tools) && (more.finalAnswer ?? opts.finalAnswer ?? false);
  const steerAt = budgetSteerAt(turns);
  let steered = false;
  const ask = async (choice: "auto" | "none") => {
    const reply = await chat(
      ep,
      {
        model,
        messages,
        ...(tools ? { tools, tool_choice: choice } : {}),
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      },
      opts.timeoutMs,
    );
    run.calls++;
    run.costUsd += reply.costUsd;
    run.promptTokens += reply.promptTokens;
    run.completionTokens += reply.completionTokens;
    if (reply.traceId) run.traceIds.push(reply.traceId);
    return reply;
  };
  const answer = (text: string) => {
    messages.push({ role: "assistant", content: text });
    run.record.result.push({
      type: "output_text",
      tool_name: null,
      arguments: null,
      output: text,
      ...tag,
    });
  };
  for (let turn = 0; turn < turns; turn++) {
    const reply = await ask("auto");
    const calls = tools ? (reply.message.tool_calls ?? []) : [];
    if (calls.length === 0) {
      const text = (reply.message.content ?? "").trim();
      if (text) answer(text);
      return { ...(text ? { text } : {}), messages };
    }
    messages.push({ role: "assistant", content: reply.message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name ?? "";
      const output = await executeTool(name, call.function?.arguments ?? "", opts, more.shard);
      run.record.tool_call_counts[name] = (run.record.tool_call_counts[name] ?? 0) + 1;
      run.record.result.push({
        type: "tool_call",
        tool_name: name,
        arguments: call.function?.arguments ?? "",
        output,
        ...tag,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
    const used = turn + 1;
    if (forceAnswer && !steered && used >= steerAt && used < turns) {
      steered = noteOnLastTool(messages, budgetSteerNote(used, turns, "turns"));
    }
  }
  if (!forceAnswer || !noteOnLastTool(messages, budgetFinalRequest(turns, "turns"))) {
    return { messages };
  }
  // The cap: one more call, tools disabled — the best answer from what was found.
  const reply = await ask("none");
  const text = (reply.message.content ?? "").trim();
  if (!text) return { messages };
  const budgetForced: BudgetForced = {
    reason: "turns",
    used: turns,
    cap: turns,
    source: "final-request",
  };
  answer(text);
  return { text, messages, budgetForced };
}

/** The official agent loop: tools until the model answers in text or the turn cap. */
export async function runToolAgent(
  ep: ChatEndpoint,
  model: string,
  queryId: string,
  question: string,
  opts: AgentOptions,
): Promise<QueryRun> {
  const started = Date.now();
  const run = emptyRun(model, queryId, {
    shape: "tools",
    corpus: opts.corpus,
    k: opts.k,
    snippet_chars: opts.snippetChars,
    doc_chars: opts.docChars,
    max_turns: opts.maxTurns,
    ...(opts.finalAnswer ? { final_answer: true } : {}),
    ...harnessMetadata(opts),
  });
  try {
    const opening = opts.firstMove ? await openingContext(ep, question, opts, run) : "";
    const out = await toolLoop(
      ep,
      model,
      [{ role: "user", content: `${queryPrompt(question)}${opening}` }],
      opts,
      run,
    );
    run.record.status = out.text ? "completed" : "incomplete";
    if (out.budgetForced) run.budgetForced = out.budgetForced;
  } catch (e) {
    failRun(run, e);
  }
  return finishRun(run, started);
}

/** A thrown query: a budget stop is NOT RUN (`stoppedBy`); anything else is an error. */
export function failRun(run: QueryRun, e: unknown): void {
  if (e instanceof BudgetExhausted) {
    run.record.status = "incomplete";
    run.stoppedBy = e.reason;
    return;
  }
  run.record.status = "error";
  run.error = e instanceof Error ? e.message : String(e);
}

/** A model on the Marina endpoint as a first-move helper; its cost joins the run. */
function endpointModel(ep: ChatEndpoint, model: string, run: QueryRun, timeoutMs: number) {
  return {
    name: model,
    complete: async (system: string, user: string) => {
      const reply = await chat(
        ep,
        {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        timeoutMs,
      );
      run.calls++;
      run.costUsd += reply.costUsd;
      run.promptTokens += reply.promptTokens;
      run.completionTokens += reply.completionTokens;
      if (reply.traceId) run.traceIds.push(reply.traceId);
      return reply.message.content ?? "";
    },
  };
}

/**
 * The first move (`firstMove`): clues searched deeply, fused, reranked by the
 * given model, and the top documents shown before the agent's first turn.
 * Recorded as a `first_move_search` tool call, so recall counts what it showed.
 */
async function openingContext(
  ep: ChatEndpoint,
  question: string,
  opts: AgentOptions,
  run: QueryRun,
): Promise<string> {
  const fm = opts.firstMove!;
  const backend = opts.backend ?? localBackend(opts.corpus, opts.corpusDir);
  const helper = endpointModel(ep, fm.model, run, opts.timeoutMs);
  const judge = fm.judge ? getDecisionProvider() : undefined;
  if (fm.judge && !judge)
    throw new Error("--first-move-judge needs a decision backend (MARINA_DECISIONS)");
  const move = await firstMove(question, {
    search: async (q, depth) =>
      (await backend.search(q, depth, opts.snippetChars)).map((h) => ({
        id: h.docid,
        title: h.title,
        text: h.window || h.lead,
      })),
    decomposer: helper,
    reranker: helper,
    ...(judge ? { judge } : {}),
    depth: fm.depth ?? 50,
    k: fm.k ?? opts.k,
  });
  const shown = move.candidates.map((c) => ({ docid: c.id, snippet: c.text }));
  run.record.result.push({
    type: "tool_call",
    tool_name: "first_move_search",
    arguments: JSON.stringify({ clues: move.clues, order: move.order }),
    output: JSON.stringify(shown),
  });
  if (shown.length === 0) return "";
  return `\n\nOpening context — a first search pass over the question's clues found these documents (use get_document to read one in full):\n${JSON.stringify(shown)}`;
}

/** Marina harness options in a run's metadata (absent = the official harness). */
export function harnessMetadata(opts: AgentOptions): Record<string, unknown> {
  const embeddings = corpusEmbeddingStatus();
  return {
    ...(opts.snippet === "matched" ? { snippet: "matched" } : {}),
    ...(opts.docPaging ? { doc_paging: true } : {}),
    ...(opts.searchPaging ? { search_paging: true } : {}),
    ...(opts.firstMove ? { first_move: opts.firstMove.model } : {}),
    ...(opts.firstMove?.judge ? { first_move_judge: getDecisionProvider()?.model ?? "none" } : {}),
    ...(process.env.MARINA_CORPUS_BM25_K1 && process.env.MARINA_CORPUS_BM25_B
      ? { bm25: `k1=${process.env.MARINA_CORPUS_BM25_K1},b=${process.env.MARINA_CORPUS_BM25_B}` }
      : {}),
    ...(embeddings.state === "configured"
      ? {
          hybrid: `${embeddings.model},w=${process.env.MARINA_CORPUS_HYBRID_WEIGHT?.trim() || "2"}`,
        }
      : {}),
  };
}

/** The crew's instructions: the official prompt plus how to reach the corpus in-world. */
export function crewPrompt(question: string, corpus: string): string {
  return [
    queryPrompt(question)
      .replace(
        "by interacting with a search engine, using the search and get_document tools provided",
        "by interacting with a search engine",
      )
      .replace("use the search and get_document tools", "search"),
    "",
    `Search ONLY this fixed document collection (not the live web): \`web search engines:corpus:${corpus} <query>\` returns docids with snippets; \`web fetch corpus://${corpus}/<docid>\` reads a document. Cite docids in square brackets as instructed.`,
  ].join("\n");
}

/** A `marina:<crew>` endpoint answers in text; recall comes from its cited docids. */
export async function runCrew(
  ep: ChatEndpoint,
  model: string,
  queryId: string,
  question: string,
  opts: Pick<AgentOptions, "corpus" | "timeoutMs">,
): Promise<QueryRun> {
  const started = Date.now();
  const run = emptyRun(model, queryId, { shape: "crew", corpus: opts.corpus });
  try {
    const reply = await chat(
      ep,
      { model, messages: [{ role: "user", content: crewPrompt(question, opts.corpus) }] },
      opts.timeoutMs,
    );
    run.calls = 1;
    run.costUsd = reply.costUsd;
    run.promptTokens = reply.promptTokens;
    run.completionTokens = reply.completionTokens;
    if (reply.traceId) run.traceIds.push(reply.traceId);
    const text = (reply.message.content ?? "").trim();
    if (text) {
      run.record.result.push({
        type: "output_text",
        tool_name: null,
        arguments: null,
        output: text,
      });
      run.record.status = "completed";
      run.record.retrieved_docids = extractCitations(text);
      run.record.metadata.recall_source = "cited";
      if (reply.budgetForced) {
        // The crew's best draft at the deadline, labelled as such.
        run.budgetForced = {
          reason: reply.budgetForced as BudgetForced["reason"],
          used: Date.now() - started,
          cap: opts.timeoutMs,
          source: "crew",
        };
        run.record.metadata.budget_forced = run.budgetForced;
      }
    }
  } catch (e) {
    failRun(run, e);
  }
  run.latencyMs = Date.now() - started;
  return run;
}

/** Arm shape from the model id: `marina:<crew>` answers in text, anything else gets tools. */
export function shapeFor(model: string): "tools" | "crew" {
  return model.startsWith("marina:") ? "crew" : "tools";
}
