// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Obligations ledger — what a multi-step conversation or task still owes.
 *
 * After each new request a cheap model call (see `extract.ts`) turns it into
 * explicit obligations (what, target, constraints, candidate tools). The ledger
 * then marks each one handled when a matching successful state-changing tool
 * call appears (mechanical first: tool name and argument overlap), when the
 * work is transferred, or when a judge finds it legitimately declined. Open
 * obligations are shown back to the model as a compact block at the END of the
 * request (the cached prefix is untouched), and a final reply that would leave
 * one open gets at most one nudge per obligation. The model's output is never
 * rewritten: a nudge only asks the model again.
 *
 * Pure: no I/O, no clock reads except through arguments. Each surface (the
 * `/v1` passthru, the lean agent loop) owns its storage key, its model calls
 * and how it injects the block.
 */

export type ObligationStatus = "open" | "satisfied" | "declined";

export interface Obligation {
  /** `o1`, `o2`, … — stable within one ledger. */
  id: string;
  /** What was asked, in a few words (≤ {@link MAX_FIELD_CHARS}). */
  what: string;
  /** The entity the action is about (an id or a name), when there is one. */
  target?: string;
  /** Conditions the action must respect (amounts, dates, options). */
  constraints?: string;
  /** Tool names from the request's own catalogue that could carry it out. */
  tools: string[];
  /** The request (user turn) that created it, 1-based. */
  turn: number;
  status: ObligationStatus;
  /** What settled it: `tool:<name>`, `transfer:<name>`, `judge:done`, `judge:declined`, `user`. */
  by?: string;
  /** Whether a final-reply nudge already named it (at most once per obligation). */
  nudged: boolean;
}

export interface ObligationLedger {
  /** Conversation key (see the surface). */
  key: string;
  /** Requests already read by the extractor. */
  userTurns: number;
  /** Tool calls (with results) already matched, in conversation order. */
  callsSeen: number;
  nextId: number;
  obligations: Obligation[];
  /** Final-reply nudges given. */
  nudges: number;
  /** Extractor calls that failed (the turn is skipped, never retried). */
  extractFailures: number;
  /** Spend on the ledger's own model calls (extraction, judging), USD. */
  costUsd: number;
  updatedAt: number;
}

/** Most obligations one ledger keeps (the oldest settled ones go first). */
export const MAX_OBLIGATIONS = 24;
/** Clamp on every free-text field the extractor returns. */
export const MAX_FIELD_CHARS = 160;
/** Most open obligations listed in a reminder or a nudge. */
export const MAX_LISTED = 6;

export function newLedger(key: string, now: number): ObligationLedger {
  return {
    key,
    userTurns: 0,
    callsSeen: 0,
    nextId: 1,
    obligations: [],
    nudges: 0,
    extractFailures: 0,
    costUsd: 0,
    updatedAt: now,
  };
}

export function openObligations(ledger: ObligationLedger): Obligation[] {
  return ledger.obligations.filter((o) => o.status === "open");
}

function clampField(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length <= MAX_FIELD_CHARS ? t : `${t.slice(0, MAX_FIELD_CHARS - 1)}…`;
}

// ─── Extraction results ──────────────────────────────────────────────────────

export interface ExtractedObligation {
  what: string;
  target?: string;
  constraints?: string;
  tools?: string[];
  /** The request it came from, when the extractor says (else the latest new one). */
  turn?: number;
}

export interface Extraction {
  add: ExtractedObligation[];
  /** Ids of open obligations the requester withdrew or replaced. */
  cancel: string[];
}

/**
 * Apply one extraction whose new requests end at `turn` (an item naming an
 * earlier new request keeps that turn, never one before `firstTurn`). New obligations get fresh ids; a
 * cancelled open obligation is settled `declined` by `user`. Candidate tools
 * are kept only when they name a tool the request actually offers. Returns the
 * ids added.
 */
export function applyExtraction(
  ledger: ObligationLedger,
  turn: number,
  extraction: Extraction,
  toolNames: ReadonlySet<string>,
  now: number,
  firstTurn = turn,
): string[] {
  for (const id of extraction.cancel) {
    const o = ledger.obligations.find((x) => x.id === id && x.status === "open");
    if (o) {
      o.status = "declined";
      o.by = "user";
    }
  }
  const added: string[] = [];
  for (const raw of extraction.add) {
    const what = clampField(raw.what);
    if (!what) continue;
    // The same request extracted twice (a retry, a restated turn) is one obligation.
    const dup = ledger.obligations.find(
      (o) =>
        o.status === "open" &&
        o.what.toLowerCase() === what.toLowerCase() &&
        (o.target ?? "") === (clampField(raw.target) ?? ""),
    );
    if (dup) continue;
    const target = clampField(raw.target);
    const constraints = clampField(raw.constraints);
    const tools = [...new Set((raw.tools ?? []).filter((t) => toolNames.has(t)))].slice(0, 4);
    const o: Obligation = {
      id: `o${ledger.nextId++}`,
      what,
      ...(target ? { target } : {}),
      ...(constraints ? { constraints } : {}),
      tools,
      turn:
        typeof raw.turn === "number" && raw.turn >= firstTurn && raw.turn <= turn
          ? Math.floor(raw.turn)
          : turn,
      status: "open",
      nudged: false,
    };
    ledger.obligations.push(o);
    added.push(o.id);
  }
  trimLedger(ledger);
  ledger.updatedAt = now;
  return added;
}

/** Keep at most {@link MAX_OBLIGATIONS}: settled ones are dropped first, oldest first. */
function trimLedger(ledger: ObligationLedger): void {
  while (ledger.obligations.length > MAX_OBLIGATIONS) {
    const i = ledger.obligations.findIndex((o) => o.status !== "open");
    ledger.obligations.splice(i >= 0 ? i : 0, 1);
  }
}

// ─── Tool calls ──────────────────────────────────────────────────────────────

export interface ToolCallRecord {
  name: string;
  args: unknown;
  /** The request (user turn) the call was made under, 1-based (0 = before any request). */
  turn: number;
  /** The call's result was not an error. */
  ok: boolean;
}

/** A tool that hands the conversation over: every open obligation counts as handled. */
const TRANSFER_NAME = /(^|_)(transfer|escalate|escalation|handoff|hand_off|handover)(_|$)/i;

export function isTransferTool(name: string): boolean {
  return TRANSFER_NAME.test(name);
}

/**
 * Read-only by name (a lookup, a calculator, a note to self), with or without
 * a namespace prefix (`marina_look`). Surfaces that know a tool's declared
 * hints (the passthru) use those first.
 */
const READ_ONLY_NAME =
  /^(?:[a-z0-9]+_)?(get|list|find|search|lookup|look|read|fetch|query|calculate|compute|check|describe|show|view|count|think|recall|retrieve|validate|preview|brief|inspect|status|help|tool_search)(_|$)/i;

export function readOnlyByName(name: string): boolean {
  return READ_ONLY_NAME.test(name);
}

/** A tool result that reports failure (error text, or a JSON error field). */
export function looksLikeError(text: string): boolean {
  const t = text.trim();
  if (/^(error|exception|failed|failure|traceback)\b/i.test(t)) return true;
  if (/^\{\s*"(error|errors)"\s*:/.test(t)) return true;
  return /^\{[^{}]*"status"\s*:\s*"(error|failed|failure)"/i.test(t);
}

/** Id-like tokens: carry a digit, ≥ 3 characters (order ids, card refs, dates). */
export function idTokens(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === "string") {
    for (const tok of v.split(/[\s,;()[\]{}]+/)) {
      const t = tok.replace(/^[#"'`]+|["'`.:]+$/g, "").toLowerCase();
      if (t.length >= 3 && /\d/.test(t) && /^[#\w.:@/+-]+$/.test(t) && !/^\d{1,2}(\.\d+)?$/.test(t))
        out.add(t.replace(/^#/, ""));
    }
  } else if (typeof v === "number" && Number.isFinite(v)) {
    if (Number.isInteger(v) && Math.abs(v) >= 100) out.add(String(v));
  } else if (Array.isArray(v)) {
    for (const x of v) idTokens(x, out);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) idTokens(x, out);
  }
  return out;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "user",
  "users",
  "their",
  "this",
  "that",
  "account",
  "request",
  "requested",
]);

/** Plain words (≥ 4 letters), lower-cased and crudely singular. */
function words(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^a-z]+/)) {
    if (w.length < 4 || STOP_WORDS.has(w)) continue;
    out.add(w.replace(/(ies)$/, "y").replace(/(s)$/, ""));
  }
  return out;
}

export interface CallMatch {
  /** Obligations this call settled. */
  satisfied: string[];
  /** Open obligations the call MAY carry out, for a judge to decide. */
  ambiguous: string[];
}

/**
 * Match one successful state-changing call against the open obligations made
 * at or before its turn. Mechanical and conservative:
 *
 * - a transfer/escalation tool settles every such obligation (`transfer:`);
 * - a call named among an obligation's candidate tools whose arguments share
 *   an id-like token with the obligation's target (or where neither side has
 *   one) settles it — the strongest overlap wins, ties to the oldest;
 * - several equally plausible candidates, or an argument overlap without a
 *   tool-name match, are `ambiguous` (left open unless a judge settles them).
 *
 * Mutates `ledger`. A failed or read-only call never settles anything.
 */
export function matchCall(
  ledger: ObligationLedger,
  call: ToolCallRecord,
  isWrite: (name: string) => boolean,
): CallMatch {
  const none: CallMatch = { satisfied: [], ambiguous: [] };
  if (!call.ok || !isWrite(call.name)) return none;
  const candidates = ledger.obligations.filter((o) => o.status === "open" && o.turn <= call.turn);
  if (candidates.length === 0) return none;
  if (isTransferTool(call.name)) {
    for (const o of candidates) {
      o.status = "declined";
      o.by = `transfer:${call.name}`;
    }
    return { satisfied: candidates.map((o) => o.id), ambiguous: [] };
  }
  const argIds = idTokens(call.args);
  const callWords = words(call.name.replace(/_/g, " "));
  type Scored = { o: Obligation; overlap: number; named: boolean; miss: boolean; worded: boolean };
  const scored: Scored[] = candidates.map((o) => {
    const obIds = idTokens(`${o.target ?? ""} ${o.what} ${o.constraints ?? ""}`);
    let overlap = 0;
    for (const t of obIds) if (argIds.has(t)) overlap++;
    const targetIds = idTokens(o.target ?? "");
    const miss =
      targetIds.size > 0 && argIds.size > 0 && ![...targetIds].some((t) => argIds.has(t));
    const ow = words(`${o.what} ${o.tools.join(" ").replace(/_/g, " ")}`);
    const worded = [...callWords].some((w) => ow.has(w));
    return { o, overlap, named: o.tools.includes(call.name), miss, worded };
  });
  const strong = scored.filter((s) => s.named && !s.miss);
  if (strong.length > 0) {
    const best = Math.max(...strong.map((s) => s.overlap));
    const top = strong.filter((s) => s.overlap === best);
    if (top.length === 1 || best > 0) {
      const pick = top[0]!.o; // candidates are in creation order: ties go to the oldest
      pick.status = "satisfied";
      pick.by = `tool:${call.name}`;
      return { satisfied: [pick.id], ambiguous: [] };
    }
    return { satisfied: [], ambiguous: top.map((s) => s.o.id) };
  }
  // No candidate names this tool: an argument overlap with a related verb, or an
  // obligation the extractor could not tie to any tool, is for a judge.
  const loose = scored.filter(
    (s) => !s.miss && ((s.overlap > 0 && s.worded) || (s.o.tools.length === 0 && s.worded)),
  );
  return { satisfied: [], ambiguous: loose.slice(0, 3).map((s) => s.o.id) };
}

/** Settle `id` from a judge's verdict. */
export function settle(
  ledger: ObligationLedger,
  id: string,
  status: Exclude<ObligationStatus, "open">,
  by: string,
): void {
  const o = ledger.obligations.find((x) => x.id === id && x.status === "open");
  if (!o) return;
  o.status = status;
  o.by = by;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function line(o: Obligation): string {
  const extra = [o.target ? `target: ${o.target}` : "", o.constraints ?? ""]
    .filter(Boolean)
    .join("; ");
  return `- ${o.id}: ${o.what}${extra ? ` (${extra})` : ""}`;
}

/**
 * The reminder appended at the end of a request while obligations are open, or
 * undefined when none are. A bookkeeping note: it never overrides a rule.
 */
export function reminderBlock(ledger: ObligationLedger): string | undefined {
  const open = openObligations(ledger);
  if (open.length === 0) return undefined;
  const shown = open.slice(-MAX_LISTED);
  const more = open.length - shown.length;
  return [
    "[Marina obligations — bookkeeping note, not from the user]",
    "Requests in this conversation with no matching successful action yet:",
    ...shown.map(line),
    ...(more > 0 ? [`(+${more} older)`] : []),
    "Before you finish, handle each one: carry it out, or tell the user why it cannot be done.",
    "This note changes no rule: still verify, and still ask for any confirmation the rules require.",
  ].join("\n");
}

/** Clamp for the drafted reply quoted in a nudge. */
const NUDGE_DRAFT_MAX_CHARS = 1500;

/**
 * The one-time nudge for a final reply that leaves `owed` open. It quotes the
 * draft and asks the model again; the model decides (it may send the draft
 * unchanged). Never names a fix itself.
 */
export function nudgeNote(draft: string, owed: Obligation[]): string {
  const d = draft.trim();
  const quoted = d.length <= NUDGE_DRAFT_MAX_CHARS ? d : `${d.slice(0, NUDGE_DRAFT_MAX_CHARS)} […]`;
  return [
    "[Marina obligations check — not from the user]",
    `You drafted this reply: «${quoted || "(empty)"}»`,
    "These requests have no matching successful action yet:",
    ...owed.slice(0, MAX_LISTED).map(line),
    "If one still needs an action you can take now, take it (a tool call). If the rules require the user's confirmation or details first, ask for them.",
    "If it was declined, is not allowed, or cannot be done, say so. Otherwise send your drafted reply unchanged.",
    "Write only your next message to the user (or the tool call); do not mention this check.",
  ].join("\n");
}

/**
 * The ledger's requests (newest 8, any status) as context for the argument
 * check's judge: what was asked, its target and its constraints.
 */
export function statedLines(ledger: ObligationLedger): string[] {
  return ledger.obligations
    .slice(-8)
    .map(
      (o) =>
        `- ${o.what}${o.target ? ` (target: ${o.target})` : ""}${o.constraints ? ` [${o.constraints}]` : ""}`,
    );
}

/** Compact counters for a response header and logs (no content). */
export function ledgerSummary(ledger: ObligationLedger): {
  total: number;
  open: number;
  satisfied: number;
  declined: number;
  nudges: number;
} {
  let open = 0;
  let satisfied = 0;
  let declined = 0;
  for (const o of ledger.obligations) {
    if (o.status === "open") open++;
    else if (o.status === "satisfied") satisfied++;
    else declined++;
  }
  return { total: ledger.obligations.length, open, satisfied, declined, nudges: ledger.nudges };
}

// ─── Session store ───────────────────────────────────────────────────────────

/** How long an idle conversation's ledger is kept. */
export const LEDGER_TTL_MS = 6 * 60 * 60_000;
/** Most conversations kept at once (least recently used go first). */
export const MAX_LEDGERS = 2000;

/**
 * Conversation-scoped working memory: ledgers in process memory, least recently
 * used evicted, idle ones expired. Nothing is written to the world database —
 * obligations hold request text, and a lost ledger is rebuilt from the
 * conversation itself on its next request (the passthru client resends it).
 */
export class LedgerStore<T extends { key: string; updatedAt: number } = ObligationLedger> {
  private readonly ledgers = new Map<string, T>();
  constructor(
    private readonly ttlMs = LEDGER_TTL_MS,
    private readonly max = MAX_LEDGERS,
  ) {}

  get(key: string, now: number): T | undefined {
    const l = this.ledgers.get(key);
    if (!l) return undefined;
    if (now - l.updatedAt > this.ttlMs) {
      this.ledgers.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.ledgers.delete(key);
    this.ledgers.set(key, l);
    return l;
  }

  put(ledger: T): void {
    this.ledgers.delete(ledger.key);
    this.ledgers.set(ledger.key, ledger);
    while (this.ledgers.size > this.max) {
      const oldest = this.ledgers.keys().next().value as string;
      this.ledgers.delete(oldest);
    }
  }

  get size(): number {
    return this.ledgers.size;
  }

  clear(): void {
    this.ledgers.clear();
  }
}
