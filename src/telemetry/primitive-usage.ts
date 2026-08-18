// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

export interface PrimitiveClassification {
  primitive: string;
  action: string;
  meaningful: boolean;
  worldAction: boolean;
  communication: boolean;
  safeLabel: string;
}

const READ_ACTIONS = new Set([
  "",
  "list",
  "listall",
  "info",
  "status",
  "show",
  "read",
  "history",
  "search",
  "recall",
  "trace",
  "graph",
  "types",
  "help",
  "who",
  "mine",
  "available",
  "completed",
  "leaderboard",
  "trend",
]);

const PRIMITIVES: Record<string, string> = {
  look: "awareness",
  examine: "awareness",
  who: "awareness",
  map: "awareness",
  brief: "awareness",
  orient: "memory",
  recall: "memory",
  memory: "memory",
  note: "memory",
  reflect: "memory",
  pool: "memory",
  skill: "memory",
  task: "coordination",
  project: "coordination",
  group: "coordination",
  crew: "coordination",
  recruit: "coordination",
  conduct: "coordination",
  tell: "communication",
  re: "communication",
  say: "communication",
  shout: "communication",
  emote: "communication",
  channel: "communication",
  board: "communication",
  build: "creation",
  canvas: "creation",
  code: "creation",
  media: "creation",
  web: "research",
  probe: "research",
  watch: "research",
  market: "markets",
  position: "markets",
  ops: "operations",
  readiness: "operations",
  agent: "operations",
  admin: "operations",
  key: "operations",
  productivity: "operations",
  go: "navigation",
  goto: "navigation",
  north: "navigation",
  south: "navigation",
  east: "navigation",
  west: "navigation",
  n: "navigation",
  s: "navigation",
  e: "navigation",
  w: "navigation",
};

const ALWAYS_MEANINGFUL = new Set([
  "tell",
  "re",
  "say",
  "shout",
  "emote",
  "go",
  "goto",
  "north",
  "south",
  "east",
  "west",
  "n",
  "s",
  "e",
  "w",
]);

const INFORMATIONAL_VERBS = new Set([
  "look",
  "examine",
  "who",
  "map",
  "brief",
  "orient",
  "recall",
  "help",
  "feed",
  "readiness",
  "productivity",
]);

// Only these command families have a public, non-content subcommand in token 2.
// All other arguments may be names, messages, prompts, paths, or memory content
// and must never enter telemetry.
const STRUCTURED_ACTION_VERBS = new Set([
  "agent",
  "admin",
  "board",
  "canvas",
  "channel",
  "conduct",
  "crew",
  "group",
  "key",
  "market",
  "media",
  "memory",
  "ops",
  "pool",
  "position",
  "productivity",
  "project",
  "skill",
  "task",
  "watch",
  "web",
]);

const CONTENT_COMMAND_ACTIONS: Record<string, ReadonlySet<string>> = {
  note: new Set([
    "list",
    "search",
    "space",
    "delete",
    "link",
    "trace",
    "graph",
    "correct",
    "types",
    "evolve",
    "conflicts",
    "resolve",
  ]),
  code: new Set(["enter", "exit", "help", "show", "save", "validate", "history"]),
};

const SAFE_STRUCTURED_ACTIONS = new Set([
  ...READ_ACTIONS,
  "create",
  "add",
  "update",
  "delete",
  "remove",
  "join",
  "leave",
  "post",
  "reply",
  "vote",
  "claim",
  "submit",
  "approve",
  "reject",
  "release",
  "start",
  "stop",
  "spawn",
  "config",
  "set",
  "get",
  "open",
  "close",
  "run",
  "call",
  "connect",
  "disconnect",
  "resolve",
  "archive",
  "pin",
  "unpin",
  "share",
  "invite",
  "kick",
  "assign",
  "publish",
  "edit",
  "validate",
  "enter",
  "exit",
  "auth",
  "tools",
  "buy",
  "sell",
  "cancel",
  "record",
  "reset",
  "send",
]);

export function classifyPrimitive(raw: string, canonicalVerb?: string): PrimitiveClassification {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const verb = (canonicalVerb ?? tokens[0] ?? "unknown").toLowerCase();
  const candidateAction = (tokens[1] ?? "").toLowerCase();
  const contentActions = CONTENT_COMMAND_ACTIONS[verb];
  const action = STRUCTURED_ACTION_VERBS.has(verb)
    ? SAFE_STRUCTURED_ACTIONS.has(candidateAction)
      ? candidateAction
      : verb
    : contentActions?.has(candidateAction)
      ? candidateAction
      : verb;
  const primitive = PRIMITIVES[verb] ?? "other";
  const communication = primitive === "communication";
  const meaningful =
    ALWAYS_MEANINGFUL.has(verb) ||
    verb === "web" ||
    verb === "probe" ||
    (!INFORMATIONAL_VERBS.has(verb) && primitive !== "operations" && !READ_ACTIONS.has(action));
  return {
    primitive,
    action,
    meaningful,
    worldAction: meaningful && primitive !== "research",
    communication,
    safeLabel: action === verb ? verb : `${verb} ${action}`,
  };
}

export function isMarinaTool(toolName: string): boolean {
  return toolName.startsWith("marina_");
}
