// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A live-web research agent that writes citation-backed markdown answers.
 *
 * The loop is a plain tool loop over any one model (`model-turn.ts`):
 *   web_search   the configured search chain (`searchBackendsFromEnv`: Tavily /
 *                Exa / SearXNG / DuckDuckGo / OpenRouter's Exa plugin; a
 *                backend that keeps failing is skipped for the run)
 *   fetch_page   one page through `readPage` (SSRF-guarded, policy deny
 *                lists, PDFs) — paged, with the page's links on the first page
 *   find_in_page lines of an already-read page that match a pattern, from the
 *                provenance cache (no new request)
 * Every page read lands in the run's `ProvenanceCache`, so each citation in the
 * answer can be traced to the text the agent saw.
 *
 * Formations:
 *   single  one loop researches and writes; the mechanical citation audit can
 *           ask for one repair pass.
 *   lead    a lead model splits the task into sub-questions; researchers run
 *           the loop on one each and report findings with URLs; the lead
 *           writes the answer (with tools to check); a DIFFERENT model checks
 *           each cited claim against the cached text of the page it cites; the
 *           lead revises once from that report; then the same audit.
 *
 * Budgets are in model turns (the 75 % steer and the forced final answer of
 * `budget-terminal.ts`) plus the caller's spend guard, checked before every
 * turn.
 */

import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { budgetFinalRequest, budgetSteerAt, budgetSteerNote } from "../agent/budget-terminal";
import { searchBackendsFromEnv } from "../arena/research/web-search";
import { getErrorMessage } from "../engine/errors";
import { standaloneSearchHttp } from "../engine/search-providers/asof-http";
import { recordSearchOutcome, searchBackendDown } from "../engine/search-providers/health";
import type { SearchHttp, SearchProvider, SearchResult } from "../engine/search-providers/index";
import type { BrowserReader } from "./browser-reader";
import {
  auditCitedUrls,
  type CitationAudit,
  citedUrls,
  citeOriginals,
  needsRepair,
  readUrlFor,
  repairRequest,
} from "./cited-answer";
import { type ModelTurns, messageText } from "./model-turn";
import { type PageRead, readPage } from "./page-reader";
import type { ProvenanceCache } from "./provenance-cache";

// ─── Tools ───────────────────────────────────────────────────────────────────

/** Characters of page text one fetch_page call returns. */
export const PAGE_WINDOW_CHARS = 12_000;
/** Links listed with the first window of a page. */
const LINKS_SHOWN = 60;
/** Tool-result characters kept in the conversation before old results are elided. */
const CONTEXT_TOOL_CHARS = 220_000;

export interface ToolEvent {
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  chars: number;
  ms: number;
}

/** What the tools act on: search, page reads and the provenance cache of one run. */
export interface ResearchEnvironment {
  cache: ProvenanceCache;
  search(query: string, max: number): Promise<SearchResult[]>;
  read(url: string): Promise<PageRead>;
  /** Search spend (USD) and backend use for the run record. */
  stats: {
    searches: number;
    searchFailures: number;
    searchUsd: number;
    reads: number;
    readFailures: number;
  };
  events: ToolEvent[];
}

export interface EnvironmentOptions {
  cache: ProvenanceCache;
  deny?: readonly string[];
  backends?: SearchProvider[];
  http?: SearchHttp;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. */
  read?: (url: string) => Promise<PageRead>;
  /** Called with each paid search's price (a run's spend guard). */
  onSearchSpend?: (usd: number) => void;
  /** Opt-in rendered reads for pages a plain fetch cannot read. */
  browser?: BrowserReader;
}

export function researchEnvironment(opts: EnvironmentOptions): ResearchEnvironment {
  const backends = opts.backends ?? searchBackendsFromEnv(opts.env).backends;
  const http = opts.http ?? standaloneSearchHttp();
  const failedHere = new Map<string, number>();
  const stats = { searches: 0, searchFailures: 0, searchUsd: 0, reads: 0, readFailures: 0 };
  const read =
    opts.read ??
    ((url: string) =>
      readPage(url, {
        cache: opts.cache,
        ...(opts.deny ? { deny: opts.deny } : {}),
        ...(opts.browser ? { browser: opts.browser } : {}),
      }));
  return {
    cache: opts.cache,
    stats,
    events: [],
    async search(query, max) {
      if (backends.length === 0) throw new Error("no search backend is configured");
      const open = backends.filter((b) => (failedHere.get(b.name) ?? 0) < 2);
      const up = open.filter((b) => !searchBackendDown(b.name));
      let last = "no search backend answered";
      for (const b of up.length ? up : open) {
        stats.searches++;
        const spend = { usd: 0 };
        try {
          const results = await b.search(query, { maxResults: max, engines: ["web"], spend }, http);
          recordSearchOutcome(b.name);
          stats.searchUsd += spend.usd;
          if (spend.usd > 0) opts.onSearchSpend?.(spend.usd);
          return results;
        } catch (e) {
          last = getErrorMessage(e);
          recordSearchOutcome(b.name, last);
          stats.searchFailures++;
          stats.searchUsd += spend.usd;
          if (spend.usd > 0) opts.onSearchSpend?.(spend.usd);
          failedHere.set(b.name, (failedHere.get(b.name) ?? 0) + 1);
        }
      }
      throw new Error(last.slice(0, 200));
    },
    async read(url) {
      stats.reads++;
      const r = await read(url);
      if (!r.ok) stats.readFailures++;
      return r;
    },
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool {
  return {
    name,
    description,
    parameters: { type: "object", properties, required } as unknown as Tool["parameters"],
  };
}

export const RESEARCH_TOOLS: Tool[] = [
  tool(
    "web_search",
    "Search the live web. Returns numbered results: title, URL and a short excerpt. Use specific queries; search again with different words when results are poor.",
    {
      query: { type: "string", description: "The search query." },
      max_results: { type: "integer", description: "Results to return (1-10, default 8)." },
    },
    ["query"],
  ),
  tool(
    "fetch_page",
    `Open a URL and read its text (${PAGE_WINDOW_CHARS} characters per call; pass offset to read further). The first window also lists the page's links. PDFs are supported.`,
    {
      url: { type: "string", description: "Absolute http(s) URL." },
      offset: {
        type: "integer",
        description: "Character offset to start reading from (default 0).",
      },
    },
    ["url"],
  ),
  tool(
    "find_in_page",
    "Find lines matching a pattern in a page you already opened (case-insensitive; separate alternatives with |). Returns the matching lines with neighbours. Cheaper than reading the page again.",
    {
      url: { type: "string", description: "A URL you opened with fetch_page." },
      pattern: {
        type: "string",
        description: "Words or phrases to find, e.g. monthly listeners|followers.",
      },
    },
    ["url", "pattern"],
  ),
];

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function int(v: unknown, dflt: number, lo: number, hi: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : dflt;
}

/** Execute one tool call; the result is the text the model sees. */
export async function executeResearchTool(
  env: ResearchEnvironment,
  name: string,
  args: Record<string, unknown>,
  agent = "agent",
): Promise<{ text: string; ok: boolean }> {
  const started = Date.now();
  let out: { text: string; ok: boolean };
  try {
    out = await runTool(env, name, args);
  } catch (e) {
    out = { text: `Error: ${getErrorMessage(e).slice(0, 300)}`, ok: false };
  }
  env.events.push({
    agent,
    tool: name,
    args,
    ok: out.ok,
    chars: out.text.length,
    ms: Date.now() - started,
  });
  return out;
}

async function runTool(
  env: ResearchEnvironment,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; ok: boolean }> {
  if (name === "web_search") {
    const query = str(args.query).trim();
    if (!query) return { text: "Error: query is empty.", ok: false };
    const results = await env.search(query.slice(0, 400), int(args.max_results, 8, 1, 10));
    if (results.length === 0) return { text: `No results for: ${query}`, ok: true };
    const lines = results.map((r, i) => {
      const snippet = (r.snippet || r.text || "").replace(/\s+/g, " ").trim().slice(0, 300);
      return `${i + 1}. ${r.title || "(untitled)"}\n   ${r.url}${r.published ? ` · ${r.published.slice(0, 10)}` : ""}${snippet ? `\n   ${snippet}` : ""}`;
    });
    return { text: lines.join("\n"), ok: true };
  }
  if (name === "fetch_page") {
    const url = normalizeUrl(str(args.url));
    if (!url) return { text: "Error: url must be an absolute http(s) URL.", ok: false };
    const offset = int(args.offset, 0, 0, 50_000_000);
    // A later window of a page already read comes from the cache, not a refetch.
    let text = offset > 0 && env.cache.readOk(url) ? env.cache.text(url) : undefined;
    let read: PageRead | undefined;
    if (text === undefined) {
      read = await env.read(url);
      if (!read.ok) {
        return {
          text: `Could not read ${url}: ${read.error ?? `HTTP ${read.status}`}.${read.refused ? "" : " Try another source."}`,
          ok: false,
        };
      }
      text = read.text;
    }
    const total = text.length;
    const window = text.slice(offset, offset + PAGE_WINDOW_CHARS);
    const head = [
      `URL: ${url}`,
      read?.title ? `Title: ${read.title}` : "",
      `Characters ${offset}-${offset + window.length} of ${total}${offset + window.length < total ? ` (more: offset ${offset + window.length})` : ""}`,
    ].filter(Boolean);
    const links =
      offset === 0 && read && read.links.length > 0
        ? `\n\nLinks (${Math.min(read.links.length, LINKS_SHOWN)} of ${read.links.length}):\n${read.links
            .slice(0, LINKS_SHOWN)
            .map((l) => `- ${l.text || "(no text)"} → ${l.url}`)
            .join("\n")}`
        : "";
    return {
      text: `${head.join("\n")}\n\n${window || "(no readable text — the page may need a browser; try another source)"}${links}`,
      ok: true,
    };
  }
  if (name === "find_in_page") {
    const url = normalizeUrl(str(args.url));
    const pattern = str(args.pattern).trim();
    if (!url || !pattern) return { text: "Error: url and pattern are required.", ok: false };
    let text = env.cache.readOk(url) ? env.cache.text(url) : undefined;
    if (text === undefined) {
      const r = await env.read(url);
      if (!r.ok)
        return { text: `Could not read ${url}: ${r.error ?? `HTTP ${r.status}`}.`, ok: false };
      text = r.text;
    }
    return { text: findLines(text, pattern), ok: true };
  }
  return { text: `Error: unknown tool ${name}.`, ok: false };
}

/** Lines of `text` that contain any `|`-separated alternative, with one neighbour each side. */
export function findLines(text: string, pattern: string, maxMatches = 25): string {
  const alts = pattern
    .split("|")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (alts.length === 0) return "No pattern.";
  const lines = text.split("\n");
  const hits: string[] = [];
  let shown = -1;
  for (let i = 0; i < lines.length && hits.length < maxMatches; i++) {
    const l = (lines[i] ?? "").toLowerCase();
    if (!alts.some((a) => l.includes(a))) continue;
    const from = Math.max(i - 1, shown + 1);
    const block = lines
      .slice(from, i + 2)
      .map((s) => s.trim().slice(0, 400))
      .filter(Boolean)
      .join(" / ");
    shown = i + 1;
    hits.push(`- ${block}`);
  }
  return hits.length
    ? `${hits.length} match(es):\n${hits.join("\n")}`
    : `No line matches "${pattern}".`;
}

function normalizeUrl(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const withScheme = /^https?:\/\//i.test(t)
    ? t
    : /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(t)
      ? `https://${t}`
      : "";
  try {
    return withScheme ? new URL(withScheme).toString() : undefined;
  } catch {
    return undefined;
  }
}

// ─── The loop ────────────────────────────────────────────────────────────────

export interface LoopOptions {
  model: ModelTurns;
  env: ResearchEnvironment;
  system: string;
  /** Opening user message. */
  prompt: string;
  maxTurns: number;
  agent?: string;
  /** Called before every model turn (a spend guard throws to stop the run). */
  beforeTurn?: () => void;
  /** Continue an earlier conversation (repair passes). */
  messages?: Message[];
  /** Tools off: one answer, no research. */
  tools?: boolean;
}

export interface LoopResult {
  text: string;
  messages: Message[];
  turns: number;
  toolCalls: number;
  budgetForced: boolean;
}

function userMessage(content: string): Message {
  return { role: "user", content, timestamp: Date.now() } as Message;
}

/**
 * Elide the oldest tool results once the conversation holds more than `cap`
 * characters of them; the newest `keep` results are never elided.
 */
export function elideOldToolResults(
  messages: Message[],
  cap = CONTEXT_TOOL_CHARS,
  keep = 3,
): number {
  const all = messages.filter((m) => m.role === "toolResult") as ToolResultMessage[];
  const results = all.slice(0, Math.max(0, all.length - keep));
  const size = (m: ToolResultMessage) =>
    m.content.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0);
  let total = all.reduce((n, m) => n + size(m), 0);
  if (total <= cap) return 0;
  let elided = 0;
  // Elide down to half the cap in one step so the cached prefix changes rarely.
  for (const m of results) {
    if (total <= cap / 2) break;
    const s = size(m);
    if (s <= 400) continue;
    const first = m.content.find((b) => b.type === "text");
    const head = first && first.type === "text" ? first.text.slice(0, 300) : "";
    (m as { content: ToolResultMessage["content"] }).content = [
      {
        type: "text",
        text: `${head}\n[older tool output elided to save context; use find_in_page or fetch_page again if needed]`,
      },
    ];
    total -= s - (head.length + 100);
    elided++;
  }
  return elided;
}

/** Run the tool loop until the model answers without a tool call, or the turn budget is spent. */
export async function researchLoop(o: LoopOptions): Promise<LoopResult> {
  const agent = o.agent ?? "agent";
  const messages: Message[] = o.messages ?? [];
  messages.push(userMessage(o.prompt));
  const tools = o.tools === false ? undefined : RESEARCH_TOOLS;
  const steerAt = budgetSteerAt(o.maxTurns);
  let steered = false;
  let toolCalls = 0;
  const ask = async (toolChoice?: "none"): Promise<AssistantMessage> => {
    o.beforeTurn?.();
    const ctx: Context = { systemPrompt: o.system, messages, ...(tools ? { tools } : {}) };
    return o.model.turn(ctx, toolChoice ? { toolChoice } : {});
  };
  for (let turn = 0; turn < o.maxTurns; turn++) {
    const reply = await ask();
    messages.push(reply as Message);
    const calls = (reply.content ?? []).filter((b): b is ToolCall => b.type === "toolCall");
    if (!tools || calls.length === 0) {
      return {
        text: messageText(reply),
        messages,
        turns: turn + 1,
        toolCalls,
        budgetForced: false,
      };
    }
    const results = await Promise.all(
      calls.map(async (c) => ({
        call: c,
        out: await executeResearchTool(
          o.env,
          c.name,
          (c.arguments ?? {}) as Record<string, unknown>,
          agent,
        ),
      })),
    );
    toolCalls += calls.length;
    const used = turn + 1;
    const steer = !steered && used >= steerAt && used < o.maxTurns;
    results.forEach(({ call, out }, i) => {
      const note =
        steer && i === results.length - 1
          ? `\n\n${budgetSteerNote(used, o.maxTurns, "turns")}`
          : "";
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: out.text + note }],
        isError: !out.ok,
        timestamp: Date.now(),
      } as Message);
    });
    if (steer) steered = true;
    elideOldToolResults(messages);
  }
  // The cap: one more turn, tools off — the best answer from what was found.
  messages.push(userMessage(budgetFinalRequest(o.maxTurns, "turns")));
  const reply = await ask("none");
  messages.push(reply as Message);
  return {
    text: messageText(reply),
    messages,
    turns: o.maxTurns + 1,
    toolCalls,
    budgetForced: true,
  };
}

// ─── Prompts (general; no benchmark-specific wording) ────────────────────────

export function answerSystemPrompt(today: string): string {
  return [
    `You are a web research agent. Today is ${today}. You research a task on the live web with your tools, then write the final answer.`,
    "",
    "How to research:",
    "- Read the task closely: every requested item, count, field, constraint and date range is part of the answer.",
    "- Search, then OPEN the pages (fetch_page). Search excerpts are leads, not evidence. Prefer official and primary pages.",
    "- Verify each requested detail on a page you opened. Follow links from pages you read. If a page will not load, find another source for the same fact.",
    "- Check candidates against every constraint before you include them; replace any that fail.",
    "",
    "How to answer (when you stop calling tools, your reply IS the final answer):",
    "- Markdown. Cover every part of the task, item by item, with the requested details.",
    "- Put the source URL right after each fact, as a markdown link or a bare URL: the exact URL of a page you opened that states the fact. Not a search-results page, not a site's home page.",
    "- A source must state the claim itself. A claim that links two things (A wrote B, A is part of B, A costs X at B) needs a page that shows the link — cite it on that line, alongside any page about A alone.",
    "- When the task asks for a link to something, give the direct URL of that thing.",
    "- Cite the page's own URL — never a search, reader-proxy or cache URL that fetched it for you.",
    "- Never invent a fact or a URL. If something could not be verified, say so plainly.",
    "- No padding: no methodology essay, no repeated summaries.",
  ].join("\n");
}

export function researcherSystemPrompt(today: string): string {
  return [
    `You are a researcher on a web research team. Today is ${today}. Your lead gave you one part of a larger task. Research it on the live web with your tools.`,
    "Open the pages (fetch_page); search excerpts are leads, not evidence. Prefer official and primary pages.",
    "When done, reply (no tool call) with your findings as a list: each finding is one fact, the exact URL of the page you opened that states it, and a short verbatim quote from that page. Then list open questions and dead ends briefly. Never invent a fact, URL or quote.",
  ].join("\n");
}

export interface Formation {
  kind: "single" | "lead";
  /** Researcher count for `lead`. */
  researchers?: number;
}

export interface RunOptions {
  task: string;
  env: ResearchEnvironment;
  lead: ModelTurns;
  /** Researchers' model (default: the lead's). */
  researcher?: ModelTurns;
  /** Citation verifier — a different model by design (default: none). */
  verifier?: ModelTurns;
  formation: Formation;
  maxTurns: number;
  researcherTurns?: number;
  today?: string;
  beforeTurn?: () => void;
  /** Repair pass after the audit (default true). */
  repair?: boolean;
  log?: (line: string) => void;
}

export interface VerificationReport {
  checked: number;
  problems: Array<{ claim: string; url: string; verdict: string; note?: string }>;
}

export interface ResearchAnswer {
  answer: string;
  audit: CitationAudit;
  repaired: boolean;
  turns: number;
  toolCalls: number;
  budgetForced: boolean;
  plan?: string[];
  verification?: VerificationReport;
}

/** Run one task end to end and return the citation-backed answer. */
export async function runResearch(o: RunOptions): Promise<ResearchAnswer> {
  const today = o.today ?? new Date().toISOString().slice(0, 10);
  const log = o.log ?? (() => undefined);
  if (o.formation.kind === "single") {
    const loop = await researchLoop({
      model: o.lead,
      env: o.env,
      system: answerSystemPrompt(today),
      prompt: `Task:\n${o.task}`,
      maxTurns: o.maxTurns,
      agent: "single",
      ...(o.beforeTurn ? { beforeTurn: o.beforeTurn } : {}),
    });
    return finish(
      o,
      loop,
      answerSystemPrompt(today),
      { turns: loop.turns, toolCalls: loop.toolCalls },
      log,
    );
  }

  // lead: plan → researchers → write → verify → revise → audit
  const n = Math.max(1, Math.min(o.formation.researchers ?? 3, 6));
  const plan = await planSubtasks(o, n, today);
  log(`plan: ${plan.length} part(s)`);
  const researcher = o.researcher ?? o.lead;
  const findings = await Promise.all(
    plan.map(async (part, i) => {
      try {
        const r = await researchLoop({
          model: researcher,
          env: o.env,
          system: researcherSystemPrompt(today),
          prompt: `The whole task (for context):\n${o.task}\n\nYour part:\n${part}`,
          maxTurns: o.researcherTurns ?? Math.max(6, Math.round(o.maxTurns / 2)),
          agent: `researcher-${i + 1}`,
          ...(o.beforeTurn ? { beforeTurn: o.beforeTurn } : {}),
        });
        return { part, text: r.text, turns: r.turns, toolCalls: r.toolCalls };
      } catch (e) {
        // A budget stop is not a finding: let it end the run.
        if ((e as Error).name === "BudgetExhausted") throw e;
        return {
          part,
          text: `(researcher failed: ${getErrorMessage(e).slice(0, 160)})`,
          turns: 0,
          toolCalls: 0,
        };
      }
    }),
  );
  const brief = findings
    .map((f, i) => `## Researcher ${i + 1}: ${f.part}\n${f.text || "(no findings)"}`)
    .join("\n\n");
  const system = answerSystemPrompt(today);
  const written = await researchLoop({
    model: o.lead,
    env: o.env,
    system,
    prompt: `Task:\n${o.task}\n\nYour researchers' findings are below. Check anything doubtful or missing with your tools, then write the final answer. Cite only pages that were opened (by you or a researcher).\n\n${brief}`,
    maxTurns: Math.max(4, Math.round(o.maxTurns / 2)),
    agent: "lead",
    ...(o.beforeTurn ? { beforeTurn: o.beforeTurn } : {}),
  });
  let loop = written;
  let verification: VerificationReport | undefined;
  if (o.verifier && written.text) {
    verification = await verifyCitations(
      o.verifier,
      o.env.cache,
      o.task,
      written.text,
      o.beforeTurn,
    );
    log(`verifier: ${verification.checked} checked, ${verification.problems.length} problem(s)`);
    if (verification.problems.length > 0) {
      const report = verification.problems
        .slice(0, 30)
        .map((p) => `- [${p.verdict}] ${p.claim} — ${p.url}${p.note ? ` (${p.note})` : ""}`)
        .join("\n");
      loop = await researchLoop({
        model: o.lead,
        env: o.env,
        system,
        messages: written.messages,
        prompt: `[Citation verifier] An independent checker compared your cited claims with the text of the pages they cite and found these problems:\n${report}\n\nFix each one: find a page that supports the claim (open it), correct the claim, or remove it. Then give the complete final answer again.`,
        maxTurns: 8,
        agent: "lead",
        ...(o.beforeTurn ? { beforeTurn: o.beforeTurn } : {}),
      });
      if (!loop.text) loop = written;
    }
  }
  const turns =
    findings.reduce((s, f) => s + f.turns, 0) + written.turns + (loop === written ? 0 : loop.turns);
  const toolCalls =
    findings.reduce((s, f) => s + f.toolCalls, 0) +
    written.toolCalls +
    (loop === written ? 0 : loop.toolCalls);
  const out = await finish(o, loop, system, { turns, toolCalls }, log);
  return { ...out, plan, ...(verification ? { verification } : {}) };
}

async function finish(
  o: RunOptions,
  loop: LoopResult,
  system: string,
  counts: { turns: number; toolCalls: number },
  log: (line: string) => void,
): Promise<ResearchAnswer> {
  let answer = citeOriginals(loop.text);
  let audit = auditCitedUrls(answer, o.env.cache);
  let repaired = false;
  let { turns, toolCalls } = counts;
  if ((o.repair ?? true) && answer && needsRepair(audit)) {
    log(
      `audit: ${audit.unread.length} unread, ${audit.failed.length} failed of ${audit.cited} cited — repair pass`,
    );
    const fix = await researchLoop({
      model: o.lead,
      env: o.env,
      system,
      messages: loop.messages,
      prompt: repairRequest(audit),
      maxTurns: 6,
      agent: "repair",
      ...(o.beforeTurn ? { beforeTurn: o.beforeTurn } : {}),
    });
    turns += fix.turns;
    toolCalls += fix.toolCalls;
    // Keep the repaired text only when it is a full answer that cites sources.
    if (fix.text && citedUrls(fix.text).length > 0) {
      answer = citeOriginals(fix.text);
      audit = auditCitedUrls(answer, o.env.cache);
      repaired = true;
    }
  }
  return { answer, audit, repaired, turns, toolCalls, budgetForced: loop.budgetForced };
}

/** The lead's plan: up to `n` complementary sub-questions (JSON array of strings). */
async function planSubtasks(o: RunOptions, n: number, today: string): Promise<string[]> {
  o.beforeTurn?.();
  const reply = await o.lead.turn({
    systemPrompt: `You lead a web research team. Today is ${today}. Split a task into parts that researchers can pursue in parallel.`,
    messages: [
      userMessage(
        `Task:\n${o.task}\n\nSplit it into at most ${n} complementary research parts (fewer when the task is small). Each part must be self-contained and say exactly what to find and verify, with URLs. Reply with a JSON array of strings only.`,
      ),
    ],
  });
  const parsed = parseJsonArray(messageText(reply));
  return parsed.length > 0 ? parsed.slice(0, n) : [o.task];
}

export function parseJsonArray(text: string): string[] {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]) as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

// ─── Cross-model citation verification ───────────────────────────────────────

const VERIFY_PAGE_CHARS = 6_000;
const VERIFY_MAX_URLS = 25;

/** The passages of `text` most relevant to `about` (term overlap), within `budget` characters. */
export function relevantPassages(text: string, about: string, budget = VERIFY_PAGE_CHARS): string {
  if (text.length <= budget) return text;
  const terms = new Set(
    about
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 2),
  );
  const paras = text.split(/\n+/).filter((p) => p.trim().length > 0);
  const scored = paras.map((p, i) => {
    const words = p.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    let s = 0;
    for (const w of words) if (terms.has(w)) s++;
    return { i, p, s };
  });
  const picked = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
  const keep = new Set<number>();
  let used = 0;
  for (const x of picked) {
    if (used + x.p.length > budget) continue;
    keep.add(x.i);
    used += x.p.length + 1;
  }
  if (keep.size === 0) return text.slice(0, budget);
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => paras[i]!.slice(0, 1_500))
    .join("\n");
}

/**
 * Ask `verifier` (a different model) whether each cited claim is supported by
 * the cached text of the page it cites. Pages the run never read successfully
 * are reported without a model call.
 */
export async function verifyCitations(
  verifier: ModelTurns,
  cache: ProvenanceCache,
  task: string,
  answer: string,
  beforeTurn?: () => void,
): Promise<VerificationReport> {
  const urls = citedUrls(answer).slice(0, VERIFY_MAX_URLS);
  const problems: VerificationReport["problems"] = [];
  const pages: string[] = [];
  for (const url of urls) {
    const key = readUrlFor(cache, url);
    if (!key) {
      problems.push({
        claim: "(claims citing this URL)",
        url,
        verdict: "unreadable",
        note: "the page was never read successfully",
      });
      continue;
    }
    const near = answer
      .split("\n")
      .filter((l) => l.includes(url))
      .join(" ");
    pages.push(`=== ${url}\n${relevantPassages(cache.text(key) ?? "", near || task)}`);
  }
  if (pages.length === 0) return { checked: urls.length, problems };
  beforeTurn?.();
  const reply = await verifier.turn({
    systemPrompt:
      "You check citations. For each claim in an answer that cites a URL, decide whether the cited page text supports it. Judge only against the page text given; do not use outside knowledge.",
    messages: [
      userMessage(
        [
          `Task the answer responds to:\n${task}`,
          `Answer:\n${answer}`,
          `Cited page text (excerpts, as the author read them):\n${pages.join("\n\n")}`,
          'List every cited claim that the page text does NOT support. Reply with a JSON array only: [{"claim": "...", "url": "...", "verdict": "unsupported" | "contradicted", "note": "what the page says instead, briefly"}]. Reply [] when every claim is supported.',
        ].join("\n\n"),
      ),
    ],
  });
  for (const p of parseProblems(messageText(reply))) problems.push(p);
  return { checked: urls.length, problems };
}

function parseProblems(text: string): VerificationReport["problems"] {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) => {
      if (!x || typeof x !== "object") return [];
      const r = x as Record<string, unknown>;
      const claim = str(r.claim).slice(0, 400);
      const url = str(r.url).slice(0, 400);
      if (!claim) return [];
      return [
        {
          claim,
          url,
          verdict: str(r.verdict) || "unsupported",
          ...(str(r.note) ? { note: str(r.note).slice(0, 300) } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}
