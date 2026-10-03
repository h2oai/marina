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
// Fails open: a checker outage, an unparseable verdict or a failed revision
// returns the proposer's draft unchanged (the verifier accepts on outage, as
// in `src/decisions/policy.ts`).

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
  return { proposer, checker };
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
  'Reply with JSON only: {"verdict":"approve"|"revise","issues":"<concrete fix, ≤ 80 words, empty when approving>"}',
].join(" ");

export interface Verdict {
  verdict: "approve" | "revise";
  issues: string;
}

/** Lenient verdict parse; anything unreadable is an approval (fail open). */
export function parseVerdict(text: string): Verdict {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { verdict?: unknown; issues?: unknown };
      const v = typeof j.verdict === "string" ? j.verdict.toLowerCase() : "";
      const issues = typeof j.issues === "string" ? j.issues.trim() : "";
      if (v === "revise" && issues) return { verdict: "revise", issues };
      return { verdict: "approve", issues: "" };
    } catch {
      // allow-empty-catch: an unparseable verdict is an approval (fail open)
    }
  }
  return { verdict: "approve", issues: "" };
}

/** The note appended for a revision call (a trailing system message). */
export function revisionNote(draft: Msg, issues: string): string {
  return [
    "A reviewer checked your draft next message before it was sent and found a problem.",
    `Draft: ${clamp(renderAssistant(draft), 2000)}`,
    `Reviewer: ${issues}`,
    "Write the corrected next message now (a tool call is allowed). If the reviewer is wrong, send the draft unchanged.",
  ].join("\n");
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
        messages: [...messages, { role: "system", content: revisionNote(draft, verdict.issues) }],
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
    final = revised.body;
    draft = firstMessage(revised.body) ?? draft;
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
