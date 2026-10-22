// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared attention: what a resident notices, what it owes, and whether a
 * perception wakes it.
 *
 * One decision per perception, the same for every resident: the lean adapter
 * calls {@link assessPerception} from its perception handler, and any other
 * consumer that delivers world perceptions to an agent session can call it
 * too. The module has no I/O and emits nothing. The caller owns the side
 * effects — buffering, request tracking, events, waking the loop, steering a
 * run in flight — and drives them from the returned {@link AttentionDecision}.
 *
 * The rules, in order:
 *  1. the agent's own command echoes are dropped (`isSelfEchoPerception`);
 *     an endpoint `model_request` addressed (`target`) to another member is
 *     dropped, and so is a peer's `model_response` (one member claims each
 *     request; see {@link endpointDispatchDrop});
 *  2. a repeat of recently seen text is dropped unless it is addressed;
 *  3. the social score sets the priority (`SocialAwareness.scorePerception`);
 *     a tell is a REQUEST (100, reply owed), INFORMATION (60, read, owes
 *     nothing) or a pure acknowledgement (≤ 30, owes nothing); a room or
 *     channel post that only acknowledges is capped the same way;
 *  4. untrusted (gateway-relayed) content is clamped below the wake tier and
 *     never owes a reply;
 *  5. the attention mode and threshold decide keep/drop
 *     (`shouldKeepPerception`); acknowledgements and information are always
 *     kept; `open` lifts every kept priority to at least 35;
 *  6. ambient channel chatter inside the reply cooldown is demoted;
 *  7. the owed-reply rule (`MARINA_FORCED_ACTION_NUDGE`) and the wake band.
 */

import { sameResidentName } from "../engine/entity-name";
import { stripAnsi } from "../net/ansi";
import type { Perception } from "../types";
import { classifyIncomingTell, isPureAcknowledgement } from "./acknowledgement";
import { modelEnvelopeOf } from "./outstanding-requests";
import { isAddressedTo, isCrewDispatch, type SocialEvent, withoutVocative } from "./social";

/** Attention modes: `focused` drops what scores below the threshold; `balanced` and `open` keep everything. */
export type AttentionMode = "focused" | "balanced" | "open";

/** Buffer priority of a pure-acknowledgement tell: information, not work. */
export const ACKNOWLEDGEMENT_PRIORITY = 30;

/**
 * Buffer priority of an INFORMATION tell (a result, a statement, a status;
 * see `classifyIncomingTell`): read on the next cycle and kept by every
 * attention mode, but below the request tier (80) — no reply owed, no steer
 * into a run in flight.
 */
export const INFORMATION_TELL_PRIORITY = 60;

/** Buffer priority of a REQUEST tell: directed work, reply owed. */
export const REQUEST_TELL_PRIORITY = 100;

/** Highest priority untrusted (gateway-relayed) content can carry: below the wake tier. */
export const UNTRUSTED_PRIORITY_CAP = 40;

/** Highest priority an ambient channel post inside the reply cooldown keeps. */
export const CHANNEL_COOLDOWN_PRIORITY_CAP = 40;

/** Floor the `open` attention mode lifts every kept perception to. */
export const OPEN_MODE_PRIORITY_FLOOR = 35;

/** Priority at and above which a perception wakes the loop and may steer a run. */
export const WAKE_PRIORITY = 80;

/** A channel post steers a run in flight only at the dispatch tier (crew tasks, model requests). */
export const CHANNEL_STEER_PRIORITY = 90;

/** Priority given to a perception the social model produced no event for. */
export const UNSCORED_PRIORITY = 15;

/** Recently seen perception hashes kept for de-duplication before the set resets. */
export const DEDUPE_WINDOW = 200;

/** Default attention threshold and the range every threshold is held to. */
export const DEFAULT_ATTENTION_THRESHOLD = 50;
export const ATTENTION_THRESHOLD_MIN = 10;
export const ATTENTION_THRESHOLD_MAX = 90;

/** Hold an attention threshold to its range (no rounding). */
export function clampAttentionThreshold(threshold: number): number {
  return Math.max(ATTENTION_THRESHOLD_MIN, Math.min(ATTENTION_THRESHOLD_MAX, threshold));
}

/** Per-perception hot path — read the env once, not on every channel message. */
export const CHANNEL_REPLY_COOLDOWN_MS =
  Number(process.env.AGENT_CHANNEL_REPLY_COOLDOWN_MS) || 30_000;

/**
 * `MARINA_FORCED_ACTION_NUDGE`: what makes a prompt "actionable" — the state
 * that drives the forced-action nudge (§11), the in-run silent recovery, the
 * declared-rest exemption and reply-ledger tracking.
 *
 * - `requests` (default): only a perception that owes a reply — a REQUEST
 *   tell, an addressed post whose body is a request (`classifyIncomingTell`),
 *   or a request already in the ledger. Addressed INFORMATION still wakes the
 *   loop and renders as `[!]`; it never forces a tool call.
 * - `all`: any first-party perception that should be answered or scored ≥ 80
 *   (the earlier default: every addressed status post became a reply debt,
 *   so two agents naming each other answered each other indefinitely).
 */
export function forcedActionNudgeMode(
  env: Record<string, string | undefined> = process.env,
): "all" | "requests" {
  return env.MARINA_FORCED_ACTION_NUDGE?.trim().toLowerCase() === "all" ? "all" : "requests";
}

/** The attention-mode keep rule: anything owed is kept; `focused` keeps only what meets the threshold. */
export function shouldKeepPerception(
  mode: AttentionMode,
  priority: number,
  shouldRespond: boolean,
  threshold = DEFAULT_ATTENTION_THRESHOLD,
): boolean {
  if (shouldRespond) return true;
  if (mode !== "focused") return true;
  return priority >= threshold;
}

/**
 * Self-echo rule (2026-09-22). The world answers every command an agent runs
 * with a `message` perception addressed back to the same agent. Two families
 * of those replies carry nothing the agent did not just do itself and, before
 * this rule, made up most of `[World Events]` (89 % of continuation prompts hit
 * the event-level re-queue, driven by the continuity journal's own
 * `memory api capture` / `save_checkpoint` acknowledgements):
 *
 *  (a) durable memory-service acknowledgements — `data.memory_service` (the
 *      `memory api …` reply envelope the journal, archive and checkpoint paths
 *      correlate on) and the legacy memory command payload
 *      `data.memory.schema === "marina.memory.command.v1"` (`note` / `recall` /
 *      `pool` replies, already returned to the tool call that issued them);
 *  (b) the agent's own send receipts — `You tell <name>: …` / `You say: …` /
 *      `You shout: …` echoes and the duplicate-suppressed tell receipt;
 *  (c) any non-tell perception tagged with the agent's own
 *      `command_request_id` (the correlated command's output).
 *
 * Everything addressed to the agent by someone else (`<name> tells you`,
 * channel messages, broadcasts, endpoint requests) is untouched. The tool
 * result path is separate (`MarinaClient.command` drains its own buffer), so
 * dropping these from the perception BUFFER loses no information.
 * `MARINA_PERCEIVE_SELF_ECHO=on` restores the old behaviour.
 */
export function isSelfEchoPerception(p: Perception, text: string): boolean {
  // (c) Output correlated to the agent's own command (`command_request_id`)
  // already reached that command's tool result; a tell is never one.
  if (p.command_request_id && p.tag !== "tell") return true;
  if (p.kind !== "message") return false;
  const data = (p.data ?? {}) as Record<string, unknown>;
  if (data.memory_service !== undefined) return true;
  const memory = data.memory;
  if (
    memory &&
    typeof memory === "object" &&
    (memory as { schema?: unknown }).schema === "marina.memory.command.v1"
  )
    return true;
  // Command echoes are ANSI-coloured; strip before matching the prefix.
  const plain = stripAnsi(text).replace(/^>\s*/, "").trimStart();
  if (/^You (tell \S[^:]*|say|shout): /.test(plain)) return true;
  if (/^Duplicate suppressed; existing message #\d+/.test(plain)) return true;
  return false;
}

/** A tellAndAwait correlation tag (`[re:<6 base-36 chars>]`) on an incoming tell. */
export const CORRELATION_TAG_RE = /\[re:([a-z0-9]{4,16})\]/;

/** Messages the channel-reply cooldown and the crew-responder idle skip must
 *  never demote: a correlated ask, a name-addressed message, a crew-channel
 *  post, or a crew dispatch. A coordinator asking twice inside 30 s is not
 *  ambient chatter. */
export function isAddressedOrCrewMessage(
  event: { channel?: string; message?: string; crewDispatch?: boolean } | undefined,
  text: string,
  name: string,
): boolean {
  const body = event?.message ?? text;
  if (CORRELATION_TAG_RE.test(body) || CORRELATION_TAG_RE.test(text)) return true;
  if (name && isAddressedTo(body, name)) return true;
  if (event?.channel?.startsWith("marina:")) return true;
  return !!event && isCrewDispatch({ message: body, crewDispatch: event.crewDispatch });
}

/**
 * An outgoing tell that only acknowledges a peer whose own latest tell was a
 * pure acknowledgement is not sent: neither side owes a reply, and each
 * acknowledgement would otherwise invite the next. Returns the refusal
 * reason, or undefined to let the tell through. `marina_tell` and a
 * `marina_command` `tell <target> <message>` are both covered.
 */
export function acknowledgementReplyRefusal(
  toolName: string,
  args: Record<string, unknown>,
  peersWhoAcknowledged: ReadonlySet<string>,
): string | undefined {
  let target: string | undefined;
  let message: string | undefined;
  if (toolName === "marina_tell") {
    target = typeof args.target === "string" ? args.target : undefined;
    message = typeof args.message === "string" ? args.message : undefined;
  } else if (toolName === "marina_command" && typeof args.command === "string") {
    const match = /^\s*tell\s+(\S+)\s+([\s\S]+)$/i.exec(args.command);
    target = match?.[1];
    message = match?.[2];
  }
  if (!target || !message) return undefined;
  if (!peersWhoAcknowledged.has(target.toLowerCase())) return undefined;
  if (!isPureAcknowledgement(message)) return undefined;
  return `not sent: acknowledgement; ${target}'s last message was one (no reply owed).`;
}

/** Suffix marking a buffered tell that owes no reply. */
export function noReplyMarker(acknowledgement: boolean, information: boolean): string {
  if (acknowledgement) return " (ack; no reply owed)";
  return information ? " (info; no reply owed)" : "";
}

// ─── The decision ───────────────────────────────────────────────────────────

/** A resident's attention settings. */
export interface AttentionConfig {
  mode: AttentionMode;
  threshold: number;
  /** Ambient channel replies closer together than this are demoted (default {@link CHANNEL_REPLY_COOLDOWN_MS}). */
  channelReplyCooldownMs?: number;
}

/**
 * The small amount of memory attention keeps between perceptions, owned by
 * the caller (one per resident) and updated in place by {@link assessPerception}.
 */
export interface AttentionState {
  /** Hashes of recently seen perception text (de-duplication). */
  recentHashes: Set<string>;
  /** Lower-cased peers whose latest tell was a pure acknowledgement. */
  peersWhoAcknowledged: Set<string>;
  /** When this resident last took an ambient channel post as one to answer (ms). */
  lastChannelResponseAt: number;
}

export function createAttentionState(): AttentionState {
  return { recentHashes: new Set(), peersWhoAcknowledged: new Set(), lastChannelResponseAt: 0 };
}

/** The social model's scoring of an event: `SocialAwareness` satisfies it. */
export interface AttentionScorer {
  scorePerception(event: SocialEvent, myName: string): number;
  shouldRespond(event: SocialEvent, myName: string): boolean;
}

export interface AttentionInput {
  perception: Perception;
  /** The perception as one display line (ANSI stripped, peer line breaks flattened). */
  text: string;
  /** The resident's own name. */
  selfName: string;
  /** Social events the perception produced (`SocialAwareness.handlePerception`). */
  events: readonly SocialEvent[];
  scorer: AttentionScorer;
  /** `MARINA_PERCEIVE_SELF_ECHO=on`: keep the resident's own command echoes. */
  perceiveSelfEcho?: boolean;
  /** Owed-reply rule; defaults to {@link forcedActionNudgeMode}. */
  nudgeMode?: "all" | "requests";
  /** Clock for the channel-reply cooldown (ms); defaults to `Date.now()`. */
  now?: () => number;
  /**
   * The resident's own entity id. With it, an endpoint `model_request`
   * addressed to another member is not this resident's to answer.
   */
  selfId?: string;
  /** The endpoint request ids this resident still owes a reply to. */
  owedModelRequests?: ReadonlySet<string>;
}

/**
 * When a perception should reach the resident:
 * - `now`: wake the loop now; with a run in flight and `steer`, interrupt it;
 * - `next`: no wake; read on the next cycle;
 * - `context`: no wake and nothing owed (an acknowledgement or untrusted
 *   content); read on the next cycle as context only;
 * - `drop`: never delivered.
 */
export type WakeBand = "now" | "next" | "context" | "drop";

export type AttentionReason =
  | "self-echo"
  | "duplicate"
  | "addressed-elsewhere"
  | "answered-elsewhere"
  | "below-threshold"
  | "untrusted"
  | "acknowledgement"
  | "information"
  | "request"
  | "addressed"
  | "ambient";

export interface AttentionDecision {
  keep: boolean;
  reason: AttentionReason;
  /**
   * An endpoint request id this resident no longer owes: it was re-offered to
   * another member, or another member answered it. The caller drops it from
   * its reply ledger.
   */
  release?: string;
  wake: WakeBand;
  /** Buffer priority (meaningful only when kept). */
  priority: number;
  /** Rendered `[!]`: the resident should answer it. */
  shouldRespond: boolean;
  /** A reply is owed (tracked as an outstanding request when trusted). */
  owed: boolean;
  /** May interrupt a run in flight (meaningful only with `wake: "now"`). */
  steer: boolean;
  acknowledgement: boolean;
  information: boolean;
  untrusted: boolean;
  /** The text the request is read from (`data.message`, else the display line). */
  requestBody: string;
  /** Suffix for the buffered line ({@link noReplyMarker}). */
  marker: string;
  /** The social event that scored it, when there was one. */
  event?: SocialEvent;
}

function dropped(
  reason:
    | "self-echo"
    | "duplicate"
    | "below-threshold"
    | "addressed-elsewhere"
    | "answered-elsewhere",
  priority: number,
): AttentionDecision {
  return {
    keep: false,
    reason,
    wake: "drop",
    priority,
    shouldRespond: false,
    owed: false,
    steer: false,
    acknowledgement: false,
    information: false,
    untrusted: false,
    requestBody: "",
    marker: "",
  };
}

/** Whether a perception is addressed enough that a repeat of its text still counts. */
function addressedForDedupe(input: AttentionInput, event: SocialEvent | undefined): boolean {
  const { perception: p, text } = input;
  return !!(
    p.tag === "tell" ||
    p.data.to ||
    isAddressedOrCrewMessage(event, text, input.selfName) ||
    text.includes('"type":"model_request"')
  );
}

/**
 * Endpoint dispatch on a `model-<name>` channel. The model API addresses each
 * `model_request` to ONE member (`target`, its entity id) and posts it on the
 * channel, so every member perceives it. Only the addressee owes the reply:
 * for the others it is dropped, not owed and no wake, the rule the SDK
 * provider has always applied. A request without a `target` stays everyone's
 * (unchanged). A re-offer of a request this resident held, now addressed to
 * someone else (its claim lapsed, `request-claim.ts`), releases it. A peer's
 * `model_response` for a request is the caller's, not this resident's: it is
 * dropped too, and releases the request when this resident still owed it.
 * Undefined: not an endpoint envelope, or this resident's to handle.
 */
function endpointDispatchDrop(input: AttentionInput): AttentionDecision | undefined {
  const { perception: p, selfName } = input;
  if (p.kind !== "message" || typeof p.data?.channel !== "string") return undefined;
  const envelope = modelEnvelopeOf(p);
  if (!envelope) return undefined;
  const owed = input.owedModelRequests?.has(envelope.id) ?? false;
  const release = owed ? { release: envelope.id } : {};
  if (envelope.type === "model_request") {
    const target = envelope.target;
    if (!target || !input.selfId) return undefined;
    if (target === input.selfId || sameResidentName(target, selfName)) return undefined;
    return { ...dropped("addressed-elsewhere", 0), ...release };
  }
  if (envelope.type === "model_response" || envelope.type === "model_response_end") {
    const sender = typeof p.data.senderName === "string" ? p.data.senderName : p.data.from;
    // The channel names the sender by its entity name ("Answerer2"), the
    // resident knows its config name ("Answerer-2"): compare them normalised.
    if (typeof sender !== "string" || sameResidentName(sender, selfName)) return undefined;
    return { ...dropped("answered-elsewhere", 0), ...release };
  }
  return undefined;
}

/**
 * Decide what to do with one perception. Updates `state` (de-duplication,
 * acknowledging peers, the channel cooldown) exactly as the lean adapter
 * always has, and returns the decision; it performs no other side effect.
 */
export function assessPerception(
  input: AttentionInput,
  config: AttentionConfig,
  state: AttentionState,
): AttentionDecision {
  const { perception: p, text, selfName } = input;
  // 1. Self-echo — the resident's own memory-service acknowledgements and send receipts.
  if (!input.perceiveSelfEcho && isSelfEchoPerception(p, text)) return dropped("self-echo", 0);
  const elsewhere = endpointDispatchDrop(input);
  if (elsewhere) return elsewhere;

  // 2. Dedupe — skip identical text seen recently; addressed requests never disappear for repeating.
  const event = input.events[input.events.length - 1];
  const hash = Bun.hash(text).toString();
  if (!addressedForDedupe(input, event) && state.recentHashes.has(hash))
    return dropped("duplicate", 0);
  state.recentHashes.add(hash);
  if (state.recentHashes.size > DEDUPE_WINDOW) state.recentHashes.clear();

  // 3. Score. An arrival is a perception, not a request: a guide sees it and
  // may greet, but owes nothing (a forced reply per visitor).
  let priority = event ? input.scorer.scorePerception(event, selfName) : UNSCORED_PRIORITY;
  let respond =
    priority >= WAKE_PRIORITY || (event ? input.scorer.shouldRespond(event, selfName) : false);
  // A tell is directed work (priority 100, reply owed) — unless it is a pure
  // acknowledgement ("thanks", "noted", "no reply needed"), which owes
  // nothing. Forcing a reply to those made each side of a conversation owe
  // the other one in turn. The acknowledgement stays visible as low-priority
  // information: never dropped by the attention filter, never tracked as a
  // request, never a wake.
  //
  // Of the rest, only a REQUEST (a question, an ask, an imperative, a
  // correlation tag, a dispatch, a model request) owes a reply. INFORMATION —
  // a delivered result, a statement, a status — is read, wakes the loop and
  // passes the attention filter, but owes nothing: forcing a reply to it made
  // the recipient answer every result with a status echo, which owed the
  // sender in turn.
  let acknowledgement = false;
  let information = false;
  if (p.tag === "tell" && typeof p.data.senderName === "string") {
    const body =
      typeof p.data.message === "string"
        ? p.data.message
        : text.replace(/^[\s\S]*?\btells you:\s*/, "");
    acknowledgement = isPureAcknowledgement(body);
    const sender = p.data.senderName.toLowerCase();
    if (acknowledgement) {
      state.peersWhoAcknowledged.add(sender);
      priority = Math.min(priority, ACKNOWLEDGEMENT_PRIORITY);
      respond = false;
    } else if (classifyIncomingTell(body) === "information") {
      state.peersWhoAcknowledged.delete(sender);
      information = true;
      priority = INFORMATION_TELL_PRIORITY;
      respond = false;
    } else {
      state.peersWhoAcknowledged.delete(sender);
      priority = REQUEST_TELL_PRIORITY;
      respond = true;
    }
  } else if (
    p.kind === "message" &&
    typeof p.data.message === "string" &&
    isPureAcknowledgement(withoutVocative(p.data.message, selfName))
  ) {
    // The same rule on a room or channel post: "thanks, no reply needed"
    // addressed to this agent owes nothing.
    acknowledgement = true;
    priority = Math.min(priority, ACKNOWLEDGEMENT_PRIORITY);
    respond = false;
  }

  // 4. Gateway/cross-instance relayed content is untrusted. It stays VISIBLE
  // (federation is a feature) but must never drive auto-action: force it off
  // the high-priority path (no steer interrupt, no fast-tick, no
  // crew-responder wake, no "respond now" social signal). It informs; it
  // never commands.
  const untrusted = p.data?.untrusted === true;
  if (untrusted) {
    respond = false;
    priority = Math.min(priority, UNTRUSTED_PRIORITY_CAP);
  }

  // 5. Attention mode and threshold.
  if (
    !acknowledgement &&
    !information &&
    !shouldKeepPerception(config.mode, priority, respond, config.threshold)
  ) {
    return dropped("below-threshold", priority);
  }
  if (config.mode === "open") priority = Math.max(priority, OPEN_MODE_PRIORITY_FLOOR);

  // 6. Ambient channel chatter inside the reply cooldown is demoted.
  if (
    event?.type === "channel_message" &&
    event.speaker &&
    priority < CHANNEL_STEER_PRIORITY &&
    !isAddressedOrCrewMessage(event, text, selfName)
  ) {
    const now = input.now ?? Date.now;
    const cooldownMs = config.channelReplyCooldownMs ?? CHANNEL_REPLY_COOLDOWN_MS;
    if (now() - state.lastChannelResponseAt < cooldownMs) {
      priority = Math.min(priority, CHANNEL_COOLDOWN_PRIORITY_CAP);
      respond = false;
    } else if (respond) {
      state.lastChannelResponseAt = now();
    }
  }

  // 7. Owed reply. Under `requests` only a REQUEST owes one: a tell already
  // classified above, otherwise an addressed post whose body classifies as a
  // request. An INFORMATION post that scored high (a crew update naming this
  // agent) stays a wake and a [!] line, but is neither owed nor nudged.
  const requestBody = typeof p.data?.message === "string" ? p.data.message : text;
  const nudgeMode = input.nudgeMode ?? forcedActionNudgeMode();
  const owed =
    nudgeMode === "requests"
      ? respond &&
        (p.tag === "tell" ||
          (!isPureAcknowledgement(requestBody) && classifyIncomingTell(requestBody) === "request"))
      : respond || priority >= WAKE_PRIORITY;

  // Wake band. Ambient connects, movement and channel chatter wait for the
  // next reflective cycle instead of each purchasing a model turn; addressed
  // messages, endpoint requests and first-party information wake now. A
  // channel post interrupts a run only at the dispatch tier.
  const wakesNow = respond || priority >= WAKE_PRIORITY || (information && !untrusted);
  const wake: WakeBand = wakesNow ? "now" : acknowledgement || untrusted ? "context" : "next";
  const steerFloor = event?.type === "channel_message" ? CHANNEL_STEER_PRIORITY : WAKE_PRIORITY;

  return {
    keep: true,
    reason: untrusted
      ? "untrusted"
      : acknowledgement
        ? "acknowledgement"
        : information
          ? "information"
          : owed
            ? "request"
            : respond
              ? "addressed"
              : "ambient",
    wake,
    priority,
    shouldRespond: respond,
    owed,
    steer: priority >= steerFloor,
    acknowledgement,
    information,
    untrusted,
    requestBody,
    marker: noReplyMarker(acknowledgement, information),
    ...(event ? { event } : {}),
  };
}
