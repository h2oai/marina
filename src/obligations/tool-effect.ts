// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Can a tool change state? One classifier for every surface that needs to
 * know: the obligations ledger (which calls carry a request out, which tools
 * the extractor lists as state-changing), the argument check, and the
 * passthru verifier's write-action guard. It reads, in order:
 *
 * 1. **Declared hints** (MCP `annotations`, at the top level or under
 *    `function`): `readOnlyHint: true` is read-only; `readOnlyHint: false` or
 *    `destructiveHint: true` is a write. A declaration always wins.
 * 2. **A write verb** leading the name (`update_`, `cancel_`, `transfer_`, …)
 *    or the description ("Change the email…", "Submits a report…") is a
 *    write, even when the other one reads like a lookup.
 * 3. **A read verb** leading the name (`get_`, `list_`, `search_`, `find_`,
 *    `lookup_`, `read_`, `check_`, `view_`, `describe_`, …) is read-only. The
 *    verb may follow up to two namespace words (`KB_search_bm25`,
 *    `mcp__docs__get_page`, `marina_look`) and camelCase counts (`getUser`).
 * 4. **A read verb leading the description** ("Search the knowledge base…",
 *    "Returns the…") is read-only when no write word appears anywhere in it.
 * 5. **An ambiguous verb** (`unlock`, `give`, `grant`, `open`, `load`, `run`,
 *    `execute`, `call`, `request`, …) is decided by the description: it is
 *    read-only when the description says the tool gives access to, or
 *    reveals, something (`access`, `reveal`, `expose`, `make available`) and
 *    names no write word and no user-owned state (`user`, `customer`,
 *    `account`, `card`, `order`, `booking`, …). "Unlock a tool you have
 *    access to" is a read; "unlock the user's card" stays a write.
 *
 * Everything else is a write, with one exception that depends on the role:
 *
 * - **`guard`** (argument check, write-action guard — the default): stops
 *   here. A tool these rules cannot place is a write: missing a real write
 *   would skip its check or let a revision rewrite it, while a lookup counted
 *   as a write only costs a free mechanical pass (free-text and program
 *   arguments are not checked values).
 * - **`track`** (obligations ledger) also accepts weaker read evidence: the
 *   description's read words (`search`, `explore`, `look up`, `list`, …)
 *   outnumber its write words, or — with no word either way — the tool's only
 *   parameter is a free-text search (`query`, `q`, `search`, `question`, …;
 *   numeric limits like `k`/`limit` aside). In the ledger a lookup counted as
 *   a write is the costly mistake: the extractor offers it as a way to carry
 *   a request out, and its calls settle or open judge calls on obligations
 *   they never fulfilled. A single `command`/`cmd`/`script`/`sql` parameter
 *   is NOT read evidence in either role — a command line can do anything; only
 *   the description can say the tool explores rather than changes.
 *
 * Words come from the tool's own name, description and schema — never from a
 * list of product-specific tool names.
 */

/** Which caller asks; decides the weak-evidence rule (see the module doc). */
export type ToolEffectRole = "guard" | "track";

/** What decided a classification (tests, logs). */
export type ToolEffectBasis = "declared" | "name" | "description" | "access" | "weak" | "default";

export interface ToolEffect {
  readOnly: boolean;
  basis: ToolEffectBasis;
}

export type ToolDecl = {
  name?: unknown;
  description?: unknown;
  function?: {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
    annotations?: Hints;
  };
  parameters?: unknown;
  input_schema?: unknown;
  inputSchema?: unknown;
  annotations?: Hints;
};

type Hints = { readOnlyHint?: unknown; destructiveHint?: unknown };

/** The declaration of `name` among OpenAI-, Anthropic-, MCP- or pi-shaped tool lists. */
export function declOf(name: string, tools: readonly unknown[] | undefined): ToolDecl | undefined {
  for (const t of tools ?? []) {
    const d = t as ToolDecl | null;
    if (!d || typeof d !== "object") continue;
    if (d.function?.name === name || d.name === name) return d;
  }
  return undefined;
}

/** A declaration's parameter properties (undefined when it declares none). */
export function declaredProperties(d: ToolDecl | undefined): Record<string, unknown> | undefined {
  const schema = (d?.function?.parameters ?? d?.parameters ?? d?.input_schema ?? d?.inputSchema) as
    | { properties?: unknown }
    | undefined;
  const p = schema?.properties;
  return p && typeof p === "object" && !Array.isArray(p)
    ? (p as Record<string, unknown>)
    : undefined;
}

// ─── Vocabularies ────────────────────────────────────────────────────────────

const READ_VERBS = new Set([
  "get",
  "list",
  "find",
  "search",
  "lookup",
  "look",
  "read",
  "fetch",
  "query",
  "calculate",
  "compute",
  "estimate",
  "check",
  "describe",
  "show",
  "view",
  "count",
  "think",
  "recall",
  "retrieve",
  "validate",
  "preview",
  "brief",
  "inspect",
  "status",
  "help",
  "browse",
  "explore",
  "is",
  "has",
]);

const WRITE_VERBS = new Set([
  "update",
  "set",
  "create",
  "add",
  "delete",
  "remove",
  "cancel",
  "modify",
  "change",
  "edit",
  "transfer",
  "submit",
  "apply",
  "book",
  "pay",
  "refund",
  "send",
  "post",
  "put",
  "patch",
  "insert",
  "write",
  "save",
  "file",
  "close",
  "reset",
  "exchange",
  "return",
  "issue",
  "assign",
  "approve",
  "reject",
  "revoke",
  "register",
  "enroll",
  "upload",
  "move",
  "rename",
  "publish",
  "schedule",
  "reserve",
  "purchase",
  "buy",
  "sell",
  "mark",
  "toggle",
  "activate",
  "deactivate",
  "enable",
  "disable",
  "block",
  "unblock",
  "freeze",
  "unfreeze",
  "lock",
  "suspend",
  "terminate",
  "log",
  "record",
  "store",
  "commit",
  "push",
  "deploy",
  "install",
  "kill",
  "stop",
  "start",
  "restart",
  "dispute",
  "report",
  "claim",
  "redeem",
  "credit",
  "debit",
  "charge",
  "withdraw",
  "deposit",
  "link",
  "unlink",
  "confirm",
  "accept",
  "decline",
  "escalate",
  "notify",
  "reply",
  "invite",
  "share",
  "upgrade",
  "downgrade",
  "replace",
  "clear",
  "archive",
  "restore",
  "mutate",
  "overwrite",
  "merge",
  "attach",
  "detach",
  "subscribe",
  "unsubscribe",
  "perform",
]);

/** Verbs that may or may not change state: the description decides. */
const AMBIGUOUS_VERBS = new Set([
  "unlock",
  "give",
  "grant",
  "open",
  "load",
  "run",
  "execute",
  "exec",
  "call",
  "invoke",
  "use",
  "request",
  "verify",
  "access",
  "process",
  "generate",
  "handle",
  "manage",
  "trigger",
  "pass",
  "do",
]);

/** Description words that mean a change (any inflection). */
const WRITE_WORDS =
  /\b(?:updat|modif|chang|creat|delet|remov|cancel|transfer|submit|appl(?:y|ies|ied|ying)\b|refund|charg|pay(?:s|ing|ment)?\b|purchas|persist|sav(?:e|es|ed|ing)\b|perform|writ(?:e|es|ing)\b|insert|send|reset|enabl|disabl|approv|reject|edit|mutat|overwrit|register|enrol|deposit|withdraw|disput|activat|deactivat|revok)/gi;
/** Description words that mean a lookup (any inflection). */
const READ_WORDS =
  /\b(?:search|look(?:s|ing)? up|lookup|read(?:s|ing)?\b|list(?:s|ing)?\b|quer(?:y|ies|ying)\b|retriev|fetch|explor|brows|inspect|find(?:s|ing)?\b|view(?:s|ing)?\b|display)/gi;
/** Description words that say the tool gives access to, or reveals, something. */
const ACCESS_WORDS = /\b(?:access|reveal|expos(?:e|es|ing)\b|make[s]? (?:it )?available)/i;
/** Description words naming state a user owns (an action on it is a change). */
const USER_STATE_WORDS =
  /\b(?:user|users|user's|customer|customers|customer's|client|member|account|accounts|card|cards|order|orders|booking|bookings|reservation|reservations|subscription|password|profile|balance)\b/i;

/** Free-text search parameters (track role only: a lone one is read evidence). */
const SEARCH_PARAM = /^(?:query|q|search|search_query|search_term|question|keywords?|terms?)$/i;
/** Parameters that only shape a search's output. */
const TUNING_PARAM =
  /^(?:k|n|top_k|topk|limit|max_results|num_results|count|page|page_size|offset|cursor)$/i;

// ─── Name and description reading ────────────────────────────────────────────

type VerbClass = "read" | "write" | "ambiguous";

function verbClass(word: string): VerbClass | undefined {
  if (WRITE_VERBS.has(word)) return "write";
  if (READ_VERBS.has(word)) return "read";
  if (AMBIGUOUS_VERBS.has(word)) return "ambiguous";
  return undefined;
}

/** A name's words: split at `_`, `-`, `.`, `/`, `:` and camelCase, lower-cased. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Read words that are verbs only in a name's first two words (`status`, `marina_brief`). */
const LEADING_ONLY = new Set(["status", "help", "brief", "is", "has"]);

/** The class of the first verb among a name's first three words. */
function nameVerb(name: string): VerbClass | undefined {
  const words = nameWords(name).slice(0, 3);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (i > 1 && LEADING_ONLY.has(w)) continue;
    const c = verbClass(w);
    if (c) return c;
  }
  return undefined;
}

/** A description's lead words with filler ("This tool…", "Use this to…") removed. */
const LEAD_FILLER =
  /^(?:this (?:tool|function|endpoint|method) (?:will |can |is used to |lets you |allows you to )?|use (?:this|it|the tool)(?: tool)? to |(?:a |the )?(?:tool|function|endpoint) (?:that |to |for |which )|(?:allows|lets|enables) (?:you|the (?:agent|assistant|model)) to |used to |helps? (?:you )?(?:to )?)/i;

/** The class of a description's leading verb (inflected forms count: "Searches", "Gets"). */
function leadVerb(description: string): VerbClass | undefined {
  let text = description.trim();
  for (let i = 0; i < 3; i++) {
    const next = text.replace(LEAD_FILLER, "");
    if (next === text) break;
    text = next;
  }
  const first = /^[A-Za-z]+/.exec(text)?.[0]?.toLowerCase();
  if (!first) return undefined;
  // "Returns the…" describes output; the imperative "Return an item" is a write.
  if (first === "returns") return "read";
  for (const stem of [
    first,
    first.replace(/s$/, ""),
    first.replace(/es$/, ""),
    first.replace(/ies$/, "y"),
  ]) {
    const c = verbClass(stem);
    if (c) return c;
  }
  return undefined;
}

function count(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0;
}

function descriptionOf(d: ToolDecl | undefined): string {
  const raw = d?.function?.description ?? d?.description;
  // Code spans name other tools (`call_x`), not this tool's effect.
  return typeof raw === "string" ? raw.replace(/`[^`]*`/g, " ") : "";
}

function hintsOf(d: ToolDecl | undefined): Hints | undefined {
  return d?.annotations ?? d?.function?.annotations;
}

/** True when the tool's only (non-tuning) parameter is a free-text search. */
function searchShaped(d: ToolDecl | undefined): boolean {
  const props = declaredProperties(d);
  if (!props) return false;
  const keys = Object.keys(props).filter((k) => !TUNING_PARAM.test(k));
  return keys.length === 1 && SEARCH_PARAM.test(keys[0]!);
}

/**
 * Classify the tool `name` (see the module doc). `tools` is the declared tool
 * list in any common shape; without a declaration only the name is read.
 */
export function toolEffect(
  name: string,
  tools?: readonly unknown[],
  role: ToolEffectRole = "guard",
): ToolEffect {
  const decl = declOf(name, tools);
  const hints = hintsOf(decl);
  if (hints?.readOnlyHint === true) return { readOnly: true, basis: "declared" };
  if (hints?.readOnlyHint === false || hints?.destructiveHint === true)
    return { readOnly: false, basis: "declared" };

  const byName = nameVerb(name);
  const description = descriptionOf(decl);
  const byLead = description ? leadVerb(description) : undefined;
  if (byName === "write") return { readOnly: false, basis: "name" };
  if (byLead === "write") return { readOnly: false, basis: "description" };
  if (byName === "read") return { readOnly: true, basis: "name" };

  const writes = count(WRITE_WORDS, description);
  const ownsUserState = USER_STATE_WORDS.test(description);
  // "Look up and unlock the user's card": an ambiguous name acting on user state stays a write.
  if (byLead === "read" && writes === 0 && !(byName === "ambiguous" && ownsUserState))
    return { readOnly: true, basis: "description" };
  if (
    (byName === "ambiguous" || byLead === "ambiguous") &&
    writes === 0 &&
    ACCESS_WORDS.test(description) &&
    !ownsUserState
  ) {
    return { readOnly: true, basis: "access" };
  }
  if (role === "track") {
    const reads = count(READ_WORDS, description);
    if (reads > writes || (reads === 0 && writes === 0 && searchShaped(decl)))
      return { readOnly: true, basis: "weak" };
  }
  return { readOnly: false, basis: "default" };
}

/** {@link toolEffect}'s verdict alone. */
export function isReadOnlyTool(
  name: string,
  tools?: readonly unknown[],
  role: ToolEffectRole = "guard",
): boolean {
  return toolEffect(name, tools, role).readOnly;
}

/**
 * Read-only by name alone (no declaration): a surface that has only names (an
 * agent loop's own tools, a dispatched inner tool) gets the same verdict in
 * both roles, since the weak rules need a declaration.
 */
export function readOnlyByName(name: string): boolean {
  return toolEffect(name).readOnly;
}
