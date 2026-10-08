// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The pre-write review: before a reply's state-changing call runs, one judge
 * call asks up to two questions about it (`MARINA_OBLIGATIONS_REVIEW`, read
 * live; it rides on the obligations ledger, which knows the open requests):
 *
 *   order     with two or more open requests: would carrying out this call now
 *             prevent one of the others, or change its terms (amounts, limits,
 *             eligibility, fees, availability)? Asked until it has nudged once.
 *   evidence  does the call rely on a condition (eligibility, status, a limit,
 *             identity, a rule's requirement) that no recent tool result shows?
 *             Asked until it has nudged once.
 *
 *   off      nothing runs, no call is made (the default);
 *   observe  the questions are asked and counted; the reply is untouched;
 *   on       a "yes" (each kind at most once per conversation) gets ONE retry
 *            (passthru) or a one-time refusal (agent loops; the same call issued
 *            again runs) with a note naming the concern. The model decides; a
 *            call is never rewritten or blocked for good.
 *
 * At most {@link MAX_REVIEWS} judge calls per conversation. Any judge failure is
 * "unjudged" and the call runs (fail open). General by construction: the
 * questions use only the open requests, the drafted calls and the tool results
 * the conversation already holds — no domain knowledge.
 */

import { extractJsonObject } from "../decisions/providers";
import { noul } from "../decisions/questions";
import type { DecisionProvider } from "../decisions/types";
import type { CompleteText } from "./extract";
import { looksLikeError, MAX_LISTED, type Obligation, type ObligationLedger } from "./ledger";

export type ReviewMode = "off" | "observe" | "on";

export function obligationsReviewMode(env: NodeJS.ProcessEnv = process.env): ReviewMode {
  const v = env.MARINA_OBLIGATIONS_REVIEW?.trim().toLowerCase();
  return v === "on" || v === "observe" ? v : "off";
}

/** Judge calls per conversation (each covers one reply's write calls). */
export const MAX_REVIEWS = 4;
/** Clamps on what the judge sees. */
const RESULT_MAX_CHARS = 300;
const ARGS_MAX_CHARS = 400;
const DRAFT_MAX_CHARS = 800;
/** Recent tool results shown to the judge. */
export const MAX_RECENT_RESULTS = 6;

/** Per-conversation counters and once-only flags (kept on the ledger). */
export interface ReviewState {
  reviews: number;
  orderRisks: number;
  evidenceGaps: number;
  unjudged: number;
  nudges: number;
  orderNudged: boolean;
  evidenceNudged: boolean;
}

export function reviewState(ledger: ObligationLedger): ReviewState {
  ledger.review ??= {
    reviews: 0,
    orderRisks: 0,
    evidenceGaps: 0,
    unjudged: 0,
    nudges: 0,
    orderNudged: false,
    evidenceNudged: false,
  };
  return ledger.review;
}

export interface PendingCall {
  name: string;
  args: unknown;
}

export interface RecentResult {
  name: string;
  ok: boolean;
  /** The result text, clamped. */
  result: string;
}

export interface ReviewQuestions {
  order: boolean;
  evidence: boolean;
}

/**
 * Which questions this reply gets, or undefined when none (budget spent, or both
 * kinds already nudged). `order` needs at least two open requests.
 */
export function reviewQuestions(
  state: ReviewState,
  open: readonly Obligation[],
): ReviewQuestions | undefined {
  if (state.reviews >= MAX_REVIEWS) return undefined;
  const q = { order: open.length >= 2 && !state.orderNudged, evidence: !state.evidenceNudged };
  return q.order || q.evidence ? q : undefined;
}

export interface ReviewInput {
  open: readonly Obligation[];
  calls: readonly PendingCall[];
  /** The text the model wrote alongside the call(s), if any. */
  draft: string;
  recent: readonly RecentResult[];
}

export type ReviewVerdict = ReviewQuestions;

function clamp(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)} […]`;
}

function renderCall(c: PendingCall): string {
  let a: string;
  try {
    a = typeof c.args === "string" ? c.args : JSON.stringify(c.args);
  } catch {
    a = String(c.args);
  }
  return `${c.name}(${clamp(a ?? "", ARGS_MAX_CHARS)})`;
}

function renderOpen(o: Obligation): string {
  return `${o.id}: ${o.what}${o.target ? ` (target: ${o.target})` : ""}${o.constraints ? ` [${o.constraints}]` : ""}`;
}

/** The judge's view: open requests, recent tool results, the drafted call(s) and text. */
export function reviewView(input: ReviewInput): string {
  return [
    `OPEN REQUESTS:\n${input.open.slice(-MAX_LISTED).map(renderOpen).join("\n") || "(none)"}`,
    `RECENT TOOL RESULTS (oldest first):\n${
      input.recent
        .slice(-MAX_RECENT_RESULTS)
        .map((r) => `${r.ok ? "ok" : "failed"} ${r.name}: ${r.result}`)
        .join("\n") || "(none)"
    }`,
    `DRAFTED CALLS:\n${input.calls.map(renderCall).join("\n")}`,
    input.draft.trim() ? `DRAFTED TEXT:\n${clamp(input.draft.trim(), DRAFT_MAX_CHARS)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const ORDER_QUESTION =
  "Would carrying out the DRAFTED CALLS now, before the other OPEN REQUESTS, plausibly prevent one of them or change its terms (amounts, limits, eligibility, fees, availability)? Answer yes only if the order plausibly matters.";
const EVIDENCE_QUESTION =
  "Do the DRAFTED CALLS rely on a condition (eligibility, account or order status, a balance or limit, identity, a requirement of the rules) that none of the RECENT TOOL RESULTS shows? Answer yes only if such a condition is assumed but not shown.";

const REVIEW_SYSTEM = [
  "You review a state-changing action an assistant is about to take. Answer each question with yes or no.",
  `order: ${ORDER_QUESTION}`,
  `evidence: ${EVIDENCE_QUESTION}`,
  'Reply with JSON only, with the keys you are asked: {"order":"yes"|"no","evidence":"yes"|"no"}.',
].join(" ");

/** A noul probability is a yes above this. */
const YES_ABOVE = 0.5;

/**
 * Ask the questions in `ask` about one reply's write calls. With a decision
 * provider: one `noul` question each; else the chat model answers in JSON.
 * Undefined when no judge answered (the caller lets the call run).
 */
export async function reviewWrite(
  input: ReviewInput,
  ask: ReviewQuestions,
  judge: { provider?: DecisionProvider; complete?: CompleteText },
  signal?: AbortSignal,
): Promise<ReviewVerdict | undefined> {
  const state = reviewView(input);
  if (judge.provider) {
    try {
      const questions: Record<string, ReturnType<typeof noul>> = {};
      if (ask.order) questions.order = noul(ORDER_QUESTION);
      if (ask.evidence) questions.evidence = noul(EVIDENCE_QUESTION);
      const res = await judge.provider.ask({ state, questions }, signal);
      const yes = (k: string): boolean | undefined => {
        const a = res.answers[k];
        if (a?.type !== "noul") return undefined;
        return a.noul > YES_ABOVE;
      };
      const order = ask.order ? yes("order") : false;
      const evidence = ask.evidence ? yes("evidence") : false;
      if (order === undefined || evidence === undefined) return undefined;
      return { order, evidence };
    } catch {
      return undefined;
    }
  }
  if (!judge.complete) return undefined;
  try {
    const keys = [ask.order ? "order" : "", ask.evidence ? "evidence" : ""].filter(Boolean);
    const raw = extractJsonObject(
      await judge.complete(REVIEW_SYSTEM, `${state}\n\nANSWER: ${keys.join(", ")}`),
    ) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return undefined;
    const yes = (k: string): boolean | undefined => {
      const v = raw[k];
      if (typeof v !== "string") return undefined;
      const t = v.trim().toLowerCase();
      return t === "yes" ? true : t === "no" ? false : undefined;
    };
    const order = ask.order ? yes("order") : false;
    const evidence = ask.evidence ? yes("evidence") : false;
    if (order === undefined || evidence === undefined) return undefined;
    return { order, evidence };
  } catch {
    return undefined;
  }
}

/**
 * Record a verdict on the conversation's state. Returns the kinds that should
 * be NAMED now: a "yes" never named before (the caller nudges only in `on`, and
 * marks them named with {@link markNamed}).
 */
export function recordReview(
  state: ReviewState,
  verdict: ReviewVerdict | undefined,
): ReviewQuestions {
  state.reviews++;
  if (!verdict) {
    state.unjudged++;
    return { order: false, evidence: false };
  }
  if (verdict.order) state.orderRisks++;
  if (verdict.evidence) state.evidenceGaps++;
  return {
    order: verdict.order && !state.orderNudged,
    evidence: verdict.evidence && !state.evidenceNudged,
  };
}

export function markNamed(state: ReviewState, named: ReviewQuestions): void {
  if (named.order) state.orderNudged = true;
  if (named.evidence) state.evidenceNudged = true;
  state.nudges++;
}

/** The label for a log line / header: what the review found on this reply. */
export function reviewLabel(verdict: ReviewVerdict | undefined): string {
  if (!verdict) return "review-unjudged";
  const kinds = [verdict.order ? "order" : "", verdict.evidence ? "evidence" : ""].filter(Boolean);
  return kinds.length ? `review-${kinds.join("+")}` : "review-clear";
}

/**
 * The note for a named concern. It names the call and the concern, never a
 * fix, and says plainly that the call may be made again unchanged.
 */
export function reviewNote(input: ReviewInput, named: ReviewQuestions): string {
  const others = input.open.slice(-MAX_LISTED).map((o) => `- ${renderOpen(o)}`);
  return [
    "[Marina pre-write review — not from the user]",
    `You are about to call: ${input.calls.map(renderCall).join("; ")}`,
    ...(named.order
      ? [
          "Order: carrying this out now may prevent another open request or change its terms. Open requests:",
          ...others,
          "Check whether another request should come first, or whether the user should choose.",
        ]
      : []),
    ...(named.evidence
      ? [
          "Evidence: this call relies on a condition that no tool result in this conversation shows yet. If a tool can check it, check it first; if the rules do not require it, proceed.",
        ]
      : []),
    "If the call is right as it is, make it again unchanged. Write only your next message (or the tool call); do not mention this review.",
  ].join("\n");
}

/** The latest tool results in an OpenAI-style or pi transcript (names, ok, clamped text). */
export function recentToolResults(messages: readonly unknown[]): RecentResult[] {
  const names = new Map<string, string>();
  const out: RecentResult[] = [];
  for (const raw of messages) {
    const m = raw as {
      role?: string;
      content?: unknown;
      tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
      tool_call_id?: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
    };
    if (m?.role === "assistant") {
      for (const c of m.tool_calls ?? [])
        if (c.id && c.function?.name) names.set(c.id, c.function.name);
      continue;
    }
    if (m?.role !== "tool" && m?.role !== "toolResult") continue;
    const text = contentText(m.content);
    const id = m.tool_call_id ?? m.toolCallId;
    const name = m.toolName ?? (id ? names.get(id) : undefined) ?? "tool";
    out.push({
      name,
      ok: m.isError === true ? false : !looksLikeError(text),
      result: clamp(text.replace(/\s+/g, " ").trim(), RESULT_MAX_CHARS),
    });
  }
  return out.slice(-MAX_RECENT_RESULTS);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: unknown }>)
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}
