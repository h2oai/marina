// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The model calls behind the obligations ledger: extraction (new requests →
 * obligations), ambiguous-match resolution, and the final-reply check. Each
 * takes an injected text-completion function (any chat model — one local model
 * is enough) and, for the two judgements, an optional decision provider
 * (`src/decisions`): with one configured, the judgements are `choice` / `noul`
 * questions answered with numbers; without one, the same chat model answers in
 * JSON. Every failure returns `undefined` — the caller treats that as "no
 * change" (the ledger degrades to off, it never blocks a reply).
 */

import { extractJsonObject } from "../decisions/providers";
import { choice } from "../decisions/questions";
import type { DecisionProvider } from "../decisions/types";
import type { ExtractedObligation, Extraction, Obligation, ToolCallRecord } from "./ledger";

/** One text completion. Throws on failure; the callers here catch. */
export type CompleteText = (system: string, user: string) => Promise<string>;

/** Clamps on what the extractor and the judge see. */
const REQUEST_MAX_CHARS = 3000;
const CONTEXT_MAX_CHARS = 1200;
const TOOL_DESC_MAX_CHARS = 120;
const MAX_TOOLS_LISTED = 60;

function clamp(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)} […]`;
}

export interface ToolInfo {
  name: string;
  description?: string;
  /** False for read-only lookups (they never carry an obligation out). */
  write: boolean;
}

export interface NewRequest {
  /** 1-based request number. */
  turn: number;
  text: string;
  /** The assistant's message just before it (context for "yes, do that"). */
  before?: string;
}

export const EXTRACT_SYSTEM = [
  "You keep the ledger of what an assistant still owes in a conversation.",
  "From the NEW request(s), list each concrete action the requester asked the assistant to carry out that changes something through one of its state-changing tools",
  "(for example: update, cancel, refund, book, exchange, transfer money, file, close, open, enable).",
  "Do not list: questions to answer, lookups, verification steps, things the requester must do themselves, or anything already in the open list.",
  "A request that only confirms or chooses among options for an existing open item adds nothing.",
  "Also list the ids of open items the requester withdrew or replaced.",
  "Also list the ids of open items a NEW request explicitly approves exactly as the assistant last described them (an unambiguous yes or go-ahead; not a question, a condition or a change).",
  'Reply with JSON only: {"add":[{"request":<NEW REQUEST number>,"what":"<≤ 12 words>","target":"<id or name, optional>","constraints":"<amounts, dates, options; optional>","tools":["<candidate tool names from the list>"]}],"cancel":["<open id>"],"consent":["<open id>"]}',
  'When nothing applies, reply {"add":[],"cancel":[],"consent":[]}.',
].join(" ");

/** The extractor's user message: tools, open items, then the new request(s). */
export function extractionInput(input: {
  tools: ToolInfo[];
  open: Obligation[];
  requests: NewRequest[];
}): string {
  const writes = input.tools.filter((t) => t.write).slice(0, MAX_TOOLS_LISTED);
  const toolLines = writes.map(
    (t) =>
      `- ${t.name}${t.description ? `: ${clamp(t.description.replace(/\s+/g, " "), TOOL_DESC_MAX_CHARS)}` : ""}`,
  );
  const openLines = input.open.map(
    (o) => `- ${o.id}: ${o.what}${o.target ? ` (target: ${o.target})` : ""}`,
  );
  const reqs = input.requests.map((r) =>
    [
      r.before ? `ASSISTANT BEFORE REQUEST ${r.turn}:\n${clamp(r.before, CONTEXT_MAX_CHARS)}` : "",
      `NEW REQUEST ${r.turn}:\n${clamp(r.text, REQUEST_MAX_CHARS)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return [
    `STATE-CHANGING TOOLS:\n${toolLines.join("\n") || "(none listed)"}`,
    `OPEN ITEMS:\n${openLines.join("\n") || "(none)"}`,
    ...reqs,
  ].join("\n\n");
}

/** Lenient parse of the extractor's reply; undefined when it is not the expected JSON. */
export function parseExtraction(text: string): Extraction | undefined {
  let raw: unknown;
  try {
    raw = extractJsonObject(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as { add?: unknown; cancel?: unknown };
  const add: ExtractedObligation[] = [];
  if (Array.isArray(r.add)) {
    for (const item of r.add.slice(0, 8)) {
      if (!item || typeof item !== "object") continue;
      const i = item as Record<string, unknown>;
      if (typeof i.what !== "string" || !i.what.trim()) continue;
      add.push({
        what: i.what,
        ...(typeof i.target === "string" && i.target.trim() ? { target: i.target } : {}),
        ...(typeof i.constraints === "string" && i.constraints.trim()
          ? { constraints: i.constraints }
          : {}),
        ...(typeof i.request === "number" && Number.isFinite(i.request) ? { turn: i.request } : {}),
        tools: Array.isArray(i.tools)
          ? i.tools.filter((t): t is string => typeof t === "string")
          : [],
      });
    }
  }
  const ids = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((c): c is string => typeof c === "string" && /^o\d+$/.test(c)) : [];
  const cancel = ids(r.cancel);
  const consent = ids((r as { consent?: unknown }).consent);
  if (!Array.isArray(r.add) && !Array.isArray(r.cancel)) return undefined;
  return { add, cancel, ...(consent.length ? { consent } : {}) };
}

/** Run the extractor; undefined on any failure. */
export async function extractObligations(
  complete: CompleteText,
  input: { tools: ToolInfo[]; open: Obligation[]; requests: NewRequest[] },
): Promise<Extraction | undefined> {
  try {
    return parseExtraction(await complete(EXTRACT_SYSTEM, extractionInput(input)));
  } catch {
    return undefined;
  }
}

// ─── Ambiguous matches ───────────────────────────────────────────────────────

function renderCall(call: ToolCallRecord): string {
  let args: string;
  try {
    args = typeof call.args === "string" ? call.args : JSON.stringify(call.args);
  } catch {
    args = String(call.args);
  }
  return `${call.name}(${clamp(args ?? "", 600)})`;
}

function renderObligation(o: Obligation): string {
  return `${o.id}: ${o.what}${o.target ? ` (target: ${o.target})` : ""}${o.constraints ? ` [${o.constraints}]` : ""}`;
}

const MATCH_SYSTEM =
  "Decide which open request a successful tool call carried out. " +
  'Reply with JSON only: {"match":"<request id>"} or {"match":"none"} when it carried out none of them.';

/**
 * Which of `candidates` the call carried out, or undefined (none / no answer).
 * With a decision provider: one `choice` question; else the chat model in JSON.
 */
export async function resolveMatch(
  call: ToolCallRecord,
  candidates: Obligation[],
  judge: { provider?: DecisionProvider; complete?: CompleteText },
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (candidates.length === 0) return undefined;
  const ids = new Set(candidates.map((c) => c.id));
  if (judge.provider) {
    try {
      const criteria: Record<string, string | null> = { none: "it carried out none of them" };
      for (const c of candidates) criteria[c.id] = renderObligation(c);
      const res = await judge.provider.ask(
        {
          state: { tool_call: renderCall(call), open_requests: candidates.map(renderObligation) },
          questions: {
            match: choice(
              "Which open request did this successful tool call carry out? Pick none unless the call clearly performs it.",
              criteria,
            ),
          },
        },
        signal,
      );
      const a = res.answers.match;
      const pick = a?.type === "choice" ? a.choice : undefined;
      return pick && ids.has(pick) ? pick : undefined;
    } catch {
      return undefined;
    }
  }
  if (!judge.complete) return undefined;
  try {
    const text = await judge.complete(
      MATCH_SYSTEM,
      `TOOL CALL (succeeded):\n${renderCall(call)}\n\nOPEN REQUESTS:\n${candidates.map(renderObligation).join("\n")}`,
    );
    const raw = extractJsonObject(text) as { match?: unknown } | undefined;
    const pick = typeof raw?.match === "string" ? raw.match : undefined;
    return pick && ids.has(pick) ? pick : undefined;
  } catch {
    return undefined;
  }
}

// ─── The final-reply check ───────────────────────────────────────────────────

/** What a final reply means for one open obligation. */
export type FinalVerdict = "owed" | "waiting" | "declined" | "done";

const VERDICT_CRITERIA: Record<FinalVerdict, string> = {
  owed: "still owed: not carried out, not declined with a reason, not transferred, and the reply does not wait on the requester for it",
  waiting:
    "waiting on the requester: the reply asks for a confirmation, details or a choice needed before acting",
  declined:
    "handled by declining: the reply refuses it, explains it is not allowed or not possible, or hands it to someone else",
  done: "already carried out earlier in the conversation",
};

const CHECK_SYSTEM = [
  "An assistant is about to send a reply with no tool call. For each open request, classify its status given the reply and the recent actions.",
  `owed = ${VERDICT_CRITERIA.owed}; waiting = ${VERDICT_CRITERIA.waiting};`,
  `declined = ${VERDICT_CRITERIA.declined}; done = ${VERDICT_CRITERIA.done}.`,
  'Reply with JSON only, one key per request id: {"o1":"owed"|"waiting"|"declined"|"done", …}.',
].join(" ");

export interface FinalCheckInput {
  open: Obligation[];
  /** The reply the model drafted (no tool calls). */
  draft: string;
  /** The latest request text. */
  lastRequest?: string;
  /** The most recent tool calls, newest last. */
  recentCalls: ToolCallRecord[];
}

function checkState(input: FinalCheckInput): string {
  return [
    `OPEN REQUESTS:\n${input.open.map(renderObligation).join("\n")}`,
    input.lastRequest ? `LATEST REQUEST:\n${clamp(input.lastRequest, CONTEXT_MAX_CHARS)}` : "",
    `RECENT ACTIONS:\n${
      input.recentCalls
        .slice(-8)
        .map((c) => `${c.ok ? "ok" : "failed"} ${renderCall(c)}`)
        .join("\n") || "(none)"
    }`,
    `DRAFTED REPLY:\n${clamp(input.draft, REQUEST_MAX_CHARS)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const VERDICTS = new Set<FinalVerdict>(["owed", "waiting", "declined", "done"]);

/**
 * Classify each open obligation against a final reply. Returns undefined when
 * no judge answered (the caller then does nothing — fail open, no nudge).
 */
export async function checkFinalReply(
  input: FinalCheckInput,
  judge: { provider?: DecisionProvider; complete?: CompleteText },
  signal?: AbortSignal,
): Promise<Record<string, FinalVerdict> | undefined> {
  if (input.open.length === 0) return {};
  const ids = input.open.map((o) => o.id);
  if (judge.provider) {
    try {
      const questions: Record<string, ReturnType<typeof choice>> = {};
      for (const id of ids.slice(0, 12)) {
        questions[id] = choice(
          `What is the status of open request ${id} if the drafted reply is sent now?`,
          { ...VERDICT_CRITERIA },
        );
      }
      const res = await judge.provider.ask({ state: checkState(input), questions }, signal);
      const out: Record<string, FinalVerdict> = {};
      for (const id of Object.keys(questions)) {
        const a = res.answers[id];
        const v = a?.type === "choice" ? (a.choice as FinalVerdict) : undefined;
        if (v && VERDICTS.has(v)) out[id] = v;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  }
  if (!judge.complete) return undefined;
  try {
    const raw = extractJsonObject(await judge.complete(CHECK_SYSTEM, checkState(input)));
    if (!raw || typeof raw !== "object") return undefined;
    const out: Record<string, FinalVerdict> = {};
    for (const id of ids) {
      const v = (raw as Record<string, unknown>)[id];
      if (typeof v === "string" && VERDICTS.has(v as FinalVerdict)) out[id] = v as FinalVerdict;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
