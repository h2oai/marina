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
  "analyze",
  "answer",
  "approve",
  "ask",
  "assess",
  "assign",
  "award",
  "bid",
  "build",
  "check",
  "choose",
  "cite",
  "claim",
  "compare",
  "compute",
  "confirm",
  "consider",
  "correct",
  "decide",
  "deliver",
  "deposit",
  "do",
  "double-check",
  "draft",
  "drop",
  "ensure",
  "estimate",
  "evaluate",
  "explain",
  "finalize",
  "find",
  "finish",
  "fix",
  "flag",
  "give",
  "go",
  "graft",
  "handle",
  "hold",
  "include",
  "investigate",
  "judge",
  "keep",
  "let's",
  "let’s",
  "list",
  "look",
  "make",
  "mark",
  "merge",
  "name",
  "pair",
  "pick",
  "post",
  "proceed",
  "propose",
  "provide",
  "rank",
  "re-run",
  "read",
  "recall",
  "recheck",
  "redo",
  "reject",
  "remove",
  "replace",
  "reply",
  "report",
  "rerun",
  "resend",
  "respond",
  "retry",
  "review",
  "revise",
  "rewrite",
  "run",
  "score",
  "select",
  "send",
  "set",
  "share",
  "show",
  "skip",
  "start",
  "stop",
  "submit",
  "summarize",
  "take",
  "tell",
  "test",
  "treat",
  "try",
  "update",
  "use",
  "verify",
  "vote",
  "wait",
  "write",
]);

function opensWithImperative(message: string): boolean {
  for (const sentence of message.split(/[.!;\n]|\s[—–-]\s/)) {
    const segments = sentence.split(":");
    for (let i = 0; i < segments.length; i++) {
      const words = segments[i]!.trim()
        .replace(/^[^a-z]+/i, "")
        .split(/\s+/);
      // A single word before a colon is a label (`estimate: 42`, `vote: A`).
      if (i < segments.length - 1 && words.length === 1) continue;
      const first = words[0]?.toLowerCase();
      if (first && IMPERATIVE_OPENERS.has(first)) return true;
    }
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

// ─── Incoming tells: request or information ─────────────────────────────────

/** Whether an incoming tell asks the recipient for something. */
export type TellIntent = "request" | "information";

/** Phrasing that asks the recipient for a reply or an action. */
const ADDRESSED_ASK =
  /\b(you should|you need to|you must|you have to|you'?ll need to|i'?d like you to|(i )?want you to|awaiting your|waiting for your|need your|(it'?s )?your (turn|call|pick|vote|verdict|judg(e)?ment|estimate|review|input|decision)|requesting|asking you|ask you|over to you)\b/i;

/**
 * Classify an incoming tell (its body, without "X tells you:") as a REQUEST
 * — a reply is owed — or INFORMATION — a result, a statement, a status, a
 * delivery, which is read but owes nothing.
 *
 * Every non-acknowledgement tell used to owe a reply, so a delivered result
 * obliged its recipient (often the lead) to answer, and the answer was a
 * status echo ("Integrated: #241 remains unchanged") that obliged the sender
 * in turn. Conservative by design — when in doubt it is a request, so a real
 * ask is never ignored:
 * - a question mark, request phrasing (please, can you, need you to, your
 *   turn …) or a sentence opening with an imperative verb (send, check, keep
 *   …; a single word before a colon is a label, not an imperative);
 * - a correlation tag (`[re:…]` — a caller is waiting), a `[crew-task]`
 *   dispatch or a model request envelope;
 * - an empty body.
 * A quoted result (backticks, JSON) is information unless one of the above
 * also holds.
 * Everything else is information.
 */
export function classifyIncomingTell(message: string): TellIntent {
  const text = message.trim();
  if (!text) return "request";
  if (text.includes("?")) return "request";
  if (/\[re:[a-z0-9]+\]/i.test(text) || /\[crew-task\]/i.test(text)) return "request";
  if (/model_request/i.test(text)) return "request";
  if (REQUEST_PHRASE.test(text) || ADDRESSED_ASK.test(text)) return "request";
  if (opensWithImperative(text)) return "request";
  return "information";
}

// ─── Status echoes ──────────────────────────────────────────────────────────

/** Longest message still considered a status echo. */
export const STATUS_ECHO_MAX_CHARS = 320;

/** Status openers an echo leads with ("Integrated: …", "Confirmed. …"). */
const ECHO_LEAD =
  /^(?:integrated|confirmed|re-?confirmed|verified|noted|understood|acknowledged|agreed|aligned|ok|okay|all set|got it)\b(?:\s*(?:and|&)\s*(?:integrated|confirmed|verified|noted|acknowledged|understood))?[\s.:,!;—–-]*/i;

/** Words that bring a contrast, a reason or a condition: never an echo. */
const ECHO_BREAKER =
  /\b(but|however|though|although|except|instead|because|since|unless|if|whereas|why|wrong|incorrect|error|fails?|failed|mismatch(es)?|missing|bug|broken|regress(ion|ed)?|correction|corrected|actually|should|must|recommend(s|ed)?|propose[sd]?|suggest(s|ed)?)\b/i;

/** Verbs that, inside a clause's subject, mean the subject is itself news. */
const SUBJECT_VERBS = new Set(
  (
    "is are was were be been being has have had wins win won beats beat loses lost lose " +
    "selects selected select chose choose chosen picks picked pick prefers preferred " +
    "passes passed found finds shows showed returns returned gives gave needs need " +
    "will would could can may might matches match agrees agree disagrees differs " +
    "changes changed replaces replaced supersedes superseded outperforms not no " +
    "said says reports reported got gets made makes added adds"
  ).split(" "),
);

const STATE_WORDS =
  "final|closed|complete|completed|done|unchanged|settled|in place|confirmed|verified|intact|" +
  "valid|deposited|recorded|present|active|pending|separate|resolved|the same|as is|non-final|" +
  "respected|noted|integrated|current|authoritative";
const NO_OBJECT =
  "action|actions|change|changes|deposit|deposits|note|notes|reply|replies|response|duplicate|" +
  "entry|entries|write|writes|contribution|follow-?up|input|work|edit|edits|update|updates|message";
const NO_MODIFIER =
  "further|more|other|additional|competing|duplicate|new|pool|eval-artifacts|second|extra|own|" +
  "separate|final|required|single|exact|crew|artifact|another";
/** A short trailing qualifier: "with #241 as the sole deposit", "on this item". */
const TAIL = "(?:\\s+(?:with|at|as|in|on|for|via|from|by|to)\\s+(?<t>[^,;]{1,48}))?";
/** Who an inaction concerns: "no note from me", "no further work needed on this item". */
const NO_TAIL =
  "(?:\\s+(?:from|by|for|on)\\s+(?:me|you|us|them|it|this(?:\\s+(?:item|task|one))?|that))?";

/** A clause that only restates a state or announces inaction. */
const ECHO_CLAUSES: RegExp[] = [
  // "<item> remains final", "<item> is complete as #247"
  new RegExp(
    `^(?<s>.{1,80}?)\\s+(?:remains?|stays?|stands?|is|are|was|were)\\s+(?:still\\s+|now\\s+|already\\s+)?(?:${STATE_WORDS})${TAIL}$`,
    "i",
  ),
  // "<item> remains the sole T4 deposit", "Answerer is the only depositor"
  /^(?<s>.{1,80}?)\s+(?:remains?|stays?|is|are)\s+(?:still\s+)?(?:the\s+)?(?:sole|only|single|designated)\b(?<t>.{0,50})$/i,
  // "<item> stands", "the pair winners and grafted caveats stand"
  new RegExp(
    `^(?<s>.{1,80}?)\\s+(?:remains?|stands?|stays?|holds?)(?:\\s+(?:unchanged|final|closed|as is|in place|valid))?${TAIL}$`,
    "i",
  ),
  // "tournament complete", "T4 closed"
  /^(?<s>.{1,40}?)\s+(?:complete|completed|closed|final|done|unchanged|settled)$/i,
  // "your draft requires no further action"
  new RegExp(
    `^(?<s>.{1,80}?)\\s+(?:requires?|needs?)\\s+no\\s+(?:(?:${NO_MODIFIER})\\s+)*(?:${NO_OBJECT})${NO_TAIL}$`,
    "i",
  ),
  // "no further action", "no pool deposit needed from you", "No note from me"
  new RegExp(
    `^no\\s+(?:(?:${NO_MODIFIER})\\s+)*(?:${NO_OBJECT})(?:\\s+(?:is\\s+|are\\s+)?(?:needed|required|necessary|planned|pending|warranted))?${NO_TAIL}$`,
    "i",
  ),
  /^nothing\s+(?:further|else|more|new)(?:\s+(?:to add|is needed|needed|from me|pending))?$/i,
  // "I won't add a pool note", "I will make no further deposits", "I made no note"
  /^(?:i|we)(?:'ll|’ll|\s+will|\s+shall)?\s+(?:not|won'?t|won’t|will not|no longer)\b.{0,80}$/i,
  /^(?:i|we)(?:'ll|’ll|\s+will)?\s+(?:make|made|have|had|added|add|filed|posted)\s+no\b.{0,80}$/i,
  /^(?:i|we)\s+(?:abstain|defer|stand by|am standing by|remain on standby)\b.{0,80}$/i,
  // "no deposit from me" is covered above; "standing by"
  /^(?:standing by|no change|unchanged|as is|done|closed|complete)$/i,
  // a restating fragment after a comma: "with #239 as the sole required note"
  /^(?:with|as)\s+(?<t>[^,;]{1,60})$/i,
];

function echoClause(clause: string): boolean {
  return ECHO_CLAUSES.some((re) => {
    const m = re.exec(clause);
    return (
      !!m &&
      !clauseSubjectIsNews(m.groups?.s) &&
      !clauseSubjectIsNews(m.groups?.t) &&
      // a tail carries one qualifier, never a second statement
      !/\band\b/i.test(m.groups?.t ?? "")
    );
  });
}

function clauseSubjectIsNews(subject: string | undefined): boolean {
  if (!subject) return false;
  const words = subject.toLowerCase().trim().split(/\s+/);
  if (words.length > 10) return true;
  return words.some((w) => SUBJECT_VERBS.has(w.replace(/[^a-z'’-]/g, "")));
}

/**
 * Numbers in a message that are not part of a label (`T4`, `C12`): IDs
 * (`#245`), counts and values. Normalized without `#`.
 */
export function numericTokens(text: string): string[] {
  return [...text.matchAll(/(?<![A-Za-z0-9])#?(\d[\d.,]*\d|\d)/g)].map((m) => m[1]!);
}

/**
 * True when `message` is a conservative "status echo": it only restates a
 * peer's item or announces inaction — "Integrated: #241 remains unchanged;
 * I won't add a replacement", "Confirmed: T4 is closed. No note from me",
 * "Answerer remains the sole depositor" — and carries no question, request,
 * correction, reason, decision or new number.
 *
 * Every clause must match a restatement / inaction form; one clause that
 * does not (a result, a selection, a finding) makes the message information.
 * Numbers and IDs are allowed only when already `known` (seen in the agent's
 * recent perceptions or its own earlier messages); with no `known` set any
 * number makes it information.
 */
export function isStatusEcho(message: string, known: ReadonlySet<string> = new Set()): boolean {
  const text = message.trim();
  if (!text || text.length > STATUS_ECHO_MAX_CHARS || text.includes("\n")) return false;
  if (/[?`{}=<>|]/.test(text) || /\[[a-z-]+:/i.test(text) || /\[crew-task\]/i.test(text))
    return false;
  if (REQUEST_PHRASE.test(text) || ADDRESSED_ASK.test(text) || opensWithImperative(text))
    return false;
  if (ECHO_BREAKER.test(text)) return false;
  if (numericTokens(text).some((n) => !known.has(n))) return false;
  const lead = ECHO_LEAD.exec(text);
  const rest = lead ? text.slice(lead[0].length) : text;
  const clauses = rest
    .split(/\s*(?:[.;!]+(?:\s+|$)|,\s+(?:and\s+)?|:\s+|\s[—–-]\s)\s*/)
    .map((c) => c.trim().replace(/[.!]+$/, ""))
    .filter(Boolean);
  if (clauses.length === 0) return !!lead;
  // A clause echoes when it matches whole, or when every "and"-joined part does
  // ("T1 is complete and #239 is the sole note").
  return clauses.every(
    (clause) =>
      echoClause(clause) ||
      (/\s+and\s+/i.test(clause) && clause.split(/\s+and\s+/i).every(echoClause)),
  );
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

/** Tool result when an outgoing status echo is not sent. */
export const STATUS_ECHO_NOT_SENT =
  "not sent: no new information (status echo). Silence is a valid reply.";

/**
 * An outgoing pure acknowledgement (`isPureAcknowledgement`) or status echo
 * (`isStatusEcho`, numbers checked against `knownNumbers`) is not sent: it
 * carries no information, and each one invites the next. Returns the terse
 * refusal (the tool call returns at once; nothing waits), or undefined to
 * send. A message to a target this agent still owes a reply (`owedTargets`,
 * lower-cased tell senders / channel names) always goes through — "Confirmed."
 * can be the answer to "confirm X?". Only REQUESTS are owed replies (an
 * INFORMATION tell is never tracked; see `classifyIncomingTell`), so the
 * exemption covers answers to asks, not replies to delivered results.
 */
export function outgoingAcknowledgementRefusal(
  toolName: string,
  args: Record<string, unknown>,
  owedTargets: ReadonlySet<string> = new Set(),
  knownNumbers: ReadonlySet<string> = new Set(),
): string | undefined {
  const out = outgoingMessage(toolName, args);
  if (!out) return undefined;
  if (owedTargets.has(out.target.toLowerCase())) return undefined;
  if (isPureAcknowledgement(out.message)) return ACK_NOT_SENT;
  if (isStatusEcho(out.message, knownNumbers)) return STATUS_ECHO_NOT_SENT;
  return undefined;
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
