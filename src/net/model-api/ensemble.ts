// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The ensemble formation for ONE passthru turn, tools included: N proposers
// draft the next assistant message independently (same request, same
// trailing note), a checker picks ONE whole draft by number with a stated
// reason, and that draft is the reply. Drafts are never merged: a picked
// draft's tool calls are exactly the proposer's. The tool loop stays the
// client's — only the picked message is returned.
//
//   x-marina-stack: ensemble[,…]            the request's model × MARINA_ENSEMBLE_SIZE
//   marina/ensemble:<a>,<b>[,…]             a listed panel (the innermost prefix)
//
// Opt-in only: never part of the identified-caller default stack nor of
// `full` (it multiplies upstream calls). The obligations ledger and the
// argument check wrap it like a single upstream call (a nudge re-runs the
// ensemble); output repair applies to the picked draft as in `verify`.
// With `verify` it is verify's draft source (`VerifyExtras.draft`): the pick
// is reviewed exactly like a single proposer's draft, a revision is ONE call
// by the picked draft's proposer, and repair runs once, on verify's final.
// A checker outage fails open to the first draft of the largest group that
// shares its state-changing calls (else the first valid draft), labelled.

import type { Engine } from "../../engine/engine";
import { getErrorMessage, logRejection } from "../../engine/errors";
import { Logger } from "../../engine/logger";
import { parsePick } from "../../orchestration/pick";
import type { RepairLabel } from "../../repair/output-repair";
import { repairToolCallMessage } from "../../repair/tool-call-repair";
import type { EntityId } from "../../types";
import {
  COST_USD_HEADER,
  generateRequestId,
  json,
  openaiStreamRoleChunk,
  requestTrace,
  SSE_HEADERS,
} from "./shared";
import { explicitUpstreamModel, proxyToUpstream } from "./upstream";
import {
  addUsage,
  firstMessage,
  isReadOnlyToolCall,
  type Msg,
  parseVerifyModel,
  renderAssistant,
  renderReviewHead,
  renderTurns,
  repairModelFor,
  textOf,
  type Usage,
  VERIFY_MODEL_PREFIX,
  withFirstMessage,
} from "./verify";

const log = new Logger();

export const ENSEMBLE_MODEL_PREFIX = "marina/ensemble:";
/** Response: `picked=<k>/<n>; drafts=<valid>/<n>; <label>`. */
export const ENSEMBLE_HEADER = "x-marina-ensemble";

const MIN_SIZE = 2;
const MAX_SIZE = 5;

/** `MARINA_ENSEMBLE_SIZE` (default 3, clamped to 2–5): proposers for the `ensemble` stack member. */
export function ensembleSize(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MARINA_ENSEMBLE_SIZE?.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 3;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n));
}

/**
 * `marina/ensemble:<a>,<b>[,…]` → the proposer ids (2–5, repeats allowed:
 * `<a>,<a>,<a>` samples one model three times). Undefined when not an
 * ensemble id; an error string when the list is malformed.
 */
export function parseEnsembleModels(model: unknown): string[] | { error: string } | undefined {
  if (typeof model !== "string" || !model.startsWith(ENSEMBLE_MODEL_PREFIX)) return undefined;
  const ids = model
    .slice(ENSEMBLE_MODEL_PREFIX.length)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length < MIN_SIZE || ids.length > MAX_SIZE)
    return {
      error: `${ENSEMBLE_MODEL_PREFIX} takes ${MIN_SIZE}–${MAX_SIZE} comma-separated model ids (got ${ids.length}).`,
    };
  return ids;
}

/**
 * The ensemble's checker: the passthru pin when one applies, else the verify
 * checker resolution for the first proposer (`MARINA_VERIFY_CHECKER_MODEL`,
 * the earned `verify:checker` slot, else the proposer itself).
 */
export function ensembleChecker(engine: Engine, first: string, pin: string): string {
  if (pin) return pin;
  return (
    parseVerifyModel(
      `${VERIFY_MODEL_PREFIX}${first}`,
      process.env,
      undefined,
      engine.db,
      (id) => !!explicitUpstreamModel(engine, id),
    )?.checker ?? first
  );
}

export const ENSEMBLE_PICK_SYSTEM = [
  "You choose the best of several DRAFT next assistant messages, written independently for the same conversation.",
  "Judge each against the rules the assistant was given, the user's actual requests, and facts established by earlier tool results.",
  "Prefer the draft that takes the correct next step with correct arguments. A draft that skips a confirmation the rules require,",
  "invents an id or value, acts on something the user did not ask for, or ends or refuses when the rules say otherwise is worse.",
  "When drafts' state-changing tool calls disagree, pick the one whose calls the conversation best supports; you pick ONE whole draft, never a combination.",
  "When only read-only lookups differ, prefer the draft whose lookups gather the information still missing.",
  'Reply with JSON only: {"pick":<draft number>,"reason":"<≤ 40 words>"}.',
].join(" ");

/** A canonical JSON value (object keys sorted), so equal arguments compare equal. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function canonicalArgs(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return canonical(JSON.parse(raw));
  } catch {
    return raw;
  }
}

/** A draft's state-changing calls as one comparable string (empty when it makes none). */
export function writeSignature(draft: Msg, tools: unknown[] | undefined): string {
  const writes = (draft.tool_calls ?? [])
    .filter((c) => !isReadOnlyToolCall(c.function?.name ?? "", tools))
    .map((c) => JSON.stringify([c.function?.name ?? "", canonicalArgs(c.function?.arguments)]))
    .sort();
  return writes.join("\n");
}

/**
 * Indices of the largest group of drafts sharing the same state-changing
 * calls, when that group is a strict majority and makes at least one write.
 */
export function majorityWriteGroup(drafts: Msg[], tools: unknown[] | undefined): number[] {
  const groups = new Map<string, number[]>();
  drafts.forEach((d, i) => {
    const sig = writeSignature(d, tools);
    groups.set(sig, [...(groups.get(sig) ?? []), i]);
  });
  let best: [string, number[]] | undefined;
  for (const entry of groups) if (!best || entry[1].length > best[1].length) best = entry;
  // The no-write group never counts as agreement on state-changing calls.
  if (!best?.[0]) return [];
  return best[1].length * 2 > drafts.length ? best[1] : [];
}

/** The checker's messages: the conversation (as verify renders it), then every draft, numbered. */
export function pickMessages(input: {
  messages: Msg[];
  tools: unknown[] | undefined;
  drafts: Msg[];
  notes?: string;
}): Array<Record<string, unknown>> {
  const { messages, tools, drafts, notes } = input;
  const majority = majorityWriteGroup(drafts, tools);
  const draftText = drafts.map((d, i) => `DRAFT ${i + 1}:\n${renderAssistant(d)}`).join("\n\n");
  const agreement =
    majority.length > 0
      ? `(Drafts ${majority.map((i) => i + 1).join(", ")} make the same state-changing calls.)`
      : "";
  const user = [
    renderReviewHead(messages, tools),
    ...renderTurns(messages),
    notes ?? "",
    `CANDIDATE NEXT ASSISTANT MESSAGES:\n${draftText}`,
    agreement,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: ENSEMBLE_PICK_SYSTEM },
    { role: "user", content: user },
  ];
}

export { parsePick };

interface Draft {
  ok: boolean;
  status: number;
  text: string;
  body?: Record<string, unknown>;
  message?: Msg;
  costUsd: number;
}

async function call(
  engine: Engine,
  body: Record<string, unknown>,
  model: string,
  forceModel: string | undefined,
  reason: string,
  o: { signal?: AbortSignal; entityId?: EntityId; trailingNote?: string; noteScope?: string },
): Promise<Draft> {
  try {
    const resp = await proxyToUpstream(
      engine,
      { ...body, model, stream: false },
      forceModel,
      {
        routeKind: "passthru",
        routeReason: reason,
        ...(o.entityId ? { entityId: o.entityId } : {}),
      },
      {
        ...(o.signal ? { clientSignal: o.signal } : {}),
        providerFallback: false,
        ...(o.trailingNote ? { trailingNote: o.trailingNote } : {}),
        ...(o.noteScope ? { noteScope: o.noteScope } : {}),
      },
    );
    const text = await resp.text();
    const cost = Number(resp.headers.get(COST_USD_HEADER));
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // allow-empty-catch: a non-JSON body is reported through `text`
    }
    const message = resp.ok ? firstMessage(parsed) : undefined;
    return {
      ok: resp.ok,
      status: resp.status,
      text,
      ...(parsed ? { body: parsed } : {}),
      ...(message ? { message } : {}),
      costUsd: Number.isFinite(cost) ? cost : 0,
    };
  } catch (e) {
    return { ok: false, status: 502, text: getErrorMessage(e), costUsd: 0 };
  }
}

export interface EnsembleTurn {
  /** The caller's chat body (tools included); `stream` is ignored (drafts are complete). */
  body: Record<string, unknown>;
  /** One id per proposer (repeats allowed). */
  proposers: string[];
  /** The checker that picks (the verify checker resolution). */
  checker: string;
  /** The passthru force model (an operator pin or passthru default), applied to every call. */
  forceModel?: string;
  /** Lessons, the caller's memory context, the open obligations, a nudge: every proposer's trailing note. */
  note?: string;
  /** What the checker sees beside the conversation (lessons and the caller's own context). */
  checkerNotes?: string;
  /** Repair shots' model fallback, and the passthru pin (`verifyPin`). */
  pin: string;
  /** The model id reported back to the caller. */
  displayModel: string;
  entityId?: EntityId;
  signal?: AbortSignal;
  /** The caller's sticky-note scope for the proposers' calls (`sticky-notes.ts`). */
  noteScope?: string;
  /** Output repair on the pick (default true). Off when `verify` reviews the pick:
   *  verify repairs its final message once. */
  repair?: boolean;
}

/** An ensemble turn's reply and the proposer whose draft it carries (none on failure). */
export interface EnsembleResult {
  response: Response;
  proposer?: string;
}

/**
 * One ensemble turn: parallel drafts, one pick, output repair. Returns the
 * picked completion (JSON) with summed usage and cost, or the first failure
 * when no draft came back.
 */
export async function runEnsembleTurn(engine: Engine, t: EnsembleTurn): Promise<Response> {
  return (await ensembleTurn(engine, t)).response;
}

/** `runEnsembleTurn`, also naming the picked draft's proposer (verify's reviser). */
export async function ensembleTurn(engine: Engine, t: EnsembleTurn): Promise<EnsembleResult> {
  const requestId = generateRequestId();
  const o = {
    ...(t.signal ? { signal: t.signal } : {}),
    ...(t.entityId ? { entityId: t.entityId } : {}),
  };
  const messages = Array.isArray(t.body.messages) ? (t.body.messages as Msg[]) : [];
  const tools = Array.isArray(t.body.tools) ? (t.body.tools as unknown[]) : undefined;
  const n = t.proposers.length;
  const drafts = await Promise.all(
    t.proposers.map((id, i) =>
      call(engine, t.body, id, t.forceModel, `ensemble:proposer:${i + 1}`, {
        ...o,
        ...(t.note ? { trailingNote: t.note } : {}),
        ...(t.noteScope ? { noteScope: t.noteScope } : {}),
      }),
    ),
  );
  let usage: Usage | undefined;
  let cost = 0;
  for (const d of drafts) {
    usage = addUsage(usage, d.body?.usage);
    cost += d.costUsd;
  }
  const valid = drafts.flatMap((d, i) => (d.ok && d.message ? [i] : []));
  if (valid.length === 0) {
    const first = drafts[0]!;
    return {
      response: new Response(first.text, {
        status: first.ok ? 502 : first.status,
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
          [ENSEMBLE_HEADER]: `picked=0/${n}; drafts=0/${n}; no-draft`,
        },
      }),
    };
  }
  const validMessages = valid.map((i) => drafts[i]!.message!);
  let picked = valid[0]!;
  let label: string;
  if (valid.length === 1) {
    label = "single";
  } else if (new Set(validMessages.map(renderAssistant)).size === 1) {
    label = "unanimous";
  } else {
    const pick = await call(
      engine,
      { messages: pickMessages({ messages, tools, drafts: validMessages, notes: t.checkerNotes }) },
      t.checker,
      t.forceModel,
      "ensemble:checker",
      o,
    );
    usage = addUsage(usage, pick.body?.usage);
    cost += pick.costUsd;
    const verdict = pick.ok
      ? parsePick(textOf(pick.message?.content), validMessages.length)
      : undefined;
    if (verdict) {
      picked = valid[verdict.index]!;
      label = "picked";
    } else {
      // Fail open: the largest agreeing group's first draft, else the first.
      const group = majorityWriteGroup(validMessages, tools);
      picked = valid[group[0] ?? 0]!;
      label = "checker-unavailable";
    }
  }
  let final = drafts[picked]!.body!;

  // Output repair on the picked draft (meaning unchanged; write calls under
  // the write-guard rules), as `verify` does. Off with MARINA_OUTPUT_REPAIR=off.
  let repairLabel: RepairLabel | undefined;
  const pickedMessage = firstMessage(final);
  if (t.repair !== false && tools?.length && pickedMessage) {
    const repairModel = repairModelFor(engine, t.proposers[picked]!, t.pin);
    const repaired = await repairToolCallMessage({
      message: pickedMessage,
      tools,
      isWrite: (name) => !isReadOnlyToolCall(name, tools),
      shot: async (system, user) => {
        const r = await call(
          engine,
          {
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          },
          repairModel,
          t.forceModel,
          "ensemble:repair",
          o,
        );
        cost += r.costUsd;
        usage = addUsage(usage, r.body?.usage);
        return r.ok ? textOf(r.message?.content) : "";
      },
    }).catch(
      logRejection(log, "model-api", "ensemble: repair failed; keeping the draft", {
        level: "debug",
      }),
    );
    if (repaired) {
      repairLabel = repaired.label;
      final = withFirstMessage(final, repaired.message);
      log.info("model-api", `ensemble: ${repaired.label} — ${repaired.detail}`);
    }
  }

  // The pick verdict: numbers only (no draft or conversation content).
  engine.logEvent({
    type: "model_request_lifecycle",
    phase: "completed",
    requestId,
    ...requestTrace(requestId),
    model: t.displayModel,
    target: t.proposers[picked]!,
    routeKind: "passthru",
    ...(t.entityId ? { entityId: t.entityId } : {}),
    routeReason: `ensemble:${label}:${picked + 1}/${n}:drafts=${valid.length}${repairLabel ? `+${repairLabel}` : ""}`,
    timestamp: Date.now(),
  });
  const response = json({ ...final, model: t.displayModel, ...(usage ? { usage } : {}) }, 200, {
    "x-request-id": requestId,
    [ENSEMBLE_HEADER]: `picked=${picked + 1}/${n}; drafts=${valid.length}/${n}; ${label}`,
    ...(repairLabel ? { "x-marina-repair": repairLabel } : {}),
    [COST_USD_HEADER]: cost.toFixed(8),
  });
  return { response, proposer: t.proposers[picked]! };
}

type ToolCallOut = { id?: string; type?: string; function?: { name?: string; arguments?: string } };

/**
 * A complete chat completion re-emitted as OpenAI SSE (one content delta,
 * one tool-call delta, the finish reason, usage when asked), with the
 * response's own headers kept. Used when a streaming request ran a formation
 * that needs the complete reply.
 */
export async function completionAsSse(resp: Response, includeUsage: boolean): Promise<Response> {
  if (!resp.ok) return resp;
  const j = (await resp.json()) as {
    id?: string;
    model?: string;
    usage?: unknown;
    choices?: Array<{
      message?: { content?: unknown; tool_calls?: ToolCallOut[] };
      finish_reason?: string;
    }>;
  };
  const id = j.id ?? `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  const model = j.model ?? "";
  const choice = j.choices?.[0];
  const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const calls = choice?.message?.tool_calls ?? [];
  const chunk = (delta: Record<string, unknown>, finish: string | null, extra = {}) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    })}\n\n`;
  const parts = [openaiStreamRoleChunk(id, model)];
  if (content) parts.push(chunk({ content }, null));
  if (calls.length)
    parts.push(
      chunk(
        {
          tool_calls: calls.map((c, index) => ({
            index,
            ...(c.id ? { id: c.id } : {}),
            type: c.type ?? "function",
            function: { name: c.function?.name ?? "", arguments: c.function?.arguments ?? "" },
          })),
        },
        null,
      ),
    );
  parts.push(chunk({}, choice?.finish_reason ?? (calls.length ? "tool_calls" : "stop")));
  if (includeUsage && j.usage)
    parts.push(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage: j.usage })}\n\n`,
    );
  parts.push("data: [DONE]\n\n");
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(SSE_HEADERS)) headers.set(k, v);
  headers.delete("content-length");
  return new Response(parts.join(""), { status: 200, headers });
}
