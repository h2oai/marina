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
import { lessonsFromWorkMode } from "../../learning/work";
import type { ObligationsMode } from "../../obligations/mode";
import { getEndpointConfig } from "../model/model-endpoint";
import { type InjectionFormat, messageText, type OpenAIMessage } from "../model/passthru-context";
import {
  ARGCHECK_HEADER,
  ARGCHECK_MODEL_PREFIX,
  argcheckRequestMode,
  finishArgcheck,
  prepareArgcheck,
  statedFromLedger,
} from "./argcheck";
import {
  completionAsSse,
  ENSEMBLE_MODEL_PREFIX,
  ensembleSize,
  ensembleTurn,
  parseEnsembleModels,
  runEnsembleTurn,
} from "./ensemble";
import { evalRef, notePassthruRecoveries, passthruLearnOwner } from "./learn";
import {
  finishObligations,
  OBLIGATIONS_HEADER,
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
  passthruEntityId,
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
  unsupportedParam,
} from "./shared";
import {
  FULL_MODEL_PREFIX,
  type PassthruStack,
  resolvePassthruStack,
  STACK_HEADER,
  STACK_MEMBERS,
  type StackMember,
  stackHeaderValue,
  withoutMember,
} from "./stack";
import { explicitUpstreamModel, passthruForceModel, proxyToUpstream } from "./upstream";
import {
  maybeVerifyChat,
  parseVerifyModel,
  VERIFY_MODEL_PREFIX,
  type VerifyDraftInput,
  verifyPin,
  verifyProposer,
} from "./verify";

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
  FULL_MODEL_PREFIX,
] as const;

/** Did the request say `off` (or `false`/`0`) to one instrument's own header? */
function headerSaysOff(req: Request, name: string): boolean {
  const v = req.headers.get(name)?.trim().toLowerCase();
  return v === "off" || v === "false" || v === "0";
}

/** Why `context` / `learn` cannot run for a caller without its own identity. */
const NEEDS_IDENTITY =
  "it needs a distinct identity (a key bound to an entity, or an authorized name-map)";

/**
 * The request as the context rules should read it: an explicit stack that
 * lists `context` (or `full`) turns `X-Marina-Context` on, `none` turns it
 * off; any other explicit list, and the default, leave the caller's own
 * context settings alone.
 */
function contextRequest(req: Request, stack: PassthruStack): Request {
  if (stack.source !== "header" && stack.source !== "prefix") return req;
  const want = stack.members.has("context") ? "on" : stack.members.size === 0 ? "off" : undefined;
  if (!want || req.headers.get("X-Marina-Context")?.trim().toLowerCase() === want) return req;
  const headers = new Headers(req.headers);
  headers.set("X-Marina-Context", want);
  return new Request(req.url, { method: req.method, headers, signal: req.signal });
}

/**
 * The principal this request's work teaches (`passthruLearnOwner`), or an
 * error when an explicitly listed `learn` member cannot run. `ran` is false
 * when the server collects nothing (`MARINA_LESSONS_FROM_WORK=off`).
 */
function learnFor(
  req: Request,
  auth: PassthruAuthResult | undefined,
  stack: PassthruStack,
): { owner?: string; ran: boolean } | { error: string } {
  const owner = passthruLearnOwner(req, auth, stack.members.has("learn"));
  if (stack.members.has("learn")) {
    const reason = !owner
      ? NEEDS_IDENTITY.replace(" or an authorized name-map", "")
      : lessonsFromWorkMode() === "off"
        ? "lessons from work are off on this server (MARINA_LESSONS_FROM_WORK)"
        : undefined;
    if (reason) {
      const error = withoutMember(stack, "learn", reason);
      if (error) return { error };
    }
  }
  return {
    ...(owner ? { owner } : {}),
    ran: !!owner && stack.members.has("learn") && lessonsFromWorkMode() !== "off",
  };
}

/**
 * The ensemble's checker: the passthru pin when one applies, else the verify
 * checker resolution for the first proposer (`MARINA_VERIFY_CHECKER_MODEL`,
 * the earned `verify:checker` slot, else the proposer itself).
 */
function ensembleChecker(engine: Engine, first: string, pin: string): string {
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

/** The members that ran, in declaration order. */
function ranMembers(ran: Partial<Record<StackMember, unknown>>): StackMember[] {
  return STACK_MEMBERS.filter((m) => !!ran[m]);
}

/** The response with the effective stack recorded (nothing added when no stack applied). */
function withStack(resp: Response, stack: PassthruStack, ran: StackMember[]): Response {
  if (stack.source === "none") return resp;
  return withResponseHeader(resp, STACK_HEADER, stackHeaderValue(ran, stack));
}

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

/**
 * The verification formation with the rest of the stack around it: the
 * caller's memory context and the open obligations ride the proposer's
 * trailing note (after the lessons), the caller's own lessons ride with the
 * shared pool, the ledger reads the conversation before the proposer, and
 * the ledger's final-answer check and the argument check read the VERIFIED
 * reply — a nudge re-runs the formation with the note.
 */
async function runVerifyStack(
  engine: Engine,
  req: Request,
  body: Record<string, unknown>,
  messages: OpenAIMessage[],
  authResult: PassthruAuthResult | undefined,
  o: {
    stack: PassthruStack;
    obligationsMode?: ObligationsMode;
    argcheckMode?: ObligationsMode;
    surface: InjectionFormat;
    /** The ensemble drafts verify's first draft: a listed panel, else the
     *  proposer × `MARINA_ENSEMBLE_SIZE`. */
    ensemble?: { listed?: string[]; displayModel?: string };
  },
): Promise<Response> {
  const { stack } = o;
  const pin = verifyPin(engine);
  // A listed panel obeys the same pin and reachability rules as on its own.
  if (o.ensemble?.listed) {
    const setup = ensembleSetup(engine, o.ensemble.listed[0]!, "", pin, o.ensemble.listed);
    if ("error" in setup) return setup.error;
  }
  const prep = await preparePassthru(engine, req, authResult, messages, o.surface);
  if (stack.members.has("context") && !prep.identity?.contextOptIn) {
    const error = withoutMember(stack, "context", NEEDS_IDENTITY);
    if (error) return unsupportedParam(STACK_HEADER, error);
  }
  const learn = learnFor(req, authResult, stack);
  if ("error" in learn) return unsupportedParam(STACK_HEADER, learn.error);
  if (learn.owner) notePassthruRecoveries(engine.db, learn.owner, messages, evalRef(req));
  const lessonOwner =
    authResult && !isInternalCaller(authResult) ? authResult.boundEntityName : undefined;
  // Order: the ensemble drafts and picks (no repair of its own), verify
  // reviews the pick (a revision is one call by the picked draft's proposer),
  // output repair runs once on verify's final; the ledger and the check wrap
  // the whole formation, and their nudge re-runs all of it.
  const ensemble = o.ensemble;
  const draft = ensemble
    ? (d: VerifyDraftInput) =>
        ensembleTurn(engine, {
          body: { ...body, stream: false },
          proposers: ensemble.listed ?? Array.from({ length: ensembleSize() }, () => d.proposer),
          checker: d.checker,
          ...(d.note ? { note: d.note } : {}),
          ...(d.checkerNotes ? { checkerNotes: d.checkerNotes } : {}),
          pin,
          displayModel: ensemble.displayModel ?? String(body.model),
          ...(d.entityId ? { entityId: d.entityId } : {}),
          ...(d.signal ? { signal: d.signal } : {}),
          repair: false,
        })
    : undefined;
  const run = async (note?: string): Promise<Response> =>
    (await maybeVerifyChat(engine, req, body, authResult, {
      ...(joinNotes(prep.addendum, note) ? { note: joinNotes(prep.addendum, note) } : {}),
      ...(lessonOwner ? { lessonOwner } : {}),
      // The checker reviews against the same memory context (distinct identity only).
      ...(prep.identity?.contextOptIn && prep.addendum ? { context: prep.addendum } : {}),
      ...(draft ? { draft } : {}),
      ...(ensemble?.displayModel ? { displayModel: ensemble.displayModel } : {}),
    })) ?? errorJson(400, "Not a marina/verify: model id");
  // The ledger and the check read the request as the proposer would answer it.
  const proposer = verifyProposer(engine, String(body.model));
  const ledgerBody =
    proposer && explicitUpstreamModel(engine, proposer) ? { ...body, model: proposer } : undefined;
  const forceModel = pin;
  const scoped = {
    ...(prep.identity?.entityId ? { entityId: prep.identity.entityId } : {}),
    ...(authResult ? { auth: authResult } : {}),
  };
  const obligations =
    ledgerBody && o.obligationsMode
      ? await prepareObligations(engine, req, ledgerBody, messages, {
          mode: o.obligationsMode,
          forceModel,
          ...scoped,
        })
      : undefined;
  const argcheck = ledgerBody
    ? prepareArgcheck(engine, req, ledgerBody, messages, {
        mode: o.argcheckMode,
        forceModel,
        ...scoped,
        ...(obligations ? { stated: statedFromLedger(obligations.ledger) } : {}),
        ...(learn.owner ? { learnOwner: learn.owner } : {}),
      })
    : undefined;
  let resp = await run(obligations?.note);
  if (obligations && ledgerBody)
    resp = await finishObligations(engine, obligations, ledgerBody, resp, run);
  if (argcheck && ledgerBody)
    resp = await finishArgcheck(argcheck, ledgerBody, resp, (note) =>
      run(joinNotes(obligations?.note, note)),
    );
  if (prep.identity?.contextOptIn)
    void capturePassthruResponse(engine, prep.identity.entityId, messages, resp);
  return withStack(
    resp,
    stack,
    ranMembers({
      lessons: true,
      obligations,
      argcheck,
      verify: true,
      context: prep.identity?.contextOptIn,
      learn: learn.ran,
      ensemble: !!ensemble,
    }),
  );
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

interface EnsembleSetup {
  proposers: string[];
  checker: string;
  forceModel?: string;
}

/**
 * The ensemble's proposers, checker and force model for one request: a listed
 * panel (each id an explicit upstream id; under a passthru pin, the pin only),
 * or the request's model × `MARINA_ENSEMBLE_SIZE` under the request's own
 * force model.
 */
function ensembleSetup(
  engine: Engine,
  model: string,
  forceModel: string,
  pin: string,
  listed: string[] | undefined,
): EnsembleSetup | { error: Response } {
  if (!listed) {
    return {
      proposers: Array.from({ length: ensembleSize() }, () => model),
      checker: ensembleChecker(engine, forceModel || model, pin),
      ...(forceModel ? { forceModel } : {}),
    };
  }
  if (pin) {
    const other = listed.find((id) => id !== pin);
    if (other)
      return {
        error: errorJson(
          403,
          `This endpoint is pinned to "${pin}"; ${ENSEMBLE_MODEL_PREFIX} cannot use "${other}"`,
          { code: "model_not_allowed" },
        ),
      };
    return { proposers: listed, checker: pin, forceModel: pin };
  }
  const unreachable = listed.find((id) => !explicitUpstreamModel(engine, id));
  if (unreachable)
    return {
      error: errorJson(
        400,
        `${ENSEMBLE_MODEL_PREFIX} needs reachable upstream ids; "${unreachable}" is not one`,
        { code: "model_not_found" },
      ),
    };
  return { proposers: listed, checker: ensembleChecker(engine, listed[0]!, pin) };
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
    const lessonsAsked = wantsLessons(req, stripOptInPrefixes(body.model, LESSONS_MODEL_PREFIX));
    const obligationsAsked = obligationsRequestMode(
      req,
      stripOptInPrefixes(body.model, OBLIGATIONS_MODEL_PREFIX),
    );
    const argcheckAsked = argcheckRequestMode(
      req,
      stripOptInPrefixes(body.model, ARGCHECK_MODEL_PREFIX),
    );
    // The instrument stack (`stack.ts`): `x-marina-stack`, `marina/full:`, or
    // the operator default for an identified caller. A per-instrument header
    // still wins for its own instrument (`off` opts out of a default).
    const fullPrefix = String(stripOptInPrefixes(body.model, FULL_MODEL_PREFIX)).startsWith(
      FULL_MODEL_PREFIX,
    );
    const resolved = resolvePassthruStack(
      req,
      authResult,
      fullPrefix,
      () => passthruEntityId(engine, req, authResult) !== undefined,
    );
    if ("error" in resolved) return unsupportedParam(STACK_HEADER, resolved.error);
    const stack = resolved;
    const lessonsOptIn =
      !headerSaysOff(req, LESSONS_HEADER) && (lessonsAsked || stack.members.has("lessons"));
    const obligationsMode =
      obligationsAsked ??
      (stack.members.has("obligations") && !headerSaysOff(req, OBLIGATIONS_HEADER)
        ? "on"
        : undefined);
    const argcheckMode =
      argcheckAsked ??
      (stack.members.has("argcheck") && !headerSaysOff(req, ARGCHECK_HEADER) ? "on" : undefined);
    const bare = stripOptInPrefixes(body.model);
    if (bare !== body.model) body = { ...body, model: bare };
    // `marina/ensemble:<a>,<b>[,…]` (the innermost prefix) or the `ensemble`
    // stack member: N drafts and one checker pick per turn (`ensemble.ts`).
    const listed = parseEnsembleModels(body.model);
    if (listed && "error" in listed) return unsupportedParam("model", listed.error);
    if (listed) body = { ...body, model: listed[0] };
    const ensemble =
      listed || stack.members.has("ensemble") ? { listed: listed ?? undefined } : undefined;
    let model = typeof body.model === "string" ? body.model : "marina";
    // With `verify` too, the ensemble runs first and verify reviews its pick
    // (`runVerifyStack`, `VerifyExtras.draft`).
    if (ensemble && typeof body.n === "number" && body.n > 1)
      return unsupportedParam("n", "The ensemble returns one picked completion per request.");
    const messages = Array.isArray(body.messages) ? (body.messages as OpenAIMessage[]) : [];

    // `verify` in the stack routes the model through the verification
    // formation (`marina/verify:<model>`) when this request can take it.
    if (stack.members.has("verify") && !model.startsWith(VERIFY_MODEL_PREFIX)) {
      const why =
        body.stream === true
          ? "streaming (the formation reviews a complete draft)"
          : typeof body.n === "number" && body.n > 1
            ? "n > 1"
            : !verifyPin(engine) && !explicitUpstreamModel(engine, model)
              ? "the model is not an explicit upstream id"
              : undefined;
      if (why) {
        const error = withoutMember(stack, "verify", why);
        if (error) return unsupportedParam(STACK_HEADER, error);
      } else {
        model = `${VERIFY_MODEL_PREFIX}${model}`;
        body = { ...body, model };
      }
    }

    // `marina/verify:<proposer>[+<checker>]` — the verification formation as a
    // model id (proposer → checker review → bounded revision), tools included,
    // with the rest of the stack around it.
    if (model.startsWith(VERIFY_MODEL_PREFIX)) {
      return runVerifyStack(engine, contextRequest(req, stack), body, messages, authResult, {
        stack,
        ...(obligationsMode ? { obligationsMode } : {}),
        ...(argcheckMode ? { argcheckMode } : {}),
        surface: runOpts?.surface ?? "openai",
        ...(ensemble
          ? {
              ensemble: {
                ...(listed ? { listed, displayModel: String(requestBody.model) } : {}),
              },
            }
          : {}),
      });
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
        contextRequest(req, stack),
        authResult,
        messages,
        runOpts?.surface ?? "openai",
      );
      if (stack.members.has("context") && !shared.identity?.contextOptIn) {
        const error = withoutMember(stack, "context", NEEDS_IDENTITY);
        if (error) return unsupportedParam(STACK_HEADER, error);
      }
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
      // Lessons from work: a bound conversation whose stack includes `learn`
      // (or `x-marina-learn: on`) teaches its owner from its tool recoveries;
      // a measurement run's signals carry its eval ref.
      const learn = learnFor(req, authResult, stack);
      if ("error" in learn) return unsupportedParam(STACK_HEADER, learn.error);
      const learnOwner = learn.owner;
      if (learnOwner) notePassthruRecoveries(engine.db, learnOwner, messages, evalRef(req));
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
      // A request with tools under the ledger or the check depends on their
      // state, so the response cache is not consulted (without tools both are
      // no-ops).
      const instrumented =
        !!ensemble ||
        (!!(obligations || argcheck) && Array.isArray(body.tools) && body.tools.length > 0);
      const cached = instrumented
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
      // The ensemble replaces the single upstream call (every proposer gets
      // the same trailing note); the ledger and the check wrap it the same
      // way, and their nudge re-runs the whole ensemble.
      const pin = verifyPin(engine);
      const ensembleRun = ensemble
        ? ensembleSetup(engine, model, forceModel, pin, ensemble.listed)
        : undefined;
      if (ensembleRun && "error" in ensembleRun) return ensembleRun.error;
      const turnBody = ensembleRun ? { ...body, stream: false } : body;
      const ensembleTurn = (run: EnsembleSetup, note?: string): Promise<Response> => {
        const trailing = joinNotes(prep.addendum, note);
        return runEnsembleTurn(engine, {
          body: turnBody,
          proposers: run.proposers,
          checker: run.checker,
          ...(run.forceModel ? { forceModel: run.forceModel } : {}),
          ...(trailing ? { note: trailing } : {}),
          ...(prep.addendum ? { checkerNotes: prep.addendum } : {}),
          pin,
          displayModel: listed ? String(requestBody.model) : model,
          ...(prep.identity?.entityId ? { entityId: prep.identity.entityId } : {}),
          signal: req.signal,
        });
      };
      const upstream = (trace: Parameters<typeof proxyToUpstream>[3], note?: string) =>
        ensembleRun
          ? ensembleTurn(ensembleRun, note)
          : proxyToUpstream(engine, body, forceModel || undefined, trace, hintsWith(note));
      let resp = await upstream(passthruTraceOptions(prep), obligations?.note);
      if (obligations) {
        const { requestId: _first, ...retryTrace } = passthruTraceOptions(prep);
        resp = await finishObligations(engine, obligations, turnBody, resp, (note) =>
          upstream({ ...retryTrace, routeReason: "obligations:nudge" }, note),
        );
      }
      if (argcheck) {
        const { requestId: _first, ...retryTrace } = passthruTraceOptions(prep);
        resp = await finishArgcheck(argcheck, turnBody, resp, (note) =>
          upstream(
            { ...retryTrace, routeReason: "argcheck:nudge" },
            // The open obligations stay in view next to the check's note.
            joinNotes(obligations?.note, note),
          ),
        );
      }
      // A streaming request gets the picked reply re-emitted as SSE.
      if (ensembleRun && body.stream === true)
        resp = await completionAsSse(
          resp,
          (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true,
        );
      if (prep.identity?.contextOptIn) {
        void capturePassthruResponse(engine, prep.identity.entityId, messages, resp);
        if (!instrumented) passthruCacheStore(engine, prep, body, forceModel, resp);
      }
      const ran = ranMembers({
        lessons,
        obligations,
        argcheck,
        context: prep.identity?.contextOptIn,
        learn: learn.ran,
        ensemble: !!ensembleRun,
      });
      const withLessons = lessons
        ? withResponseHeader(resp, LESSONS_HEADER, lessonsHeaderValue(lessons))
        : resp;
      return withStack(withLessons, stack, ran);
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
    // The ledger and the argument check are passthru instruments; this request
    // routes to Marina's agents, which would ignore them. (Lessons need no
    // refusal here: the agent route recalls them already.) A default stack
    // does not apply here — the agents' own loops carry the instruments — but
    // an explicit one that asks for more than lessons is refused.
    if (listed) {
      return unsupportedParam(
        "model",
        `${ENSEMBLE_MODEL_PREFIX} runs on passthru requests with explicit upstream ids (such as anthropic/<model>); this request routes to Marina's agents.`,
      );
    }
    if (obligationsAsked || argcheckAsked) {
      return unsupportedParam(
        obligationsAsked ? OBLIGATIONS_HEADER : ARGCHECK_HEADER,
        "The obligations ledger and the argument check run only on passthru requests (an explicit upstream id such as anthropic/<model>, the passthru endpoint mode, or an internal caller); this request routes to Marina's agents.",
      );
    }
    if (
      (stack.source === "header" || stack.source === "prefix") &&
      [...stack.members].some((m) => m !== "lessons")
    ) {
      return unsupportedParam(
        STACK_HEADER,
        "The instrument stack runs on passthru requests (an explicit upstream id such as anthropic/<model>, or the passthru endpoint mode); this request routes to Marina's agents, whose own loops carry the instruments. Send x-marina-stack: lessons or none here.",
      );
    }

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
