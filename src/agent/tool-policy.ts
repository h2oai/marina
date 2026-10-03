// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tool-call risk, ordered: `read` < `self` < `communicate` < `egress` <
 * `mutate` < `consequential`. The decision gate scores only `egress`,
 * `mutate` and `consequential` calls; everything else runs without a gate call.
 *
 * - `read` — observes the world, memory or a workspace and changes nothing.
 * - `self` — changes only the caller's OWN loop instruments (`memory set
 *   pace|rest|channel_sends|focus_persistent|autonomy …`, `memory delete
 *   rest`): nobody else can see or be affected by them.
 * - `communicate` — a message.
 * - `egress` — an outbound read (`web search|fetch|read|multisearch`,
 *   `data markets|odds|series`). It
 *   changes nothing in the world, and the URL guard (`src/net/url-guard.ts`)
 *   already fences WHERE it can go. It leaves the process with arguments the
 *   agent chose, so it is still gated. But reaching an external system is what
 *   egress is, so the gate does not count `outsideScope` on it (see
 *   `decideGate`).
 * - `mutate` — anything else, and anything unknown or ambiguous (fails closed).
 * - `consequential` — changes authority, identity, federation or destroys.
 *
 * `marina_command` / `marina_batch` (and the typed wrappers that build one
 * command string) are classified by verb and subcommand from an explicit
 * allowlist. Commands declare `effect` on their usage forms only sparsely, and
 * the agent side has no router to ask; `test/tool-policy.test.ts` checks that
 * no form a command declares `write` / `delete` / `execute` is classified as a
 * read here, so the list can only err towards the gate.
 */
export type ToolRisk = "read" | "self" | "communicate" | "egress" | "mutate" | "consequential";

/** The risk classes the decision gate scores. */
export type GatedRisk = "egress" | "mutate" | "consequential";

const RISK_ORDER: readonly ToolRisk[] = [
  "read",
  "self",
  "communicate",
  "egress",
  "mutate",
  "consequential",
];

export function isGatedRisk(risk: ToolRisk): risk is GatedRisk {
  return risk === "egress" || risk === "mutate" || risk === "consequential";
}

function worstRisk(risks: readonly ToolRisk[]): ToolRisk {
  let worst: ToolRisk = "read";
  for (const r of risks) if (RISK_ORDER.indexOf(r) > RISK_ORDER.indexOf(worst)) worst = r;
  return worst;
}

const CONSEQUENTIAL_COMMAND =
  /^(admin|rank|grant|ban|kick|destroy|connect\s+(add|auth|remove)|gateway\s+(add|remove|bridge)|build\s+(destroy|unlink)|code\s+(approve|deny|revert)|agent\s+(stop|key|reconfigure|config)|role\s+(edit|delete|reload)|trait\s+delete)\b/i;
const COMMUNICATION_COMMAND = /^(say|tell|shout|emote|channel\s+send|board\s+(post|reply))\b/i;
const POLICY_MANIPULATION =
  /\b(ignore|bypass|disable|override|evade|remove)\b.{0,40}\b(safety|gate|policy|permission|system prompt|governing contract)\b/i;
/** Trust sources whose content is not first-party: web/search/probe results and
 *  federated relays. `world_event` and `memory` are first-party evidence. */
const UNTRUSTED_TRUST_SOURCES: ReadonlySet<string> = new Set(["external_tool", "untrusted_relay"]);
/** Advisory label for policy language that is NOT blocked. Surfaced, never enforced. */
export const POLICY_LANGUAGE_LABEL = "[policy-language noted]";

/**
 * Typed tools that only observe. `marina_web` is deliberately absent: a fetch
 * leaves the process with arguments the agent chose, so it is `egress`, which
 * is still gated.
 * Every name here is also in `READ_ONLY_TOOL_NAMES` (tools/profiles.ts).
 */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "think",
  "marina_look",
  "marina_recall",
  "marina_examine",
  "marina_inventory",
  "marina_who",
  "marina_help",
  "marina_brief",
  "marina_feed",
  "marina_novelty",
  "marina_code_read_file",
  "marina_code_list_files",
  "marina_code_search",
  "marina_code_diff",
  "marina_code_history",
  "marina_code_summary",
  "marina_code_session_status",
  "marina_code_observe",
  "marina_code_artifacts",
  "marina_code_doctor",
  "marina_code_thread",
]);

/** Memory-service operations that only read (records, sources, spaces, jobs). */
const READ_MEMORY_OPERATIONS: ReadonlySet<string> = new Set([
  "capabilities",
  "usage",
  "me",
  "spaces",
  "space",
  "get",
  "search",
  "context",
  "retrieve",
  "sources",
  "source_headers",
  "source_search",
  "source_range",
  "vocabulary",
  "graph",
  "federation_mounts",
  "federated_search",
  "federated_read",
  "cache_get",
  "checkpoint",
  "assist_jobs",
  "assist_get",
  "transfers",
  "transfer_status",
  "job",
]);

/** Platform `memory` tool actions that only read. */
const READ_MEMORY_TOOL_ACTIONS: ReadonlySet<string> = new Set(["search", "orient", "skill_search"]);

/** Core-memory keys that tune only the caller's own loop (see loop-preferences.ts). */
const SELF_LOOP_KEYS: ReadonlySet<string> = new Set([
  "pace",
  "rest",
  "channel_sends",
  "focus_persistent",
  "autonomy",
]);

/** `web` subcommands that only read from outside (all go through the URL guard). */
/** `data` subcommands that read a third-party source (src/engine/commands/data.ts). */
const EGRESS_DATA_SUBCOMMANDS: ReadonlySet<string> = new Set(["markets", "odds", "series"]);

const EGRESS_WEB_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "search",
  "fetch",
  "read",
  "multisearch",
]);

/** A key as the agent meant it: `rest;` and `rest,` are `rest`. */
const normalizeKey = (key: string) => key.replace(/[;,.:!?]+$/, "").toLowerCase();

/** Commands whose every form only reads. Aliases included. */
const READ_VERBS: ReadonlySet<string> = new Set([
  "look",
  "l",
  "examine",
  "ex",
  "x",
  "who",
  "inventory",
  "i",
  "inv",
  "help",
  "?",
  "commands",
  "calc",
  "time",
  "date",
  "uptime",
  "score",
  "stats",
  "map",
  "ls",
  "list",
  "dir",
  "recall",
  "search",
  "context",
  "orient",
  "status",
  "briefing",
  "next",
  "guide",
  "feed",
  "standing",
  "readiness",
  "doctor",
  "health",
  "productivity",
  "impact",
]);

const has = (set: readonly string[], word: string | undefined) => !!word && set.includes(word);

/** Read-only subcommands per command (by canonical name and alias). */
const READ_SUBCOMMANDS: Record<string, (words: string[]) => boolean> = {
  // `pool list`, `pool <name> recall|status|list|audit …`
  pool: ([a, b]) =>
    a === "list" || (!!a && a !== "create" && has(["recall", "status", "list", "audit"], b)),
  // Default is `list`; `history` falls through to the usage reply.
  board: ([a]) => !a || has(["list", "read", "search", "scores", "history"], a),
  challenge: ([a]) => !a || has(["list", "stats"], a),
  channel: ([a]) => has(["list", "listall", "history"], a),
  task: ([a]) => has(["list", "info", "children"], a),
  // `project list|info …`, `project <name> status|tasks`
  project: ([a, b]) =>
    has(["list", "info"], a) ||
    (!!a && a !== "create" && b !== undefined && has(["status", "tasks"], b)),
  crew: ([a]) => has(["info", "invitations"], a),
  note: ([a]) => has(["list", "search", "graph", "types", "contradictions", "explain", "trace"], a),
  chronicle: ([a]) => !a || has(["about", "kinds", "show", "since"], a),
  skill: ([a]) => has(["list", "search", "audit"], a),
  trace: ([a]) =>
    !a ||
    /^\d+$/.test(a) ||
    has(["list", "show", "stats", "find", "judgments", "compare", "advise"], a),
  market: ([a]) => has(["list", "show", "search", "leaderboard", "score"], a),
  gate: ([a]) => a === "list",
  canvas: ([a, b]) =>
    has(["list", "info", "nodes", "edges"], a) ||
    (a === "asset" && has(["list", "info"], b)) ||
    (a === "intent" && b === "list"),
  macro: ([a]) => a === "list",
  brief: ([a]) => !a || has(["full", "social"], a),
  // Forms declared `effect: "read"` in evolve's usage.
  evolve: ([a]) => !a || has(["loop", "adoption", "sessions", "qualify", "status", "analyze"], a),
};
const SUBCOMMAND_ALIASES: Record<string, string> = {
  challenges: "challenge",
  ch: "channel",
  proj: "project",
  traces: "trace",
  mk: "market",
  gates: "gate",
  cv: "canvas",
  coach: "evolve",
};

/** Durable memory-service verbs that only read (`memory retrieve <q>`, `memory show <id>` …). */
const READ_MEMORY_VERBS = [
  "retrieve",
  "query",
  "show",
  "view",
  "info",
  "guide",
  "usage",
  "sources",
  "source",
  "vocabulary",
  "graph",
];

function classifyMemoryCommand(words: string[]): ToolRisk {
  const kv = words[0] === "kv";
  const [verb, key, ...rest] = kv ? words.slice(1) : words;
  if (!verb) return "read"; // bare `memory` / `memory kv` lists
  if (has(["list", "ls", "get", "history"], verb)) return "read";
  if (!kv && has(READ_MEMORY_VERBS, verb)) return "read";
  const loopKey = !!key && SELF_LOOP_KEYS.has(normalizeKey(key));
  if (verb === "set" && loopKey && rest.length > 0) return "self";
  // The router deletes only the first token after the verb (`keyOf` in
  // commands/memory.ts) and ignores the rest, so trailing text never runs.
  // A plain command is not split on `;` (only `batch` and macros split), so
  // `memory delete rest; project hab join` deletes the caller's own key and
  // nothing else.
  if (has(["delete", "rm", "remove"], verb) && loopKey) return "self";
  return "mutate";
}

/**
 * The commands a raw command string runs, split as the router splits it:
 * `batch` (like a macro) splits its body on `;`. Every other command is ONE
 * command whatever it contains: `calc 1; 2` and `memory set rest a; b` reach
 * their handlers whole.
 */
export function commandParts(raw: string): string[] {
  const command = raw.trim();
  const match = /^batch(?:\s+|$)/i.exec(command);
  if (!match) return command ? [command] : [];
  return command
    .slice(match[0].length)
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Risk of ONE raw world command (the whole string is one command; only `batch` splits). */
export function classifyCommandRisk(raw: string): ToolRisk {
  const command = raw.trim();
  if (!command) return "mutate";
  if (/^batch(\s|$)/i.test(command)) {
    const parts = commandParts(command);
    return parts.length ? worstRisk(parts.map(classifyCommandRisk)) : "mutate";
  }
  if (CONSEQUENTIAL_COMMAND.test(command)) return "consequential";
  const words = command.split(/\s+/);
  const verb = words[0]!.toLowerCase();
  const tail = words.slice(1);
  if (READ_VERBS.has(verb)) return "read";
  if (verb === "web") {
    return EGRESS_WEB_SUBCOMMANDS.has(tail[0]?.toLowerCase() ?? "") ? "egress" : "mutate";
  }
  if (verb === "data") {
    // `data markets|odds|series` reads a third-party source with the agent's
    // arguments (egress, like `web search`); bare `data` / `data sources` /
    // `data help` only print local text.
    const sub = tail[0]?.toLowerCase() ?? "";
    if (sub === "" || sub === "sources" || sub === "help") return "read";
    return EGRESS_DATA_SUBCOMMANDS.has(sub) ? "egress" : "mutate";
  }
  if (verb === "memory") return classifyMemoryCommand(tail);
  const readSub = READ_SUBCOMMANDS[SUBCOMMAND_ALIASES[verb] ?? verb];
  if (readSub?.(tail.slice(0, 2).map((w) => w.toLowerCase()))) return "read";
  if (COMMUNICATION_COMMAND.test(command)) return "communicate";
  return "mutate";
}

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const withArgs = (head: string, args: unknown) => (str(args) ? `${head} ${str(args)}` : head);

/**
 * The world command a typed wrapper tool sends (mirrors the builders in
 * tools/world.ts — `test/tool-policy.test.ts` pins them together), or
 * undefined for tools that are not a command wrapper.
 */
export function typedToolCommand(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  const action = str(args.action);
  switch (toolName) {
    case "marina_command":
      return str(args.command);
    case "marina_batch":
      return `batch ${str(args.commands)}`;
    case "marina_web": {
      const url = str(args.url);
      const query = str(args.query);
      if (action === "fetch" && url) return `web fetch ${url}`;
      if (action === "search" && query) return `web search ${query}`;
      return `web ${action}${query ? ` ${query}` : ""}${url ? ` ${url}` : ""}`;
    }
    case "marina_board":
    case "marina_task":
    case "marina_project":
    case "marina_canvas":
    case "marina_macro":
      return withArgs(`${toolName.slice("marina_".length)} ${action}`, args.args);
    case "marina_market":
      return withArgs(action === "position" ? "position" : `market ${action}`, args.args);
    case "marina_pool": {
      const pool = str(args.pool);
      const content = str(args.content);
      if (action === "list") return "pool list";
      if (!pool) return `pool ${action}`;
      if (action === "create") return `pool create ${pool}`;
      return `pool ${pool} ${action}${content ? ` ${content}` : ""}`;
    }
    case "marina_focus":
    case "marina_goal": {
      const key = toolName === "marina_focus" ? "focus" : "goal";
      // set / clear / progress change the focus or goal; everything else shows it.
      if (action === "set" || action === "clear" || action === "progress") return undefined;
      return `memory get ${key}`;
    }
    default:
      return undefined;
  }
}

export function classifyToolRisk(toolName: string, args: Record<string, unknown>): ToolRisk {
  if (READ_TOOL_NAMES.has(toolName)) return "read";
  if (toolName === "marina_tell" || toolName === "marina_say" || toolName === "marina_channel") {
    return "communicate";
  }
  if (toolName === "marina_memory_service") {
    return READ_MEMORY_OPERATIONS.has(str(args.operation)) ? "read" : "mutate";
  }
  if (toolName === "memory") {
    return READ_MEMORY_TOOL_ACTIONS.has(str(args.action)) ? "read" : "mutate";
  }
  const command = typedToolCommand(toolName, args);
  if (command !== undefined) return classifyCommandRisk(command);
  return "mutate";
}

/**
 * The arguments the decision gate scores. A batch is narrowed to the parts the
 * gate scores on their own (`egress` / `mutate` / `consequential`): a self
 * part like `memory delete rest` or a read in the same batch is not judged.
 * The risk class stays the worst over every part (`classifyToolRisk`), and the
 * held call, if any, still replays the whole batch. Every other call is
 * scored as it is.
 */
export function gateScopedArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const command = toolName === "marina_batch" || toolName === "marina_command";
  const sent = command ? typedToolCommand(toolName, args) : undefined;
  if (!sent || !/^batch(\s|$)/i.test(sent)) return args;
  const parts = commandParts(sent);
  const scored = parts.filter((part) => isGatedRisk(classifyCommandRisk(part)));
  if (scored.length === 0 || scored.length === parts.length) return args;
  const body = scored.join("; ");
  return toolName === "marina_batch"
    ? { ...args, commands: body }
    : { ...args, command: `batch ${body}` };
}

/**
 * An additive deposit into a shared pool or a crew's artifact slot: the way a
 * crew member delivers its dispatched task. It appends (never overwrites),
 * is attributed and retractable, and group-backed pools are members-only at
 * the data layer. The gate still scores it on `destructive` / `irreversible` /
 * `outsideScope`, but the authorization-context question is not asked: a
 * member delivering into its own crew's pool is the task, not a detour.
 */
export function isAdditiveDeposit(toolName: string, args: Record<string, unknown>): boolean {
  const command = typedToolCommand(toolName, args);
  if (!command) return false;
  const words = command.trim().split(/\s+/);
  const verb = words[0]?.toLowerCase();
  if (verb === "pool") {
    return words.length > 3 && words[1] !== "create" && words[2]?.toLowerCase() === "add";
  }
  return verb === "crew" && words[1]?.toLowerCase() === "artifact" && words.length > 3;
}

/**
 * Deterministic reference monitor. Policy language ("bypass the gate", "ignore
 * the policy") is BLOCKED only where it is dangerous: a consequential call made
 * while untrusted content (external tool results, federated relays) fed this
 * cycle. Everywhere else — a note arguing to relax a gate, a message about
 * policy, a mutation informed by first-party world events or memory — the call
 * runs and carries an advisory `label` the caller may surface. Gates themselves
 * are enforced by the router, not by this text check.
 */
export function mediateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  trustSources: readonly string[],
): { risk: ToolRisk; block?: string; label?: string } {
  const risk = classifyToolRisk(toolName, args);
  const serialized = Object.values(args)
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const policyLanguage = POLICY_MANIPULATION.test(serialized);
  // The two text rules below keep their scope: a single consequential command.
  // A batch's consequential parts are still gated by the router one by one
  // (and scored as consequential by the decision gate when it is on).
  const batch = /^batch\b/i.test(typedToolCommand(toolName, args) ?? "");
  const single = risk === "consequential" && !batch;
  if (
    policyLanguage &&
    single &&
    trustSources.some((source) => UNTRUSTED_TRUST_SOURCES.has(source))
  ) {
    return {
      risk,
      block:
        "Blocked by Marina's reference monitor: a consequential call made while untrusted content is in context cannot request bypassing safety, permissions, or the governing contract.",
    };
  }
  if (
    toolName === "marina_command" &&
    single &&
    /[;\n]/.test(typeof args.command === "string" ? args.command : "")
  ) {
    return {
      risk,
      block:
        "Consequential raw commands must be issued one operation at a time so Marina can mediate and audit each gate.",
    };
  }
  return policyLanguage ? { risk, label: POLICY_LANGUAGE_LABEL } : { risk };
}
