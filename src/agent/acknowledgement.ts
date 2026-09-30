// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-acknowledgement classifier for incoming tells.
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
