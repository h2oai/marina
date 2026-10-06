// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The argument check on the `/v1/chat/completions` passthru (opt-in:
// `marina/argcheck:<model>` or `x-marina-argcheck: on|observe`; combines with
// `obligations:` and `lessons:` in any order). After the upstream call
// (non-streaming): each state-changing tool call in the reply (the same
// write/read classification the obligations ledger uses) is checked against the
// conversation — mechanically first, then one judgement for a flagged call
// (decision layer when configured, else one chat completion). In `on`, an
// unsupported call (never nudged before, by signature) gets ONE retry with a
// trailing note naming the unsupported values, and THAT reply is returned — the
// model decides; its arguments are never rewritten. A judge or retry failure
// returns the draft. Without the opt-in nothing here runs.

import { createHash } from "node:crypto";
import { harnessDecisionProvider } from "../../decisions/engines";
import type { DecisionProvider } from "../../decisions/types";
import type { Engine } from "../../engine/engine";
import { getErrorMessage } from "../../engine/errors";
import { Logger } from "../../engine/logger";
import {
  type ArgcheckMemo,
  type ArgcheckOutcome,
  type ArgcheckTrigger,
  checkCall,
  EvidenceIndex,
  type EvidenceText,
  newArgcheckMemo,
} from "../../obligations/argcheck";
import type { CompleteText } from "../../obligations/extract";
import { LedgerStore, type ObligationLedger, statedLines } from "../../obligations/ledger";
import {
  argcheckModel,
  argcheckTrigger,
  type ObligationsMode,
  parseObligationsMode,
} from "../../obligations/mode";
import type { EntityId } from "../../types";
import { messageText, type OpenAIMessage } from "../passthru-context";
import { conversationKeys, ledgerCompletion } from "./obligations";
import { COST_USD_HEADER, type PassthruAuthResult } from "./shared";
import { isReadOnlyToolCall } from "./verify";
import { readOnlyCall } from "../../obligations/tool-call";

const log = new Logger();

/** `marina/argcheck:<model>` — the plain request to <model>, with the argument check on. */
export const ARGCHECK_MODEL_PREFIX = "marina/argcheck:";
/** Request: `on` | `observe` (opt-in without the prefix). Response: the check's counters. */
export const ARGCHECK_HEADER = "x-marina-argcheck";
/** The check's own spend on this request (judging, a discarded draft). */
export const ARGCHECK_COST_HEADER = "x-marina-argcheck-cost-usd";

/** Write calls checked per reply (a reply rarely carries more). */
const MAX_CALLS_CHECKED = 4;

/** The opt-in this request carries: the model prefix means `on`; the header may say `observe`. */
export function argcheckRequestMode(req: Request, model: unknown): ObligationsMode | undefined {
  const header = parseObligationsMode(req.headers.get(ARGCHECK_HEADER));
  if (header === "off") return undefined;
  if (header) return header;
  return typeof model === "string" && model.startsWith(ARGCHECK_MODEL_PREFIX) ? "on" : undefined;
}

const store = new LedgerStore<ArgcheckMemo>();

/** Drop every memo (tests). */
export function resetArgcheckForTests(): void {
  store.clear();
}

/**
 * The conversation as evidence, by channel: system/developer text, user
 * messages, the assistant's TEXT (never its tool-call arguments — a value the
 * model passed before is not evidence for itself), and tool results.
 */
export function conversationEvidence(messages: OpenAIMessage[]): EvidenceText[] {
  const out: EvidenceText[] = [];
  for (const m of messages) {
    const text = messageText(m.content);
    if (m.role === "system" || m.role === "developer") out.push({ channel: "system", text });
    else if (m.role === "user") out.push({ channel: "user", text });
    else if (m.role === "assistant") out.push({ channel: "assistant", text });
    else if (m.role === "tool") out.push({ channel: "tool", text });
  }
  return out;
}

/** What `prepareArgcheck` hands to `finishArgcheck`. */
export interface ArgcheckPrep {
  mode: Exclude<ObligationsMode, "off">;
  /** Which write calls the judge sees (`MARINA_ARGCHECK_TRIGGER`). */
  trigger: ArgcheckTrigger;
  memo: ArgcheckMemo;
  messages: OpenAIMessage[];
  tools: unknown[];
  complete: CompleteText;
  provider?: DecisionProvider;
  /** This request's check spend so far, USD. */
  spent: { usd: number };
  /** Stated requests (the obligations ledger's lines, when it runs too). */
  stated?: string[];
}

/** The obligations ledger's requests as judge context: what, target, constraints. */
export function statedFromLedger(ledger: ObligationLedger | undefined): string[] {
  return ledger ? statedLines(ledger) : [];
}

/** Set up the check for this request (no model call yet). Undefined when not opted in. */
export function prepareArgcheck(
  engine: Engine,
  req: Request,
  body: Record<string, unknown>,
  messages: OpenAIMessage[],
  opts: {
    mode: ObligationsMode | undefined;
    forceModel: string;
    entityId?: EntityId;
    auth?: PassthruAuthResult;
    stated?: string[];
  },
): ArgcheckPrep | undefined {
  if (!opts.mode || opts.mode === "off") return undefined;
  const now = Date.now();
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  const keys = conversationKeys(req, messages, opts.auth, tools);
  const memo = store.resolve(keys, now) ?? newArgcheckMemo(keys[keys.length - 1]!, now);
  memo.updatedAt = now;
  store.put(memo);
  const spent = { usd: 0 };
  const model = argcheckModel() ?? (typeof body.model === "string" ? body.model : "marina/default");
  const provider = harnessDecisionProvider();
  return {
    mode: opts.mode,
    trigger: argcheckTrigger(),
    memo,
    messages,
    tools,
    complete: ledgerCompletion(
      engine,
      model,
      opts.forceModel,
      opts.entityId,
      req.signal,
      spent,
      "argcheck",
    ),
    ...(provider ? { provider } : {}),
    spent,
    ...(opts.stated?.length ? { stated: opts.stated } : {}),
  };
}

type ToolCallMsg = { id?: string; function?: { name?: string; arguments?: string } };
type ChatMessage = { content?: unknown; tool_calls?: ToolCallMsg[] };

function firstMessage(body: unknown): ChatMessage | undefined {
  const choices = (body as { choices?: Array<{ message?: ChatMessage }> } | undefined)?.choices;
  return choices?.[0]?.message;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The response header value: counters only (never content). */
export function argcheckHeaderValue(
  prep: ArgcheckPrep,
  outcomes: ArgcheckOutcome[],
  check: string,
): string {
  return [
    prep.mode,
    `writes=${outcomes.length}`,
    `checked=${outcomes.reduce((n, o) => n + o.checked, 0)}`,
    `flagged=${outcomes.reduce((n, o) => n + o.flaggedValues, 0)}`,
    `judged=${outcomes.filter((o) => o.judgement).length}`,
    `nudges=${prep.memo.nudges}`,
    `check=${check}`,
  ].join(";");
}

function rebuilt(text: string, from: Response, extra: Record<string, string>): Response {
  const headers = new Headers(from.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(text, { status: from.status, statusText: from.statusText, headers });
}

function withHeaders(resp: Response, extra: Record<string, string>): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

/**
 * After the upstream call (and after the obligations ledger, when it runs too).
 * Streams, errors and replies without a state-changing call pass through with
 * the counters header. Each write call (at most {@link MAX_CALLS_CHECKED}) is
 * checked; in `on`, any unsupported one gets ONE retry with the nudge as the
 * trailing note and that reply is returned. Any failure returns the draft.
 */
export async function finishArgcheck(
  prep: ArgcheckPrep,
  body: Record<string, unknown>,
  resp: Response,
  retry: (note: string) => Promise<Response>,
): Promise<Response> {
  const outcomes: ArgcheckOutcome[] = [];
  const done = (r: Response, text: string | undefined, check: string) => {
    logRequest(prep, outcomes, check);
    // A retry's reply keeps the draft's Marina headers (the obligations counters).
    const carried: Record<string, string> = {};
    if (r !== resp) {
      resp.headers.forEach((v, k) => {
        if (k.startsWith("x-marina-") && !r.headers.has(k)) carried[k] = v;
      });
    }
    const extra = {
      ...carried,
      [ARGCHECK_HEADER]: argcheckHeaderValue(prep, outcomes, check),
      [ARGCHECK_COST_HEADER]: prep.spent.usd.toFixed(8),
    };
    return text === undefined ? withHeaders(r, extra) : rebuilt(text, r, extra);
  };
  if (body.stream === true) return done(resp, undefined, "stream");
  if (!resp.ok) return done(resp, undefined, "upstream-error");
  if (prep.tools.length === 0) return done(resp, undefined, "no-tools");
  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return done(resp, text, "unparsed");
  }
  const writes = (firstMessage(parsed)?.tool_calls ?? [])
    .map((c) => ({ name: c.function?.name ?? "", args: parseArgs(c.function?.arguments) }))
    .filter(
      (c) =>
        c.name &&
        !readOnlyCall(c.name, c.args, (n) => isReadOnlyToolCall(n, prep.tools), prep.tools),
    );
  if (writes.length === 0) return done(resp, text, "no-write");
  const evidence = new EvidenceIndex(conversationEvidence(prep.messages));
  for (const call of writes.slice(0, MAX_CALLS_CHECKED)) {
    outcomes.push(
      await checkCall(call, evidence, {
        memo: prep.memo,
        mode: prep.mode,
        trigger: prep.trigger,
        tools: prep.tools,
        judge: { ...(prep.provider ? { provider: prep.provider } : {}), complete: prep.complete },
        ...(prep.stated ? { stated: prep.stated } : {}),
      }).catch((e) => {
        log.warn("model-api", `argcheck: check failed, call allowed: ${getErrorMessage(e)}`);
        return {
          signature: "",
          checked: 0,
          flaggedValues: 0,
          label: "unjudged" as const,
        };
      }),
    );
  }
  for (const o of outcomes) {
    if (o.judgement?.costUsd) prep.spent.usd += o.judgement.costUsd;
  }
  const nudges = outcomes.map((o) => o.nudge).filter((n): n is string => !!n);
  const label = summaryLabel(outcomes);
  if (nudges.length === 0) return done(resp, text, label);
  // The discarded draft is spend the check caused.
  const draftCost = Number(resp.headers.get(COST_USD_HEADER));
  if (Number.isFinite(draftCost)) prep.spent.usd += draftCost;
  let second: Response;
  try {
    second = await retry(nudges.join("\n\n"));
  } catch (e) {
    log.warn("model-api", `argcheck: nudge failed, returning the draft: ${getErrorMessage(e)}`);
    return done(resp, text, "nudge-failed");
  }
  if (!second.ok) return done(resp, text, "nudge-failed");
  const secondText = await second.text();
  let sameCalls = false;
  try {
    const again = (firstMessage(JSON.parse(secondText))?.tool_calls ?? []).map((c) =>
      JSON.stringify([c.function?.name, parseArgs(c.function?.arguments)]),
    );
    const before = writes.map((c) => JSON.stringify([c.name, c.args]));
    sameCalls = before.every((b) => again.includes(b));
  } catch {
    return done(resp, text, "nudge-unparsed");
  }
  return done(second, secondText, sameCalls ? "nudged-kept" : "nudged-changed");
}

/** The request's label: the most consequential outcome among its calls. */
function summaryLabel(outcomes: ArgcheckOutcome[]): string {
  for (const l of ["unsupported", "unjudged", "judged-supported", "supported", "repeat"] as const)
    if (outcomes.some((o) => o.label === l)) return l;
  return "no-values";
}

/** One log line per opted-in request: counters and a short key prefix, never content. */
function logRequest(prep: ArgcheckPrep, outcomes: ArgcheckOutcome[], check: string): void {
  prep.memo.costUsd += prep.spent.usd;
  log.info("model-api", "argcheck", {
    conv: createHash("sha256").update(prep.memo.key).digest("hex").slice(0, 12),
    mode: prep.mode,
    trigger: prep.trigger,
    writes: outcomes.length,
    checked: outcomes.reduce((n, o) => n + o.checked, 0),
    flagged: outcomes.reduce((n, o) => n + o.flaggedValues, 0),
    check,
    convChecks: prep.memo.checks,
    convFlagged: prep.memo.flagged,
    convJudged: prep.memo.judged,
    convUnsupported: prep.memo.unsupported,
    convNudges: prep.memo.nudges,
    convUnjudged: prep.memo.unjudged,
    costUsd: Number(prep.spent.usd.toFixed(6)),
  });
}
