// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-acknowledgement classifier for incoming and outgoing messages, plus
 * the deterministic courtesy stripper for outgoing ones.
 *
 * Every incoming tell used to be forced to priority 100 with a reply owed, so
 * "thanks" / "acknowledged" / "no further reply needed" created a reply
 * obligation on each side in turn and crews traded acknowledgements for
 * minutes (measured 2026-09: most crew tells were acknowledgements answering
 * acknowledgements). A pure acknowledgement owes nothing: the adapter keeps it
 * visible as low-priority information and does not track it as a request.
 *
 * Conservative by design — anything that could carry work is a request:
 * - short (at most {@link ACK_MAX_CHARS} characters, one line);
 * - no question mark, no code, JSON or correlation tag (`[re:…]` means a
 *   caller is waiting), no `label: value` and no multi-digit number (a
 *   delivered result must keep its priority);
 * - no request phrasing (please, can/could/would you, let me know, …) and no
 *   sentence that opens with an imperative verb (send, check, fix, …);
 * - and it matches the acknowledgement lexicon, or says outright that no
 *   reply is needed.
 */

/** Longest message still treated as a pure acknowledgement. */
export const ACK_MAX_CHARS = 160;

const ACK_LEXICON =
  /\b(thanks|thank you|thx|ty|acknowledged|ack|noted|got it|received|understood|roger|copy that|confirmed|confirming|agreed|aligned|appreciated?|cheers|sounds good|will do|you'?re welcome|welcome|standing by|all good|great|perfect|ok|okay)\b/i;

const NO_REPLY =
  /\bno (further |more )?(reply|response|action|follow-?up)s? (is )?(needed|required|necessary)\b|\bno need to (reply|respond)\b|\bnothing (further|else) (is )?needed\b/i;

const REQUEST_PHRASE =
  /\b(please|pls|can you|could you|would you|will you|can someone|could someone|need you to|i need|let me know|lmk|make sure|be sure to|remember to|don'?t forget|waiting (on|for) you|your turn|when you can|asap)\b/i;

/** Imperative verbs that, opening a sentence, make it an instruction. */
const IMPERATIVE_OPENERS = new Set([
  "add",
  "answer",
  "ask",
  "build",
  "check",
  "claim",
  "compare",
  "compute",
  "confirm",
  "deliver",
  "deposit",
  "do",
  "draft",
  "explain",
  "find",
  "fix",
  "give",
  "list",
  "look",
  "make",
  "pick",
  "post",
  "provide",
  "recall",
  "reply",
  "report",
  "respond",
  "review",
  "revise",
  "run",
  "send",
  "share",
  "start",
  "summarize",
  "take",
  "tell",
  "test",
  "try",
  "update",
  "use",
  "verify",
  "wait",
  "write",
]);

function opensWithImperative(message: string): boolean {
  for (const sentence of message.split(/[.!;:\n]|\s[—–-]\s/)) {
    const first = sentence
      .trim()
      .replace(/^[^a-z]+/i, "")
      .split(/\s+/)[0]
      ?.toLowerCase();
    if (first && IMPERATIVE_OPENERS.has(first)) return true;
  }
  return false;
}

/**
 * True when `message` (the tell's body, without the "X tells you:" prefix)
 * is a pure acknowledgement that owes no reply.
 */
export function isPureAcknowledgement(message: string): boolean {
  const text = message.trim();
  if (!text || text.length > ACK_MAX_CHARS || text.includes("\n")) return false;
  if (/[?`{}]/.test(text) || /\[re:[a-z0-9]+\]/i.test(text)) return false;
  // A labelled value or a number is a result being delivered, not a courtesy.
  if (/:\s*\S/.test(text) || /\d{2,}/.test(text)) return false;
  if (REQUEST_PHRASE.test(text) || opensWithImperative(text)) return false;
  return NO_REPLY.test(text) || ACK_LEXICON.test(text);
}

// ─── Outgoing messages ──────────────────────────────────────────────────────

/** An agent's outgoing private or channel message, as a tool call carries it. */
export interface OutgoingMessage {
  kind: "tell" | "channel";
  /** Tell target or channel name. */
  target: string;
  message: string;
}

const TELL_COMMAND = /^\s*tell\s+(\S+)\s+([\s\S]+)$/i;
const CHANNEL_SEND_COMMAND = /^\s*channel\s+send\s+(\S+)\s+([\s\S]+)$/i;

/** The outgoing message in a command string (`tell <t> …`, `channel send <c> …`). */
export function outgoingFromCommand(command: string): OutgoingMessage | undefined {
  const tell = TELL_COMMAND.exec(command);
  if (tell) return { kind: "tell", target: tell[1]!, message: tell[2]! };
  const send = CHANNEL_SEND_COMMAND.exec(command);
  if (send) return { kind: "channel", target: send[1]!, message: send[2]! };
  return undefined;
}

/**
 * The outgoing message in an agent tool call: `marina_tell`, `marina_channel`
 * `send`, or a `marina_command` `tell` / `channel send`. Undefined otherwise.
 */
export function outgoingMessage(
  toolName: string,
  args: Record<string, unknown>,
): OutgoingMessage | undefined {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  if (toolName === "marina_tell") {
    const target = str(args.target);
    const message = str(args.message);
    return target && message ? { kind: "tell", target, message } : undefined;
  }
  if (toolName === "marina_channel" && args.action === "send") {
    const target = str(args.channel);
    const message = str(args.message);
    return target && message ? { kind: "channel", target, message } : undefined;
  }
  if (toolName === "marina_command" && typeof args.command === "string") {
    return outgoingFromCommand(args.command);
  }
  return undefined;
}

/** Tool result when an outgoing acknowledgement is not sent. */
export const ACK_NOT_SENT = "not sent: acknowledgement (no information). Silence is a valid reply.";

/**
 * An outgoing pure acknowledgement (`isPureAcknowledgement`) is not sent: it
 * carries no information, and each one invites the next. Returns the terse
 * refusal (the tool call returns at once; nothing waits), or undefined to
 * send. A message that answers a reply this agent still owes the target
 * (`owedTargets`, lower-cased tell senders / channel names) always goes
 * through — "Confirmed." can be the answer to "confirm X?".
 */
export function outgoingAcknowledgementRefusal(
  toolName: string,
  args: Record<string, unknown>,
  owedTargets: ReadonlySet<string> = new Set(),
): string | undefined {
  const out = outgoingMessage(toolName, args);
  if (!out) return undefined;
  if (owedTargets.has(out.target.toLowerCase())) return undefined;
  if (!isPureAcknowledgement(out.message)) return undefined;
  return ACK_NOT_SENT;
}

/** Courtesy openers stripped from an otherwise informative message. */
const PLEASANTRY_OPENER =
  /^(?:thanks|thank you|thx|cheers|great|perfect|excellent|awesome|nice|got it|understood|acknowledged|noted|roger|appreciated)(?:\s+(?:so much|again|all|everyone|both))?(?:\s*[.!,;:]+|\s*[—–]|\s+-)\s*/i;

/** Remainders that depend on the opener ("Thanks, but …") keep it. */
const DEPENDENT_REMAINDER = /^(?:but|however|though|although|yet|except|and|so|for|to|that)\b/i;

/** Courtesy closers stripped from the end of an informative message. */
const PLEASANTRY_CLOSER = /(?<=[.!?])\s+(?:thanks(?: again)?|thank you|cheers)[.!]*$/i;

/**
 * Strip courtesy openers ("Thanks — ", "Great, ", "Understood. ") and closers
 * (" Thanks!") from an informative message, deterministically. The rest of the
 * message is untouched. Conservative: only a fixed lexicon followed by
 * punctuation; never when the remainder depends on the opener ("Thanks, but
 * …"), is empty, or would itself be a pure acknowledgement (that one is
 * handled — sent only when owed — whole); approvals that carry a position
 * (`Agreed`, `Confirmed`, `OK`, `Sounds good`) are never stripped; JSON and
 * bracket-tagged bodies pass unchanged.
 */
export function stripPleasantry(message: string): string {
  let text = message.trim();
  if (!text || text.startsWith("{") || text.startsWith("[")) return message;
  for (let i = 0; i < 3; i++) {
    const m = PLEASANTRY_OPENER.exec(text);
    if (!m) break;
    const rest = text.slice(m[0].length);
    if (!/[a-z0-9]/i.test(rest) || DEPENDENT_REMAINDER.test(rest)) break;
    text = rest;
  }
  text = text.replace(PLEASANTRY_CLOSER, "");
  if (text === message.trim()) return message;
  if (!/\w/.test(text) || isPureAcknowledgement(text)) return message;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `stripPleasantry` applied to the body of a `tell` / `channel send` command. */
export function stripCommandPleasantry(command: string): string {
  const out = outgoingFromCommand(command);
  if (!out) return command;
  const stripped = stripPleasantry(out.message);
  if (stripped === out.message) return command;
  return out.kind === "tell"
    ? `tell ${out.target} ${stripped}`
    : `channel send ${out.target} ${stripped}`;
}
