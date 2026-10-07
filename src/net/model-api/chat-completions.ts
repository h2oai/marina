// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `/v1/chat/completions`: the parsed-body core (`runOpenaiChat`) shared with the
// `/v1/messages` bridge — passthru / internal proxy branch, the verified
// arithmetic fast path, agents / open / panel routing, streaming and the
// 503 → upstream fallback.

import { BUDGET_FORCED_HEADER, DEADLINE_HEADER } from "../../agent/budget-terminal";
import { parseDeadlineHeader } from "../../coordination/request-deadline";
import type { Engine } from "../../engine/engine";
import { stageRequestImages } from "../../engine/media/vision";
import { evalOption, LESSONS_HEADER } from "../../learning/eval-context";
import type { OutcomeDomain } from "../../learning/outcomes";
import { lessonsBlock, lessonsHeaderValue, recallForWork } from "../../learning/service";
import { getEndpointConfig } from "../model-endpoint";
import { type InjectionFormat, messageText, type OpenAIMessage } from "../passthru-context";
import {
  ARGCHECK_MODEL_PREFIX,
  argcheckRequestMode,
  finishArgcheck,
  prepareArgcheck,
  statedFromLedger,
} from "./argcheck";
import { notePassthruRecoveries, passthruLearnOwner } from "./learn";
import {
  finishObligations,
  OBLIGATIONS_MODEL_PREFIX,
  obligationsRequestMode,
  prepareObligations,
} from "./obligations";
import {
  capturePassthruResponse,
  joinNotes,
  lessonQuery,
  passthruCacheLookup,
  passthruCacheStore,
  passthruTraceOptions,
  passthruUpstreamHints,
  preparePassthru,
  requestImagePrincipal,
} from "./passthru";
import {
  bufferedOpenaiStream,
  type RouteOptions,
  type RouteResult,
  rejectUnsupportedForAgents,
  requestImageGrant,
  routeOpen,
  routePanel,
  routeToChannel,
  routeToChannelStreaming,
  usageFromTrace,
} from "./routing";
import {
  errorJson,
  extractConversationId,
  extractStrategy,
  HttpError,
  isInternalCaller,
  json,
  liveOrchestrationChannel,
  MODEL_CORS,
  modelToChannelName,
  openaiCompletion,
  type PassthruAuthResult,
  readModelJsonBody,
  requestTrace,
} from "./shared";
import { explicitUpstreamModel, passthruForceModel, proxyToUpstream } from "./upstream";
import { maybeVerifyChat, VERIFY_MODEL_PREFIX } from "./verify";

/**
 * `marina/lessons:<model>` — the plain request to <model>, with judged lessons
 * (tools, code and cross-board meta) injected as one labelled system block.
 * `x-marina-lessons: on` does the same for an unchanged model id.
 */
export const LESSONS_MODEL_PREFIX = "marina/lessons:";

/** The lesson domains a plain passthru request recalls (meta rides on top). */
export const PASSTHRU_LESSON_DOMAINS: readonly OutcomeDomain[] = ["tools", "code"];

/** The opt-in model prefixes a plain passthru request may carry, in any order. */
const OPT_IN_PREFIXES = [
  LESSONS_MODEL_PREFIX,
  OBLIGATIONS_MODEL_PREFIX,
  ARGCHECK_MODEL_PREFIX,
] as const;

/**
 * `model` with the opt-in prefixes stripped, except `keep` (left in front when
 * present anywhere in the chain, so `wantsLessons` / `obligationsRequestMode`
 * still see their own prefix). Non-strings pass through.
 */
export function stripOptInPrefixes(model: unknown, keep?: string): unknown {
  if (typeof model !== "string") return model;
  let rest = model;
  let kept = false;
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of OPT_IN_PREFIXES) {
      if (rest.indexOf(p) === 0) {
        if (p === keep) kept = true;
        rest = rest.slice(p.length);
        changed = true;
      }
    }
  }
  return kept && keep ? `${keep}${rest}` : rest;
}

/** Did the request opt into lessons (model prefix, or `x-marina-lessons: on`)? */
export function wantsLessons(req: Request, model: unknown): boolean {
  if (typeof model === "string" && model.startsWith(LESSONS_MODEL_PREFIX)) return true;
  const v = req.headers.get(LESSONS_HEADER)?.trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

/** The upstream's response with one more header (its headers may be immutable). */
function withResponseHeader(resp: Response, name: string, value: string): Response {
  const headers = new Headers(resp.headers);
  headers.set(name, value);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

/** Resolve only an explicit, single binary arithmetic expression. This is
 * intentionally conservative: no precedence, variables, units, or inferred
 * operations. Those remain agent work. */
export function tryVerifiedArithmetic(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > 300) return undefined;
  const question = input.split("?")[0]!.trim();
  const match = question.match(
    /^(?:(?:what\s+is|calculate|compute)\s+)?(-?\d+(?:\.\d+)?)\s*(multiplied\s+by|times|plus|minus|divided\s+by|[+*/-])\s*(-?\d+(?:\.\d+)?)$/i,
  );
  if (!match) return undefined;
  const left = Number(match[1]);
  const right = Number(match[3]);
  const operator = match[2]!.toLowerCase().replace(/\s+/g, " ");
  if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined;

  let result: number;
  let symbol: string;
  if (operator === "multiplied by" || operator === "times" || operator === "*") {
    result = left * right;
    symbol = "×";
  } else if (operator === "plus" || operator === "+") {
    result = left + right;
    symbol = "+";
  } else if (operator === "minus" || operator === "-") {
    result = left - right;
    symbol = "−";
  } else {
    if (right === 0) return undefined;
    result = left / right;
    symbol = "÷";
  }
  if (!Number.isFinite(result)) return undefined;
  const rendered = Number.isInteger(result)
    ? String(result)
    : String(Number(result.toPrecision(12)));
  return `${rendered}. Verified directly: ${left} ${symbol} ${right} = ${rendered}.`;
}

export async function handleOpenaiChat(
  req: Request,
  engine: Engine,
  authResult?: PassthruAuthResult,
): Promise<Response> {
  const read = await readModelJsonBody(req);
  if (!read.ok) return read.response;
  return runOpenaiChat(engine, req, read.body, authResult);
}

/**
 * Core OpenAI chat handling over an already-parsed body. Reached directly by
 * `handleOpenaiChat` and via the `/v1/messages` runInternal callback (the
 * Anthropic Messages bridge translates its request into an OpenAI body first).
 * `req` is still passed for headers (conversation id, load-balance, passthru
 * identity) and auth context; `runOpts.stream` lets a bridge override the body's
 * stream flag.
 */
export async function runOpenaiChat(
  engine: Engine,
  req: Request,
  requestBody: Record<string, unknown>,
  authResult?: PassthruAuthResult,
  runOpts?: {
    stream?: boolean;
    /** Protocol surface for passthru lifecycle events; `openai` unless a bridge says otherwise. */
    surface?: InjectionFormat;
    /** The client's ORIGINAL Anthropic Messages body (`/v1/messages` bridge);
     *  forwarded verbatim when the upstream is Anthropic. */
    anthropicNative?: Record<string, unknown>;
  },
): Promise<Response> {
  try {
    let body: Record<string, unknown> =
      runOpts?.stream !== undefined ? { ...requestBody, stream: runOpts.stream } : requestBody;
    // `marina/lessons:<model>` (or `x-marina-lessons: on`) opts a plain request
    // into judged lessons, `marina/obligations:<model>` (or
    // `x-marina-obligations: on|observe`) into the obligations ledger,
    // `marina/argcheck:<model>` (or `x-marina-argcheck: on|observe`) into the
    // argument check before writes; they combine in any order, and the
    // prefixes are stripped before anything else sees the model id.
    const lessonsOptIn = wantsLessons(req, stripOptInPrefixes(body.model, LESSONS_MODEL_PREFIX));
    const obligationsMode = obligationsRequestMode(
      req,
      stripOptInPrefixes(body.model, OBLIGATIONS_MODEL_PREFIX),
    );
    const argcheckMode = argcheckRequestMode(
      req,
      stripOptInPrefixes(body.model, ARGCHECK_MODEL_PREFIX),
    );
    const bare = stripOptInPrefixes(body.model);
    if (bare !== body.model) body = { ...body, model: bare };
    const model = typeof body.model === "string" ? body.model : "marina";
    const messages = Array.isArray(body.messages) ? (body.messages as OpenAIMessage[]) : [];

    // `marina/verify:<proposer>[+<checker>]` — the verification formation as a
    // model id (proposer → checker review → bounded revision), tools included.
    if (model.startsWith(VERIFY_MODEL_PREFIX)) {
      const verified = await maybeVerifyChat(engine, req, body, authResult);
      if (verified) return verified;
    }

    // Extract last user message
    const userMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!userMsg) return errorJson(400, "No user message found");
    let userText = messageText(userMsg.content);
    // NOTE: the empty-userText guard lives BELOW the passthru branch — passthru is
    // a thin gateway that must forward multimodal / image-only bodies (which have
    // no textual user content) unchanged. Requiring text here would break them and
    // make injection-OFF passthru non-byte-identical.

    // Build context from system/prior messages
    const contextParts: string[] = [];
    for (const msg of messages) {
      if (msg === userMsg) break;
      contextParts.push(`${msg.role}: ${messageText(msg.content)}`);
    }
    const context = contextParts.length > 0 ? contextParts.join("\n") : undefined;

    const conversationId = extractConversationId(req, body);
    const ec = getEndpointConfig(engine.db);

    // Passthru: Marina is a thin gateway — proxy straight to the configured
    // upstream model. When the caller opts into shared-world context (bound key
    // config or `X-Marina-Context: on`), inject their OWN readable context and
    // record the exchange. Strict NO-OP otherwise: no identity resolve-or-create,
    // no injected bytes, no memory writes — byte-identical to the un-instrumented
    // path (see `maybePassthruIdentity`).
    //
    // Marina's OWN agents (internal model token) take this branch in EVERY
    // endpoint mode — see `isInternalCaller`. Their lifecycle events keep
    // `routeKind: "passthru"` and add `routeReason: "internal"`.
    // An explicit id naming a live agent channel goes to those agents even in
    // passthru mode or from an internal caller (see liveOrchestrationChannel).
    const orchestration = liveOrchestrationChannel(
      engine,
      model,
      req.headers.get("X-Marina-Agent")?.split(":")[0]?.trim() || undefined,
    );
    // An explicit upstream id (`openrouter/<vendor>/<model>`, `anthropic/<model>`,
    // …) reaches that upstream in every mode — the mirror of the orchestration
    // rule above (see `explicitUpstreamModel`).
    if (
      (ec.mode === "passthru" ||
        isInternalCaller(authResult) ||
        explicitUpstreamModel(engine, model)) &&
      !orchestration
    ) {
      // Also the `/v1/messages` path: the Anthropic bridge translates its body
      // to this shape first. The SURFACE recorded on the lifecycle events is
      // the protocol the client actually spoke (`anthropic` when the bridge
      // called in).
      const shared = await preparePassthru(
        engine,
        req,
        authResult,
        messages,
        runOpts?.surface ?? "openai",
      );
      // Opt-in lessons ride the same addendum (after the caller's context), so
      // a plain passthru request is byte-identical unless it asked for them.
      // The set is chosen from the conversation's OPENING request, so it stays
      // the same on every turn of one conversation and changes only when the
      // lesson pool does; the addendum rides after the cache breakpoints
      // (`passthruUpstreamHints`), so the cached prefix never depends on it.
      // A bound key's own lessons (learned from its opted-in work) ride with the
      // shared pool; Marina's own agents read only the shared pool here.
      const lessonOwner =
        authResult && !isInternalCaller(authResult) ? authResult.boundEntityName : undefined;
      const lessons = lessonsOptIn
        ? await recallForWork(engine.db, PASSTHRU_LESSON_DOMAINS, lessonQuery(messages), {
            limit: 4,
            maxBytes: 800,
            ...evalOption(req),
            ...(lessonOwner ? { owner: lessonOwner } : {}),
          })
        : undefined;
      // Lessons from work: an explicitly opted-in, bound, non-measurement
      // conversation's tool recoveries teach its owner (`x-marina-learn: on`).
      const learnOwner = passthruLearnOwner(req, authResult);
      if (learnOwner) notePassthruRecoveries(engine.db, learnOwner, messages);
      const lessonText = lessons ? lessonsBlock(lessons.inject) : "";
      const prep = lessonText
        ? {
            ...shared,
            addendum: shared.addendum ? `${shared.addendum}\n\n${lessonText}` : lessonText,
          }
        : shared;
      const anthropicNative = runOpts?.anthropicNative;
      const forceModel = passthruForceModel(engine, ec, model);
      // Opt-in obligations ledger: read this request into its conversation's
      // ledger; the open obligations ride as a trailing note after the cache
      // breakpoints. Its replies depend on the ledger, so the response cache
      // is not consulted.
      const obligations = obligationsMode
        ? await prepareObligations(engine, req, body, messages, {
            mode: obligationsMode,
            forceModel,
            ...(prep.identity?.entityId ? { entityId: prep.identity.entityId } : {}),
            ...(authResult ? { auth: authResult } : {}),
          })
        : undefined;
      // Opt-in argument check: the reply's state-changing calls are checked
      // against the conversation after the call (with the obligations
      // ledger's stated requests as context when it runs too).
      const argcheck = prepareArgcheck(engine, req, body, messages, {
        mode: argcheckMode,
        forceModel,
        ...(prep.identity?.entityId ? { entityId: prep.identity.entityId } : {}),
        ...(authResult ? { auth: authResult } : {}),
        ...(obligations ? { stated: statedFromLedger(obligations.ledger) } : {}),
        ...(learnOwner ? { learnOwner } : {}),
      });
      const cached =
        obligations || argcheck
          ? undefined
          : await passthruCacheLookup(engine, prep, body, forceModel);
      if (cached) return cached;
      // Every per-request note (memory, lessons, the obligations reminder, a
      // nudge) is ONE trailing note after the cache breakpoints.
      const hintsWith = (note?: string) => ({
        ...passthruUpstreamHints(prep, {
          ...(anthropicNative ? { anthropicNative } : {}),
          ...(note ? { extraNote: note } : {}),
        }),
        clientSignal: req.signal,
      });
      let resp = await proxyToUpstream(
        engine,
        body,
        forceModel || undefined,
        passthruTraceOptions(prep),
        hintsWith(obligations?.note),
      );
      if (obligations) {
        const { requestId: _first, ...retryTrace } = passthruTraceOptions(prep);
        resp = await finishObligations(engine, obligations, body, resp, (note) =>
          proxyToUpstream(
            engine,
            body,
            forceModel || undefined,
            { ...retryTrace, routeReason: "obligations:nudge" },
            hintsWith(note),
          ),
        );
      }
      if (argcheck) {
        const { requestId: _first, ...retryTrace } = passthruTraceOptions(prep);
        resp = await finishArgcheck(argcheck, body, resp, (note) =>
          proxyToUpstream(
            engine,
            body,
            forceModel || undefined,
            { ...retryTrace, routeReason: "argcheck:nudge" },
            // The open obligations stay in view next to the check's note.
            hintsWith(joinNotes(obligations?.note, note)),
          ),
        );
      }
      if (prep.identity?.contextOptIn) {
        void capturePassthruResponse(engine, prep.identity.entityId, messages, resp);
        if (!obligations && !argcheck) passthruCacheStore(engine, prep, body, forceModel, resp);
      }
      return lessons ? withResponseHeader(resp, LESSONS_HEADER, lessonsHeaderValue(lessons)) : resp;
    }

    // Non-passthru routing modes synthesize an answer from the user's text (or
    // its images, staged below), so one must be present. (Passthru already
    // returned above without this requirement.)
    const hasImages =
      Array.isArray(userMsg.content) &&
      userMsg.content.some((p) => {
        const t = (p as { type?: unknown })?.type;
        return t === "image_url" || t === "input_image";
      });
    if (!userText && !hasImages) return errorJson(400, "User message has no textual content");

    // Agents answer in text over a channel: tools / n / response_format cannot
    // be honored here. Refuse explicitly (code `unsupported_parameter`) rather
    // than return a plain answer the client will misread as "no tool call".
    const rejected = rejectUnsupportedForAgents(body);
    if (rejected) return rejected;

    // Agents hear the request as clamped text, so its images go on the
    // caller's private inbox canvas and the text names each node for `canvas look`.
    if (hasImages) {
      const staged = await stageRequestImages(
        engine,
        userMsg.content,
        requestImagePrincipal(engine, req, authResult),
        requestImageGrant(engine, model),
      );
      userText = [userText, ...staged].filter(Boolean).join("\n");
    }

    const opts: RouteOptions = {
      context,
      conversationId,
      strategy: req.headers.has("X-Load-Balance") ? extractStrategy(req) : ec.strategy,
    };
    const clientDeadline = parseDeadlineHeader(req.headers.get(DEADLINE_HEADER));
    if (clientDeadline) opts.deadlineMs = clientDeadline;
    const evalCtx = evalOption(req).eval;
    if (evalCtx) opts.eval = evalCtx;
    const wantStream = body.stream === true;

    // A deliberately tiny verified fast path keeps the demo reactive without
    // pretending arbitrary language tasks are deterministic. Everything that
    // is not one explicit binary arithmetic expression still goes through the
    // autonomous endpoint crew.
    const fastAnswer =
      ec.mode === "agents" &&
      modelToChannelName(model) === "model-answerer" &&
      process.env.MARINA_MODEL_FAST_PATH !== "false"
        ? tryVerifiedArithmetic(userText)
        : undefined;
    if (fastAnswer) {
      const requestId = `req-${crypto.randomUUID().slice(0, 8)}`;
      const startedAt = Date.now();
      engine.logEvent({
        type: "model_request_lifecycle",
        phase: "received",
        requestId,
        ...requestTrace(requestId),
        model,
        timestamp: startedAt,
      });
      engine.logEvent({
        type: "model_request_lifecycle",
        phase: "fast_path",
        requestId,
        ...requestTrace(requestId),
        model,
        target: "verified-arithmetic",
        timestamp: Date.now(),
      });
      engine.logEvent({
        type: "model_request_lifecycle",
        phase: "completed",
        requestId,
        ...requestTrace(requestId),
        model,
        target: "verified-arithmetic",
        durationMs: Date.now() - startedAt,
        timestamp: Date.now(),
      });
      if (wantStream) return bufferedOpenaiStream(model, fastAnswer, conversationId, requestId);
      return json(openaiCompletion(model, fastAnswer), 200, { "x-request-id": requestId });
    }

    try {
      // Agents mode streams natively (one coordinator, incremental deltas).
      if (wantStream && (ec.mode === "agents" || orchestration)) {
        const {
          stream,
          conversationId: convId,
          requestId,
        } = routeToChannelStreaming(engine, model, userText, "openai", opts);
        const headers: Record<string, string> = {
          ...MODEL_CORS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "x-request-id": requestId,
        };
        if (convId) headers["X-Conversation-Id"] = convId;
        return new Response(stream, { headers });
      }

      let result: RouteResult;
      if (orchestration) {
        result = await routeToChannel(engine, model, userText, opts);
      } else if (ec.mode === "open") {
        result = await routeOpen(engine, model, userText, opts);
      } else if (ec.mode === "panel") {
        result = await routePanel(engine, model, userText, opts, ec.panelSize, ec.panelSynthesis);
      } else {
        result = await routeToChannel(engine, model, userText, opts);
      }

      // open/panel can't stream incrementally — emit the buffered result as SSE.
      if (wantStream) {
        return bufferedOpenaiStream(model, result.content, result.conversationId, result.requestId);
      }

      const extra: Record<string, string> = { "x-request-id": result.requestId };
      if (result.conversationId) extra["X-Conversation-Id"] = result.conversationId;
      if (result.repaired) extra["x-marina-repair"] = result.repaired;
      if (result.budgetForced) extra[BUDGET_FORCED_HEADER] = result.budgetForced.reason;
      if (result.lessons) extra[LESSONS_HEADER] = result.lessons;
      return json(
        openaiCompletion(model, result.content, usageFromTrace(engine, result.requestId)),
        200,
        extra,
      );
    } catch (routeError) {
      // No agent answered (503): fall back to direct upstream proxy when enabled.
      // 404 (unknown model variant) remains an error — caller asked for a specific model.
      if (routeError instanceof HttpError && routeError.status === 503 && ec.fallback) {
        return await proxyToUpstream(
          engine,
          body,
          ec.passthruModel || undefined,
          { routeKind: "fallback" },
          { clientSignal: req.signal },
        );
      }
      throw routeError;
    }
  } catch (e) {
    if (e instanceof HttpError) return errorJson(e.status, e.message);
    return errorJson(500, "Internal error");
  }
}
