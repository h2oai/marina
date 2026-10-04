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
  type CorpusDoc,
  type CorpusHit,
  getCorpusDocument,
  searchCorpus,
} from "../../src/engine/search-providers/corpus";
import { BudgetExhausted, isSpendCapRefusal, type SpendGuard } from "../spend-guard";
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
  guard?: SpendGuard;
}

/** Where tool calls are answered. In-process by default; `corpus-pool.ts` runs them in workers. */
export interface CorpusBackend {
  search(query: string, k: number, leadChars: number): Promise<CorpusHit[]>;
  get(docid: string, maxChars: number): Promise<CorpusDoc | undefined>;
}

export function localBackend(corpus: string, dir?: string): CorpusBackend {
  return {
    search: async (query, k, leadChars) => searchCorpus(corpus, query, { dir, k, leadChars }),
    get: async (docid, maxChars) => getCorpusDocument(corpus, docid, { dir, maxChars }),
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
}

export function toolSchemas(k: number) {
  return [
    {
      type: "function",
      function: {
        name: "search",
        description: searchToolDescription(k),
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Search query string" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_document",
        description: GET_DOCUMENT_DESCRIPTION,
        parameters: {
          type: "object",
          properties: { docid: { type: "string", description: "Document ID to retrieve" } },
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
    // A shard reads deeper into the ranking and keeps only its own documents.
    const depth = shard && shard.of > 1 ? Math.min(50, opts.k * shard.of * 2) : opts.k;
    let hits = await backend.search(query, depth, opts.snippetChars);
    if (shard && shard.of > 1)
      hits = hits.filter((h) => shardOf(h.docid, shard.of) === shard.index);
    return JSON.stringify(
      hits
        .slice(0, opts.k)
        .map((h) => ({ docid: h.docid, score: Number(h.score.toFixed(4)), snippet: h.lead })),
    );
  }
  if (name === "get_document") {
    const docid = String(args.docid ?? "");
    const doc = await backend.get(docid, opts.docChars);
    if (!doc) return JSON.stringify({ error: `Document with docid '${docid}' not found` });
    return JSON.stringify({ docid: doc.docid, text: doc.text });
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
  const headers: Record<string, string> = { "Content-Type": "application/json" };
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
}

/**
 * One agent's tool loop, accumulated into `run` (cost, calls, tool items tagged
 * with `agent`). Ends at the first text answer or after `maxTurns` turns.
 * Throws on a transport error; the caller decides what that means.
 */
export async function toolLoop(
  ep: ChatEndpoint,
  model: string,
  messages: ChatMessage[],
  opts: AgentOptions,
  run: QueryRun,
  more: { agent?: string; maxTurns?: number; shard?: Shard; tools?: boolean } = {},
): Promise<LoopResult> {
  const tools = more.tools === false ? undefined : toolSchemas(opts.k);
  const turns = more.maxTurns ?? opts.maxTurns;
  const tag = more.agent ? { agent: more.agent } : {};
  for (let turn = 0; turn < turns; turn++) {
    const reply = await chat(
      ep,
      {
        model,
        messages,
        ...(tools ? { tools, tool_choice: "auto" } : {}),
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
    const calls = tools ? (reply.message.tool_calls ?? []) : [];
    if (calls.length === 0) {
      const text = (reply.message.content ?? "").trim();
      if (text) {
        messages.push({ role: "assistant", content: text });
        run.record.result.push({
          type: "output_text",
          tool_name: null,
          arguments: null,
          output: text,
          ...tag,
        });
      }
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
  }
  return { messages };
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
  });
  try {
    const out = await toolLoop(
      ep,
      model,
      [{ role: "user", content: queryPrompt(question) }],
      opts,
      run,
    );
    run.record.status = out.text ? "completed" : "incomplete";
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
