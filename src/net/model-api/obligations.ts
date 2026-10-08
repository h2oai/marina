// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The obligations ledger on the `/v1/chat/completions` passthru (opt-in:
// `marina/obligations:<model>` or `x-marina-obligations: on|observe`). Before
// the upstream call: read the new requests into obligations (one cheap model
// call per new request batch) and settle the ones a successful state-changing
// tool call carried out. `on` appends the open ones as a trailing note AFTER the
// cache breakpoints (`proxyToUpstream`'s `trailingNote`), so the cached prefix
// is unchanged. After the call (non-streaming): a reply with no tool call that
// would leave an obligation open is checked once (decision layer when
// configured, else the ledger's chat model) and, when one is still owed, the
// model is asked again with a one-time note that quotes its draft. The model's
// text is never edited; a failed check or retry returns the draft. Without the
// opt-in nothing here runs and the request is byte-identical.

import { createHash } from "node:crypto";
import { harnessDecisionProvider } from "../../decisions/engines";
import type { DecisionProvider } from "../../decisions/types";
import type { Engine } from "../../engine/engine";
import { getErrorMessage } from "../../engine/errors";
import { Logger } from "../../engine/logger";
import { noteOutcome } from "../../learning/service";
import {
  type CompleteText,
  checkFinalReply,
  extractObligations,
  type NewRequest,
  resolveMatch,
  type ToolInfo,
} from "../../obligations/extract";
import { recoveredObligationOutcome } from "../../obligations/learn";
import {
  applyExtraction,
  LedgerStore,
  ledgerSummary,
  looksLikeError,
  matchCall,
  newLedger,
  nudgeNote,
  type ObligationLedger,
  openObligations,
  reminderBlock,
  settle,
  type ToolCallRecord,
} from "../../obligations/ledger";
import {
  type ObligationsMode,
  obligationsConsentMode,
  obligationsModel,
  parseObligationsMode,
} from "../../obligations/mode";
import {
  markNamed,
  obligationsReviewMode,
  type PendingCall,
  type RecentResult,
  recentToolResults,
  recordReview,
  reviewLabel,
  reviewNote,
  reviewQuestions,
  reviewState,
  reviewWrite,
} from "../../obligations/review";
import { readOnlyCall } from "../../obligations/tool-call";
import { isReadOnlyTool } from "../../obligations/tool-effect";
import type { EntityId } from "../../types";
import { messageText, type OpenAIMessage } from "../passthru-context";
import { COST_USD_HEADER, type PassthruAuthResult } from "./shared";
import { proxyToUpstream } from "./upstream";

const log = new Logger();

/** `marina/obligations:<model>` — the plain request to <model>, with the ledger on. */
export const OBLIGATIONS_MODEL_PREFIX = "marina/obligations:";
/** Request: `on` | `observe` (opt-in without the prefix). Response: the ledger's counters. */
export const OBLIGATIONS_HEADER = "x-marina-obligations";
/** The ledger's own spend on this request (extraction, judging, a discarded draft). */
export const OBLIGATIONS_COST_HEADER = "x-marina-obligations-cost-usd";
/**
 * A client's own conversation id (exact keying; send a unique one per
 * conversation). Without it the key is derived from the conversation itself
 * (`conversationKeys`).
 */
export const SESSION_HEADER = "x-marina-session";

/** Ambiguous matches a judge resolves per request (the rest stay open). */
const MAX_JUDGED_MATCHES = 3;
/** Output cap for the ledger's own model calls (room for a reasoning model's thinking). */
const LEDGER_CALL_MAX_TOKENS = 2000;

/** The opt-in this request carries: the model prefix means `on`; the header may say `observe`. */
export function obligationsRequestMode(req: Request, model: unknown): ObligationsMode | undefined {
  const header = parseObligationsMode(req.headers.get(OBLIGATIONS_HEADER));
  if (header === "off") return undefined;
  if (header) return header;
  return typeof model === "string" && model.startsWith(OBLIGATIONS_MODEL_PREFIX) ? "on" : undefined;
}

const store = new LedgerStore();

/** Drop every ledger (tests). */
export function resetObligationsForTests(): void {
  store.clear();
}

/** Who is calling, for the key only: never a secret (a key is hashed). */
function principal(req: Request, auth?: PassthruAuthResult): string {
  if (auth?.boundEntityName) return `e:${auth.boundEntityName}`;
  const agent = req.headers.get("X-Marina-Agent")?.split(":")[0]?.trim();
  if (agent && auth?.canNameMap) return `a:${agent}`;
  if (auth?.matchedKey)
    return `k:${createHash("sha256").update(auth.matchedKey).digest("hex").slice(0, 16)}`;
  return auth?.internal ? "internal" : "open";
}

/**
 * Non-system message counts at which a derived conversation key deepens:
 * every message up to 8 (where conversations with a shared opening usually
 * part), then ×1.5–2 steps, so a long conversation crosses a handful more.
 */
export const KEY_CHECKPOINTS = [1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32, 48, 64, 96, 128];

function sha(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p).update("\u0000");
  return h.digest("hex");
}

/** One message's identity for the key: role, text, tool calls (with arguments) and call id. */
function messageDigest(m: OpenAIMessage): string {
  const extra = m as { tool_calls?: unknown; tool_call_id?: unknown; name?: unknown };
  return sha(
    m.role,
    messageText(m.content),
    extra.tool_calls === undefined ? "" : JSON.stringify(extra.tool_calls),
    typeof extra.tool_call_id === "string" ? extra.tool_call_id : "",
    typeof extra.name === "string" ? extra.name : "",
  );
}

/**
 * The conversation's key chain, shallowest first; the last entry is the
 * current key. With `x-marina-session` it is that one exact key. Without it,
 * every key is scoped by caller and hashes the system/developer text, the
 * declared tools, the first user message, and then the conversation's
 * messages up to a checkpoint ({@link KEY_CHECKPOINTS}) — so two conversations
 * with the same opening share a key only while their histories are identical
 * up to the current checkpoint, and part at the first checkpoint after they
 * diverge. {@link LedgerStore.resolve} carries a conversation's state from its
 * deepest known ancestor key to the new one (a copy, so a sibling keeps its
 * own). Clients that know their conversation id should send
 * `x-marina-session` for exact keying.
 */
export function conversationKeys(
  req: Request,
  messages: OpenAIMessage[],
  auth?: PassthruAuthResult,
  tools: unknown[] = [],
): string[] {
  const who = principal(req, auth);
  const session = req.headers.get(SESSION_HEADER)?.trim();
  if (session) return [`${who}|s:${session.slice(0, 128)}`];
  const isSystem = (m: OpenAIMessage) => m.role === "system" || m.role === "developer";
  const system = messages
    .filter(isSystem)
    .map((m) => messageText(m.content))
    .join("\u0001");
  const firstUser = messages.find((m) => m.role === "user");
  let running = sha(
    who,
    system,
    tools.length ? JSON.stringify(tools) : "",
    messageText(firstUser?.content),
  );
  const keys = [`${who}|h:${running.slice(0, 24)}`];
  const rest = messages.filter((m) => !isSystem(m));
  const last = KEY_CHECKPOINTS.filter((c) => c <= rest.length).pop() ?? 0;
  for (let i = 0; i < last; i++) {
    running = sha(running, messageDigest(rest[i]!));
    if (KEY_CHECKPOINTS.includes(i + 1)) keys.push(`${who}|h:${running.slice(0, 24)}@${i + 1}`);
  }
  return keys;
}

/** The conversation's current key (the deepest of {@link conversationKeys}). */
export function conversationKey(
  req: Request,
  messages: OpenAIMessage[],
  auth?: PassthruAuthResult,
  tools: unknown[] = [],
): string {
  const keys = conversationKeys(req, messages, auth, tools);
  return keys[keys.length - 1]!;
}

type ToolCallMsg = { id?: string; function?: { name?: string; arguments?: string } };

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The conversation's requests (user messages) and its answered tool calls, in order. */
export function readConversation(messages: OpenAIMessage[]): {
  requests: NewRequest[];
  calls: ToolCallRecord[];
} {
  const requests: NewRequest[] = [];
  const calls: ToolCallRecord[] = [];
  const pending = new Map<string, { name: string; args: unknown; turn: number }>();
  let turn = 0;
  let lastAssistant = "";
  for (const m of messages) {
    if (m.role === "user") {
      turn++;
      requests.push({
        turn,
        text: messageText(m.content),
        ...(lastAssistant ? { before: lastAssistant } : {}),
      });
    } else if (m.role === "assistant") {
      const text = messageText(m.content).trim();
      if (text) lastAssistant = text;
      for (const c of ((m as { tool_calls?: ToolCallMsg[] }).tool_calls ?? []) as ToolCallMsg[]) {
        const name = c.function?.name;
        if (!name || !c.id) continue;
        pending.set(c.id, { name, args: parseArgs(c.function?.arguments), turn });
      }
    } else if (m.role === "tool") {
      const id = (m as { tool_call_id?: unknown }).tool_call_id;
      const call = typeof id === "string" ? pending.get(id) : undefined;
      if (!call) continue;
      pending.delete(id as string);
      calls.push({ ...call, ok: !looksLikeError(messageText(m.content)) });
    }
  }
  return { requests, calls };
}

function toolInfo(tools: unknown[]): ToolInfo[] {
  const out: ToolInfo[] = [];
  for (const t of tools) {
    const f = (t as { function?: { name?: unknown; description?: unknown } }).function;
    if (typeof f?.name !== "string") continue;
    out.push({
      name: f.name,
      ...(typeof f.description === "string" ? { description: f.description } : {}),
      write: !isReadOnlyTool(f.name, tools, "track"),
    });
  }
  return out;
}

/** What `prepareObligations` hands to the call and to `finishObligations`. */
export interface ObligationsPrep {
  mode: ObligationsMode;
  ledger: ObligationLedger;
  /** The trailing note for this request (`on` with obligations open). */
  note?: string;
  calls: ToolCallRecord[];
  lastRequest?: string;
  complete: CompleteText;
  provider?: DecisionProvider;
  /** This request's ledger spend so far, USD. */
  spent: { usd: number };
  /** `spent.usd` already added to the ledger's running total. */
  booked: number;
  /** Why the ledger did not run (`no-tools`). */
  skipped?: string;
  /** The request's declared tools (the pre-write review classifies the reply's calls with them). */
  tools?: unknown[];
  /** The latest tool results, clamped (context for the pre-write review). */
  recent?: RecentResult[];
  extract?: "ok" | "failed" | "none";
}

/**
 * One ledger call through `proxyToUpstream` (spend, the daily cap and the trace
 * apply as for passthru). The named model's own answer only — no provider
 * fallback — and the operator's passthru pin wins as for the request itself.
 * Also the argument check's chat judge (`routeReason: "argcheck"`).
 */
export function ledgerCompletion(
  engine: Engine,
  model: string,
  forceModel: string,
  entityId: EntityId | undefined,
  signal: AbortSignal | undefined,
  spent: { usd: number },
  routeReason = "obligations",
): CompleteText {
  return async (system, user) => {
    const resp = await proxyToUpstream(
      engine,
      {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: LEDGER_CALL_MAX_TOKENS,
        stream: false,
      },
      forceModel || undefined,
      { routeKind: "passthru", routeReason, ...(entityId ? { entityId } : {}) },
      { clientSignal: signal, providerFallback: false },
    );
    const cost = Number(resp.headers.get(COST_USD_HEADER));
    if (Number.isFinite(cost)) spent.usd += cost;
    const raw = await resp.text();
    if (!resp.ok) throw new Error(`ledger call failed (${resp.status})`);
    const body = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
    return messageText(body.choices?.[0]?.message?.content);
  };
}

/**
 * Read the request into its conversation's ledger before the upstream call.
 * Undefined when the request did not opt in. Never throws: a failure leaves the
 * ledger as it was (the request still goes out).
 */
export async function prepareObligations(
  engine: Engine,
  req: Request,
  body: Record<string, unknown>,
  messages: OpenAIMessage[],
  opts: {
    mode: ObligationsMode;
    forceModel: string;
    entityId?: EntityId;
    auth?: PassthruAuthResult;
  },
): Promise<ObligationsPrep | undefined> {
  if (opts.mode === "off") return undefined;
  const now = Date.now();
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  const keys = conversationKeys(req, messages, opts.auth, tools);
  const key = keys[keys.length - 1]!;
  const spent = { usd: 0 };
  const model =
    obligationsModel() ?? (typeof body.model === "string" ? body.model : "marina/default");
  const complete = ledgerCompletion(
    engine,
    model,
    opts.forceModel,
    opts.entityId,
    req.signal,
    spent,
  );
  const provider = harnessDecisionProvider();
  const { requests, calls } = readConversation(messages);
  let ledger = store.resolve(keys, now);
  // A conversation that shrank (an edited or replayed history) starts over.
  if (!ledger || requests.length < ledger.userTurns || calls.length < ledger.callsSeen) {
    ledger = newLedger(key, now);
  }
  const prep: ObligationsPrep = {
    mode: opts.mode,
    ledger,
    calls,
    ...(requests.length ? { lastRequest: requests[requests.length - 1]!.text } : {}),
    complete,
    ...(provider ? { provider } : {}),
    spent,
    booked: 0,
  };
  if (obligationsReviewMode() !== "off") {
    prep.tools = tools;
    prep.recent = recentToolResults(messages);
  }
  // Without tools nothing can carry an obligation out: no calls, no note.
  if (tools.length === 0) {
    prep.skipped = "no-tools";
    return prep;
  }
  // `track` role: a lookup counted as a write is the costly mistake here
  // (`tool-effect.ts`); a dispatcher call is classified by the tool it runs.
  const isWrite = (name: string, args: unknown) =>
    !readOnlyCall(name, args, { tools, role: "track" });
  try {
    const fresh = requests.filter((r) => r.turn > ledger.userTurns);
    prep.extract = "none";
    if (fresh.length > 0) {
      const info = toolInfo(tools);
      const extraction = await extractObligations(complete, {
        tools: info,
        open: openObligations(ledger),
        requests: fresh,
      });
      if (extraction) {
        applyExtraction(
          ledger,
          fresh[fresh.length - 1]!.turn,
          extraction,
          new Set(info.map((t) => t.name)),
          now,
          fresh[0]!.turn,
        );
        prep.extract = "ok";
      } else {
        ledger.extractFailures++;
        prep.extract = "failed";
      }
      ledger.userTurns = requests.length;
    }
    let judged = 0;
    for (const call of calls.slice(ledger.callsSeen)) {
      const m = matchCall(ledger, call, isWrite);
      if (m.ambiguous.length > 0 && judged < MAX_JUDGED_MATCHES) {
        judged++;
        const candidates = ledger.obligations.filter((o) => m.ambiguous.includes(o.id));
        const pick = await resolveMatch(call, candidates, { provider, complete }, req.signal);
        if (pick) settle(ledger, pick, "satisfied", `judge:${call.name}`);
      }
    }
    ledger.callsSeen = calls.length;
  } catch (e) {
    log.warn("model-api", `obligations: ledger update failed: ${getErrorMessage(e)}`);
  }
  ledger.updatedAt = now;
  store.put(ledger);
  const note =
    opts.mode === "on"
      ? reminderBlock(ledger, { showConsent: obligationsConsentMode() === "on" })
      : undefined;
  if (note) prep.note = note;
  return prep;
}

/** The response header value: counters only (never content). */
export function obligationsHeaderValue(prep: ObligationsPrep, check?: string): string {
  if (prep.skipped) return `${prep.mode};skipped=${prep.skipped}`;
  const s = ledgerSummary(prep.ledger);
  return [
    prep.mode,
    `open=${s.open}`,
    `satisfied=${s.satisfied}`,
    `declined=${s.declined}`,
    `nudges=${s.nudges}`,
    ...(s.consented > 0 ? [`consented=${s.consented}`] : []),
    ...(s.reasks > 0 ? [`reasks=${s.reasks}`] : []),
    ...(prep.ledger.review
      ? [
          `reviews=${prep.ledger.review.reviews}`,
          `review_flags=${prep.ledger.review.orderRisks + prep.ledger.review.evidenceGaps}`,
        ]
      : []),
    ...(prep.extract && prep.extract !== "none" ? [`extract=${prep.extract}`] : []),
    ...(check ? [`check=${check}`] : []),
  ].join(";");
}

type ChatMessage = { content?: unknown; tool_calls?: Array<{ function?: { name?: string } }> };

function firstMessage(body: unknown): ChatMessage | undefined {
  const choices = (body as { choices?: Array<{ message?: ChatMessage }> } | undefined)?.choices;
  return choices?.[0]?.message;
}

function rebuilt(text: string, from: Response, extra: Record<string, string>): Response {
  const headers = new Headers(from.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(text, { status: from.status, statusText: from.statusText, headers });
}

/**
 * After the upstream call. Streams, errors and `observe` pass through with the
 * counters header. A non-streaming reply with no tool call that would leave an
 * obligation open is checked once; an obligation still owed (never nudged
 * before) gets one retry with `nudgeNote` as the trailing note, and THAT reply
 * is returned (it may be the draft again — the model decides). Any failure in
 * the check or the retry returns the draft.
 */
export async function finishObligations(
  engine: Engine,
  prep: ObligationsPrep,
  body: Record<string, unknown>,
  resp: Response,
  retry: (note: string) => Promise<Response>,
): Promise<Response> {
  const headers = (check?: string): Record<string, string> => ({
    [OBLIGATIONS_HEADER]: obligationsHeaderValue(prep, check),
    [OBLIGATIONS_COST_HEADER]: prep.spent.usd.toFixed(8),
  });
  const done = (r: Response, text: string | undefined, check: string) => {
    logRequest(prep, check);
    return text === undefined ? withHeaders(r, headers(check)) : rebuilt(text, r, headers(check));
  };
  if (prep.skipped) return done(resp, undefined, "skipped");
  // The pre-write review reads replies that carry calls; without it, nothing below changes.
  const reviewMode = obligationsReviewMode();
  if (prep.mode !== "on" && reviewMode === "off") return done(resp, undefined, "observe");
  if (body.stream === true) return done(resp, undefined, "stream");
  if (!resp.ok) return done(resp, undefined, "upstream-error");
  const open = openObligations(prep.ledger).filter((o) => !o.nudged);
  if (open.length === 0 && reviewMode === "off") return done(resp, undefined, "none-open");
  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return done(resp, text, "unparsed");
  }
  const draft = firstMessage(parsed);
  if (draft?.tool_calls?.length) {
    if (reviewMode === "off") return done(resp, text, "tool-call");
    return reviewDraft(
      prep,
      draft,
      text,
      resp,
      retry,
      done,
      reviewMode === "on" && prep.mode === "on",
    );
  }
  if (prep.mode !== "on") return done(resp, text, "observe");
  if (!draft) return done(resp, text, "tool-call");
  if (open.length === 0) return done(resp, text, "none-open");
  const draftText = messageText(draft.content);
  const verdicts = await checkFinalReply(
    {
      open,
      draft: draftText,
      ...(prep.lastRequest ? { lastRequest: prep.lastRequest } : {}),
      recentCalls: prep.calls,
    },
    { ...(prep.provider ? { provider: prep.provider } : {}), complete: prep.complete },
  ).catch(() => undefined);
  if (!verdicts) return done(resp, text, "unjudged");
  for (const [id, v] of Object.entries(verdicts)) {
    if (v === "declined") settle(prep.ledger, id, "declined", "judge:declined");
    else if (v === "done") settle(prep.ledger, id, "satisfied", "judge:done");
  }
  // A reply that asks again about an item the requester already approved: counted
  // always; owed (so the one-time nudge names it) only under MARINA_OBLIGATIONS_CONSENT=on.
  const consentOn = obligationsConsentMode() === "on";
  const reasked = open.filter((o) => verdicts[o.id] === "waiting" && o.consentTurn !== undefined);
  prep.ledger.reasks = (prep.ledger.reasks ?? 0) + reasked.length;
  const owed = [...open.filter((o) => verdicts[o.id] === "owed"), ...(consentOn ? reasked : [])];
  if (owed.length === 0) return done(resp, text, reasked.length > 0 ? "reask" : "handled");
  for (const o of owed) o.nudged = true;
  prep.ledger.nudges++;
  store.put(prep.ledger);
  // The discarded draft is spend the ledger caused.
  const draftCost = Number(resp.headers.get(COST_USD_HEADER));
  if (Number.isFinite(draftCost)) prep.spent.usd += draftCost;
  let second: Response;
  try {
    second = await retry(nudgeNote(draftText, owed, { showConsent: consentOn }));
  } catch (e) {
    log.warn("model-api", `obligations: nudge failed, returning the draft: ${getErrorMessage(e)}`);
    return done(resp, text, "nudge-failed");
  }
  if (!second.ok) return done(resp, text, "nudge-failed");
  const secondText = await second.text();
  let call: string | undefined;
  try {
    call = firstMessage(JSON.parse(secondText))?.tool_calls?.[0]?.function?.name;
  } catch {
    return done(resp, text, "nudge-unparsed");
  }
  if (call && engine.db) {
    noteOutcome(
      engine.db,
      recoveredObligationOutcome({ surface: "passthru", owed, tool: call, now: Date.now() }),
    );
  }
  return done(second, secondText, call ? "nudged-acted" : "nudged-kept");
}

/**
 * The pre-write review of a reply that carries calls (`review.ts`): its write
 * calls get the questions this conversation still needs; a named concern gets
 * ONE retry in `on` (only when the ledger itself is `on`), and that reply is
 * returned. Any failure returns the draft.
 */
async function reviewDraft(
  prep: ObligationsPrep,
  draft: ChatMessage,
  text: string,
  resp: Response,
  retry: (note: string) => Promise<Response>,
  done: (r: Response, text: string | undefined, check: string) => Response,
  nudge: boolean,
): Promise<Response> {
  const tools = prep.tools ?? [];
  const writes: PendingCall[] = (draft.tool_calls ?? [])
    .map((c) => {
      const fn = (c as { function?: { name?: string; arguments?: unknown } }).function;
      return { name: fn?.name ?? "", args: parseArgs(fn?.arguments) };
    })
    .filter((c) => c.name && !readOnlyCall(c.name, c.args, { tools, role: "guard" }));
  if (writes.length === 0) return done(resp, text, "tool-call");
  const state = reviewState(prep.ledger);
  const open = openObligations(prep.ledger);
  const ask = reviewQuestions(state, open);
  if (!ask) return done(resp, text, "tool-call");
  const input = {
    open,
    calls: writes,
    draft: messageText(draft.content),
    recent: prep.recent ?? [],
  };
  const verdict = await reviewWrite(input, ask, {
    ...(prep.provider ? { provider: prep.provider } : {}),
    complete: prep.complete,
  }).catch(() => undefined);
  const named = recordReview(state, verdict);
  store.put(prep.ledger);
  const label = reviewLabel(verdict);
  if (!nudge || (!named.order && !named.evidence)) return done(resp, text, label);
  markNamed(state, named);
  store.put(prep.ledger);
  // The discarded draft is spend the review caused.
  const draftCost = Number(resp.headers.get(COST_USD_HEADER));
  if (Number.isFinite(draftCost)) prep.spent.usd += draftCost;
  let second: Response;
  try {
    second = await retry(reviewNote(input, named));
  } catch (e) {
    log.warn(
      "model-api",
      `obligations: review nudge failed, returning the draft: ${getErrorMessage(e)}`,
    );
    return done(resp, text, "review-nudge-failed");
  }
  if (!second.ok) return done(resp, text, "review-nudge-failed");
  const secondText = await second.text();
  let same = false;
  try {
    const again = (firstMessage(JSON.parse(secondText))?.tool_calls ?? []).map((c) => {
      const fn = (c as { function?: { name?: string; arguments?: unknown } }).function;
      return JSON.stringify([fn?.name, parseArgs(fn?.arguments)]);
    });
    same = writes.every((w) => again.includes(JSON.stringify([w.name, w.args])));
  } catch {
    return done(resp, text, "review-nudge-unparsed");
  }
  return done(second, secondText, same ? "reviewed-kept" : "reviewed-changed");
}

function withHeaders(resp: Response, extra: Record<string, string>): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

/** One log line per opted-in request: counters and a short key prefix, never content. */
function logRequest(prep: ObligationsPrep, check: string): void {
  prep.ledger.costUsd += prep.spent.usd - prep.booked;
  prep.booked = prep.spent.usd;
  const s = ledgerSummary(prep.ledger);
  log.info("model-api", "obligations", {
    conv: createHash("sha256").update(prep.ledger.key).digest("hex").slice(0, 12),
    mode: prep.mode,
    turns: prep.ledger.userTurns,
    calls: prep.ledger.callsSeen,
    total: s.total,
    open: s.open,
    satisfied: s.satisfied,
    declined: s.declined,
    nudges: s.nudges,
    consented: s.consented,
    reasks: s.reasks,
    ...(prep.ledger.review
      ? {
          reviews: prep.ledger.review.reviews,
          orderRisks: prep.ledger.review.orderRisks,
          evidenceGaps: prep.ledger.review.evidenceGaps,
          reviewUnjudged: prep.ledger.review.unjudged,
          reviewNudges: prep.ledger.review.nudges,
        }
      : {}),
    extract: prep.extract ?? "none",
    check,
    noted: prep.note ? 1 : 0,
    costUsd: Number(prep.spent.usd.toFixed(6)),
    ledgerCostUsd: Number(prep.ledger.costUsd.toFixed(6)),
  });
}
