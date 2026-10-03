// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `marina/verify:<proposer>[+<checker>]` — Marina's verification formation as a
// model id. Any OpenAI-compatible client (tool calling included) gets a
// proposer's next message, an independent checker's review of that draft
// against the conversation (its system rules, the user's requests, prior tool
// results), and — when the checker flags it — one bounded revision by the
// proposer. Every call goes through `proxyToUpstream`, so spend, the daily cap,
// lifecycle traces and cost headers apply exactly as for passthru.
//
// `marina/verify:default` resolves to this installation's first available model
// (a single local model checks its own drafts — a self-check, still a review).
//
// Fails open: a checker outage, an unparseable verdict or a failed revision
// returns the proposer's draft unchanged (the verifier accepts on outage, as
// in `src/decisions/policy.ts`).

import { availableModels } from "../../agent/available-models";
import type { Engine } from "../../engine/engine";
import { getErrorMessage } from "../../engine/errors";
import { Logger } from "../../engine/logger";
import {
  COST_USD_HEADER,
  errorJson,
  generateRequestId,
  json,
  requestTrace,
  unsupportedParam,
} from "./shared";
import { explicitUpstreamModel, proxyToUpstream } from "./upstream";

const log = new Logger();

export const VERIFY_MODEL_PREFIX = "marina/verify:";

/** Per-message clamp in the checker's transcript (tool results can be large). */
const REVIEW_MESSAGE_MAX_CHARS = 4000;
/** Clamp for the whole system block shown to the checker. */
const REVIEW_SYSTEM_MAX_CHARS = 24_000;

export interface VerifyModelSpec {
  proposer: string;
  checker: string;
}

/** `marina/verify:<proposer>[+<checker>]` → ids; checker defaults to
 *  `MARINA_VERIFY_CHECKER_MODEL`, else the proposer. Undefined when not a verify id. */
export function parseVerifyModel(
  model: string,
  env: Record<string, string | undefined> = process.env,
): VerifyModelSpec | undefined {
  if (!model.startsWith(VERIFY_MODEL_PREFIX)) return undefined;
  const rest = model.slice(VERIFY_MODEL_PREFIX.length).trim();
  if (!rest) return undefined;
  const plus = rest.lastIndexOf("+");
  const proposer = (plus > 0 ? rest.slice(0, plus) : rest).trim();
  const explicitChecker = plus > 0 ? rest.slice(plus + 1).trim() : "";
  const checker = explicitChecker || env.MARINA_VERIFY_CHECKER_MODEL?.trim() || proposer;
  if (!proposer || !checker) return undefined;
  return { proposer: sized(proposer, env), checker: sized(checker, env) };
}

/**
 * `default` names this installation's first available model (a configured
 * local runtime first, see `availableModels`), so `marina/verify:default`
 * works on a Marina with a single model: it checks its own drafts.
 */
function sized(id: string, env: Record<string, string | undefined>): string {
  if (id !== "default") return id;
  return availableModels(env as NodeJS.ProcessEnv)[0]?.spec ?? id;
}

/** Max revision rounds (`MARINA_VERIFY_ROUNDS`, default 1, clamped 0..3; 0 = review only). */
export function verifyRounds(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MARINA_VERIFY_ROUNDS);
  if (!Number.isFinite(n) || env.MARINA_VERIFY_ROUNDS === undefined) return 1;
  return Math.max(0, Math.min(3, Math.floor(n)));
}

type Msg = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  name?: string;
  tool_call_id?: string;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
          ? (p as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function clamp(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)} […+${s.length - n} chars]`;
}

function renderCalls(calls: Msg["tool_calls"]): string {
  return (calls ?? [])
    .map((c) => `CALL ${c.function?.name ?? "?"}(${c.function?.arguments ?? ""})`)
    .join("\n");
}

/** One assistant message (draft or history) as reviewable text. */
export function renderAssistant(m: Msg): string {
  const parts = [textOf(m.content).trim(), renderCalls(m.tool_calls)].filter(Boolean);
  return parts.join("\n") || "(empty)";
}

/** The checker's input: rules, tool catalogue, conversation, and the draft. */
export function renderReview(messages: Msg[], tools: unknown[] | undefined, draft: Msg): string {
  const system = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => textOf(m.content))
    .join("\n\n");
  const toolLines = (tools ?? [])
    .map((t) => {
      const f = (t as { function?: { name?: string; description?: string } }).function;
      return f?.name ? `- ${f.name}: ${clamp(f.description ?? "", 300)}` : "";
    })
    .filter(Boolean)
    .join("\n");
  const turns = messages
    .filter((m) => m.role !== "system" && m.role !== "developer")
    .map((m) => {
      if (m.role === "assistant")
        return `ASSISTANT:\n${clamp(renderAssistant(m), REVIEW_MESSAGE_MAX_CHARS)}`;
      if (m.role === "tool") {
        return `TOOL RESULT${m.name ? ` (${m.name})` : ""}:\n${clamp(textOf(m.content), REVIEW_MESSAGE_MAX_CHARS)}`;
      }
      return `${(m.role ?? "user").toUpperCase()}:\n${clamp(textOf(m.content), REVIEW_MESSAGE_MAX_CHARS)}`;
    })
    .join("\n\n");
  return [
    system
      ? `RULES AND INSTRUCTIONS GIVEN TO THE ASSISTANT:\n${clamp(system, REVIEW_SYSTEM_MAX_CHARS)}`
      : "",
    toolLines ? `TOOLS AVAILABLE TO THE ASSISTANT:\n${toolLines}` : "",
    `CONVERSATION SO FAR:\n${turns || "(none)"}`,
    `DRAFT NEXT ASSISTANT MESSAGE (under review):\n${renderAssistant(draft)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const CHECKER_SYSTEM = [
  "You review an assistant's DRAFT next message before it is sent.",
  "Check it against the rules it was given, the user's actual requests, and facts established by earlier tool results.",
  "Flag only concrete problems: a rule violated; an action taken without a confirmation the rules require;",
  "wrong, missing or invented arguments or facts; acting on something the user did not ask for;",
  "ending, refusing or transferring when the rules say otherwise; or a needed step skipped.",
  "Do not flag style. If the draft is acceptable, approve it.",
  "A state-changing tool call (anything other than a read-only lookup) is kept exactly as drafted unless you cite a concrete conflict:",
  'a verbatim excerpt from the rules or the conversation (kind "policy"), or from a tool result (kind "tool_result"), that the call contradicts.',
  "Name the call, and the single argument that is wrong when the fix is an argument; never propose an id that does not appear in the conversation or a tool result.",
  'Reply with JSON only: {"verdict":"approve"|"revise","issues":"<concrete fix, ≤ 80 words, empty when approving>",',
  '"conflict":{"kind":"policy"|"tool_result","quote":"<verbatim excerpt>","call":"<tool name>","field":"<argument path, e.g. item_ids[0]>"}}',
  '("conflict" is required only when the fix changes, adds or removes a state-changing tool call).',
].join(" ");

/** The checker's cited reason for touching a state-changing tool call. */
export interface VerdictConflict {
  kind: "policy" | "tool_result";
  /** Verbatim excerpt from the rules, the conversation or a tool result. */
  quote: string;
  /** The tool call the conflict is about. */
  call?: string;
  /** The one argument path that is wrong (e.g. `item_ids[0]`), when the fix is an argument. */
  field?: string;
}

export interface Verdict {
  verdict: "approve" | "revise";
  issues: string;
  conflict?: VerdictConflict;
}

function parseConflict(raw: unknown): VerdictConflict | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const kind = c.kind === "policy" || c.kind === "tool_result" ? c.kind : undefined;
  const quote = typeof c.quote === "string" ? c.quote.trim() : "";
  if (!kind || !quote) return undefined;
  const call = typeof c.call === "string" && c.call.trim() ? c.call.trim() : undefined;
  const field = typeof c.field === "string" && c.field.trim() ? c.field.trim() : undefined;
  return { kind, quote, ...(call ? { call } : {}), ...(field ? { field } : {}) };
}

/** Lenient verdict parse; anything unreadable is an approval (fail open). */
export function parseVerdict(text: string): Verdict {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { verdict?: unknown; issues?: unknown; conflict?: unknown };
      const v = typeof j.verdict === "string" ? j.verdict.toLowerCase() : "";
      const issues = typeof j.issues === "string" ? j.issues.trim() : "";
      if (v === "revise" && issues) {
        const conflict = parseConflict(j.conflict);
        return { verdict: "revise", issues, ...(conflict ? { conflict } : {}) };
      }
      return { verdict: "approve", issues: "" };
    } catch {
      // allow-empty-catch: an unparseable verdict is an approval (fail open)
    }
  }
  return { verdict: "approve", issues: "" };
}

/** The note appended for a revision call (a trailing system message). */
export function revisionNote(draft: Msg, issues: string, conflict?: VerdictConflict): string {
  const target = conflict?.call
    ? ` (call ${conflict.call}${conflict.field ? `, argument ${conflict.field}` : ""})`
    : "";
  const cited = conflict
    ? `Cited ${conflict.kind === "policy" ? "rule" : "tool result"}: "${clamp(conflict.quote, 500)}"${target}`
    : "";
  return [
    "A reviewer checked your draft next message before it was sent and found a problem.",
    `Draft: ${clamp(renderAssistant(draft), 2000)}`,
    `Reviewer: ${issues}`,
    cited,
    "Keep every state-changing tool call exactly as drafted unless the reviewer cited a concrete conflict;",
    "then change only the cited call and argument, and use only ids that appear in the conversation or a tool result.",
    "Write the corrected next message now (a tool call is allowed). If the reviewer is wrong, send the draft unchanged.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Write-action guard ──────────────────────────────────────────────────────
//
// A revision may rewrite the user-facing text and read-only lookups freely. A
// state-changing tool call (an order edit, a payment, a cancellation) is held
// exactly as the proposer drafted it unless the checker cited a concrete
// conflict that is actually present in the conversation; then only the cited
// call may change (and, for a modified call, only the cited argument), and
// never to an id that appears nowhere in the conversation or its tool results.
// Anything else returns the draft (fail open).

/** Read-only by name when the tool declares nothing (lookups, calculators, notes to self). */
const READ_ONLY_NAME =
  /^(get|list|find|search|lookup|look_up|read|fetch|query|calculate|compute|check|describe|show|view|count|think|retrieve|validate|preview)(_|$)/i;

type ToolDecl = {
  function?: { name?: string };
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
};

/** True when a tool call cannot change state: a declared hint wins, else a read-only name. */
export function isReadOnlyToolCall(name: string, tools: unknown[] | undefined): boolean {
  const decl = (tools ?? []).find((t) => (t as ToolDecl).function?.name === name) as
    | ToolDecl
    | undefined;
  const hints = decl?.annotations;
  if (hints?.readOnlyHint === true) return true;
  if (hints?.readOnlyHint === false || hints?.destructiveHint === true) return false;
  return READ_ONLY_NAME.test(name);
}

interface WriteCall {
  name: string;
  args: unknown;
}

function parseArgs(raw: string | undefined): unknown {
  if (raw === undefined || raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // compared as text
  }
}

function writeCalls(m: Msg | undefined, tools: unknown[] | undefined): WriteCall[] {
  return (m?.tool_calls ?? [])
    .map((c) => ({ name: c.function?.name ?? "", args: parseArgs(c.function?.arguments) }))
    .filter((c) => c.name && !isReadOnlyToolCall(c.name, tools));
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, canonical(o[k])]),
    );
  }
  return v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** `a.b[2].c` → ["a", "b", 2, "c"]. */
function pathSegments(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const part of path.split(".")) {
    const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) return [path];
    if (m[1]) out.push(m[1]);
    for (const idx of (m[2] ?? "").matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

function getPath(v: unknown, path: (string | number)[]): unknown {
  let cur = v;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

/** A copy of `v` with the value at `path` replaced by a fixed marker. */
function maskPath(v: unknown, path: (string | number)[]): unknown {
  if (path.length === 0) return "\u0000masked";
  if (v === null || typeof v !== "object") return v;
  const [head, ...rest] = path as [string | number, ...(string | number)[]];
  const copy = (Array.isArray(v) ? [...v] : { ...(v as Record<string, unknown>) }) as Record<
    string | number,
    unknown
  >;
  copy[head] = maskPath(copy[head], rest);
  return copy;
}

/** Id-like scalars inside a value: tokens carrying a digit (order ids, item ids, card refs). */
function idLikeTokens(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    for (const tok of v.split(/[\s,;]+/)) {
      const t = tok.replace(/^[#"'(]+|["'),.]+$/g, "");
      if (t.length >= 3 && /\d/.test(t) && /^[#\w.:@-]+$/.test(t) && !/^\d{1,3}(\.\d+)?$/.test(t)) {
        out.push(t);
      }
    }
  } else if (typeof v === "number" && Number.isInteger(v) && Math.abs(v) >= 1000) {
    out.push(String(v));
  } else if (Array.isArray(v)) {
    for (const x of v) idLikeTokens(x, out);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) idLikeTokens(x, out);
  }
  return out;
}

/** Everything before the draft: rules, messages, prior calls and tool results. */
function contextText(messages: Msg[]): string {
  return messages
    .map((m) => [textOf(m.content), renderCalls(m.tool_calls)].filter(Boolean).join("\n"))
    .join("\n");
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The cited excerpt must really be there: ≥ 12 characters, verbatim up to whitespace and case. */
function quoteIsGrounded(quote: string, context: string): boolean {
  const q = normalize(quote).replace(/^["'“”]+|["'“”]+$/g, "");
  return q.length >= 12 && normalize(context).includes(q);
}

export interface GuardDecision {
  accept: boolean;
  reason: string;
}

/**
 * Whether a revision may replace the draft. Text and read-only calls may change
 * freely; any change to a state-changing call needs a grounded cited conflict,
 * may touch only the cited call (and, for a modified call, only the cited
 * argument), and may not introduce an id that appears nowhere before the draft.
 */
export function guardRevision(input: {
  messages: Msg[];
  tools: unknown[] | undefined;
  draft: Msg;
  revised: Msg;
  verdict: Verdict;
}): GuardDecision {
  const { messages, tools, draft, revised, verdict } = input;
  const before = writeCalls(draft, tools);
  const after = writeCalls(revised, tools);
  const same =
    before.length === after.length &&
    before.every((c, i) => c.name === after[i]?.name && deepEqual(c.args, after[i]?.args));
  if (same) return { accept: true, reason: "write calls unchanged" };

  const context = contextText(messages);
  const conflict = verdict.conflict;
  if (!conflict) return { accept: false, reason: "write call changed without a cited conflict" };
  if (!quoteIsGrounded(conflict.quote, context)) {
    return { accept: false, reason: "cited conflict not found in the conversation" };
  }
  const known = normalize(context);
  const grounded = (v: unknown) => idLikeTokens(v).every((t) => known.includes(t.toLowerCase()));

  // Match calls by name, in order: dropped, modified, then added.
  const remaining = [...after];
  for (const b of before) {
    const i = remaining.findIndex((a) => a.name === b.name);
    if (i < 0) {
      // Dropped (e.g. deferred until the user confirms): only the cited call.
      if (conflict.call && conflict.call !== b.name) {
        return { accept: false, reason: `dropped ${b.name}; the conflict cites ${conflict.call}` };
      }
      continue;
    }
    const a = remaining.splice(i, 1)[0] as WriteCall;
    if (deepEqual(a.args, b.args)) continue;
    if (!conflict.field || (conflict.call && conflict.call !== b.name)) {
      return { accept: false, reason: `modified ${b.name} without a cited argument` };
    }
    const path = pathSegments(conflict.field);
    if (!deepEqual(maskPath(a.args, path), maskPath(b.args, path))) {
      return { accept: false, reason: `modified ${b.name} beyond ${conflict.field}` };
    }
    if (!grounded(getPath(a.args, path))) {
      return { accept: false, reason: `${conflict.field} set to an id not in the conversation` };
    }
  }
  for (const added of remaining) {
    if (conflict.call !== added.name) {
      return { accept: false, reason: `added ${added.name} without citing it` };
    }
    if (!grounded(added.args)) {
      return { accept: false, reason: `added ${added.name} with an id not in the conversation` };
    }
  }
  return { accept: true, reason: "change limited to the cited conflict" };
}

interface CallResult {
  ok: boolean;
  status: number;
  body?: Record<string, unknown>;
  text?: string;
  costUsd?: number;
}

async function callUpstream(
  engine: Engine,
  body: Record<string, unknown>,
  model: string,
  signal: AbortSignal | undefined,
  reason: string,
): Promise<CallResult> {
  const resp = await proxyToUpstream(
    engine,
    { ...body, model, stream: false },
    model,
    { routeKind: "passthru", routeReason: reason },
    signal ? { clientSignal: signal } : undefined,
  );
  const raw = await resp.text();
  const cost = Number(resp.headers.get(COST_USD_HEADER));
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // allow-empty-catch: a non-JSON body is reported through `text`
  }
  return {
    ok: resp.ok,
    status: resp.status,
    ...(parsed ? { body: parsed } : {}),
    text: raw,
    ...(Number.isFinite(cost) ? { costUsd: cost } : {}),
  };
}

function firstMessage(body: Record<string, unknown> | undefined): Msg | undefined {
  const choices = body?.choices as Array<{ message?: Msg }> | undefined;
  return choices?.[0]?.message;
}

type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

function addUsage(a: Usage | undefined, b: unknown): Usage | undefined {
  const u = b as Usage | undefined;
  if (!u) return a;
  return {
    prompt_tokens: (a?.prompt_tokens ?? 0) + (u.prompt_tokens ?? 0),
    completion_tokens: (a?.completion_tokens ?? 0) + (u.completion_tokens ?? 0),
    total_tokens: (a?.total_tokens ?? 0) + (u.total_tokens ?? 0),
  };
}

/**
 * Handle a `marina/verify:` chat completion. Returns undefined when `model` is
 * not a verify id (the caller continues with normal routing).
 */
export async function maybeVerifyChat(
  engine: Engine,
  req: Request,
  body: Record<string, unknown>,
): Promise<Response | undefined> {
  const model = typeof body.model === "string" ? body.model : "";
  const spec = parseVerifyModel(model);
  if (!model.startsWith(VERIFY_MODEL_PREFIX)) return undefined;
  if (!spec)
    return errorJson(
      400,
      `Malformed verify model id "${model}" (marina/verify:<proposer>[+<checker>])`,
    );
  if (body.stream === true) {
    return unsupportedParam(
      "stream",
      "marina/verify reviews a complete draft; request stream:false.",
    );
  }
  if (typeof body.n === "number" && body.n > 1) {
    return unsupportedParam("n", "marina/verify returns one reviewed completion per request.");
  }
  for (const id of [spec.proposer, spec.checker]) {
    if (!explicitUpstreamModel(engine, id)) {
      return errorJson(400, `marina/verify needs a reachable upstream id; "${id}" is not one`, {
        code: "model_not_found",
      });
    }
  }
  const messages = Array.isArray(body.messages) ? (body.messages as Msg[]) : [];
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : undefined;
  const signal = req.signal;
  const requestId = generateRequestId();

  // 1. Proposer draft.
  const first = await callUpstream(engine, body, spec.proposer, signal, "verify:proposer");
  if (!first.ok || !first.body) {
    return new Response(first.text ?? "", {
      status: first.status,
      headers: { "content-type": "application/json", "x-request-id": requestId },
    });
  }
  let final = first.body;
  let draft = firstMessage(first.body) ?? {};
  let usage = addUsage(undefined, first.body.usage);
  let cost = first.costUsd ?? 0;
  let verdictLabel = "approved";
  const rounds = verifyRounds();

  // 2. Review (and up to `rounds` revisions).
  for (let round = 0; round < Math.max(1, rounds); round++) {
    let verdict: Verdict;
    try {
      const review = await callUpstream(
        engine,
        {
          messages: [
            { role: "system", content: CHECKER_SYSTEM },
            { role: "user", content: renderReview(messages, tools, draft) },
          ],
        },
        spec.checker,
        signal,
        "verify:checker",
      );
      cost += review.costUsd ?? 0;
      usage = addUsage(usage, review.body?.usage);
      verdict = review.ok
        ? parseVerdict(textOf(firstMessage(review.body)?.content))
        : { verdict: "approve", issues: "" };
      if (!review.ok) verdictLabel = "checker-unavailable";
    } catch (e) {
      log.warn("model-api", `verify: checker failed, approving draft: ${getErrorMessage(e)}`);
      verdictLabel = "checker-unavailable";
      break;
    }
    if (verdict.verdict === "approve") break;
    if (rounds === 0) {
      verdictLabel = "flagged";
      break;
    }
    // 3. Revision by the proposer, with the reviewer's note.
    const revised = await callUpstream(
      engine,
      {
        ...body,
        messages: [
          ...messages,
          { role: "system", content: revisionNote(draft, verdict.issues, verdict.conflict) },
        ],
      },
      spec.proposer,
      signal,
      "verify:revision",
    ).catch(() => undefined);
    if (!revised?.ok || !revised.body || !firstMessage(revised.body)) {
      verdictLabel = "revision-failed";
      break;
    }
    cost += revised.costUsd ?? 0;
    usage = addUsage(usage, revised.body.usage);
    const candidate = firstMessage(revised.body) ?? draft;
    const guard = guardRevision({ messages, tools, draft, revised: candidate, verdict });
    if (!guard.accept) {
      // The revision touched a state-changing call without a grounded, cited
      // conflict: the draft stands (fail open), and the reason is logged.
      log.info("model-api", `verify: held the drafted write action (${guard.reason})`);
      verdictLabel = "held-write";
      break;
    }
    final = revised.body;
    draft = candidate;
    verdictLabel = "revised";
  }

  engine.logEvent({
    type: "model_request_lifecycle",
    phase: "completed",
    requestId,
    ...requestTrace(requestId),
    model,
    target: spec.proposer,
    routeKind: "passthru",
    routeReason: `verify:${verdictLabel}`,
    timestamp: Date.now(),
  });
  return json({ ...final, model, ...(usage ? { usage } : {}) }, 200, {
    "x-request-id": requestId,
    "x-marina-verify": verdictLabel,
    [COST_USD_HEADER]: cost.toFixed(8),
  });
}
